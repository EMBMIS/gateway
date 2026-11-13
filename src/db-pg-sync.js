'use strict';
/**
 * A better-sqlite3-shaped database handle backed by PostgreSQL.
 *
 * The gateway's pipeline is written against better-sqlite3's synchronous API (db.prepare(sql).get/all/run,
 * db.exec, db.transaction). To store its data in PostgreSQL without rewriting every call site,
 * this module keeps that API: queries run on a worker thread that owns the connection, and the calling thread
 * blocks (Atomics.wait) until the answer arrives. A query costs one round trip of blocked event loop, so keep the
 * database close (same host or network); the audit chain needs strictly ordered writes anyway.
 *
 * The SQL the gateway writes is SQLite dialect. toPg() translates the small set of constructs it uses:
 *   ?  -> $n            datetime('now'[,'utc']) / datetime(?, '-5 minutes') -> text timestamps in the same format
 *   INSERT OR IGNORE -> ON CONFLICT DO NOTHING          INSERT OR REPLACE -> ON CONFLICT (pk) DO UPDATE
 *   LIKE -> ILIKE       INTEGER -> BIGINT, REAL -> DOUBLE PRECISION, ADD COLUMN -> ADD COLUMN IF NOT EXISTS
 * Timestamps stay TEXT 'YYYY-MM-DD HH24:MI:SS' (UTC) exactly as under SQLite, so comparisons behave the same.
 */
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const NOW = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')`;
const REPLACE_KEYS = { role_permissions: ['role', 'tool_name'] };

/** Split a script into statements on ';' outside quotes and comments. */
function splitStatements(script) {
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < script.length; i++) {
        const c = script[i];
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
        } else if (c === '-' && script[i + 1] === '-') {
            while (i < script.length && script[i] !== '\n') i++;
            cur += '\n';
        } else if (c === "'" || c === '"') {
            quote = c;
            cur += c;
        } else if (c === ';') {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
        } else {
            cur += c;
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** Apply `fn` to the parts of `sql` outside single-quoted literals. */
function outsideLiterals(sql, fn) {
    return sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

function translate(sqlIn) {
    let sql = sqlIn.trim().replace(/;+\s*$/, '');

    // datetime('now', 'utc') and datetime('now') contain a literal, so rewrite them before literal-aware passes.
    sql = sql.replace(/datetime\(\s*'now'\s*(?:,\s*'utc'\s*)?\)/gi, NOW);
    sql = sql.replace(/datetime\(\s*'now'\s*,\s*'([+-]?\d+)\s+(second|minute|hour|day)s?'\s*\)/gi,
        (_m, n, unit) => `to_char(((now() at time zone 'utc') + interval '${n} ${unit}'), 'YYYY-MM-DD HH24:MI:SS')`);
    sql = sql.replace(/datetime\(\s*\?\s*,\s*'([+-]?\d+)\s+(second|minute|hour|day)s?'\s*\)/gi,
        (_m, n, unit) => `to_char((?::timestamp + interval '${n} ${unit}'), 'YYYY-MM-DD HH24:MI:SS')`);

    let orIgnore = false;
    let replaceTable = null;
    sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, () => { orIgnore = true; return 'INSERT INTO'; });
    sql = sql.replace(/^INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)/i, (_m, t) => { replaceTable = t; return `INSERT INTO ${t}`; });

    sql = outsideLiterals(sql, (part) => part
        .replace(/\bLIKE\b/gi, 'ILIKE')
        .replace(/\bINTEGER\b/gi, 'BIGINT')
        .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
        .replace(/\bBLOB\b/gi, 'BYTEA')
        .replace(/^(\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN)\s+(?!IF\s+NOT\s+EXISTS)/i, '$1 IF NOT EXISTS '));

    if (orIgnore) sql += ' ON CONFLICT DO NOTHING';
    if (replaceTable) {
        const keys = REPLACE_KEYS[replaceTable];
        if (!keys) throw new Error(`INSERT OR REPLACE into ${replaceTable}: no conflict key registered in db-pg-sync.js`);
        const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)[1].split(',').map((c) => c.trim());
        const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
        sql += ` ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${sets}`;
    }

    // ? -> $n, outside literals.
    let n = 0;
    sql = outsideLiterals(sql, (part) => part.replace(/\?/g, () => `$${++n}`));
    return { sql, ignore: orIgnore };
}

const toPg = (sqlIn) => translate(sqlIn).sql;

class PgSyncDb {
    constructor({ url, schema, skipDdl = false }) {
        this.skipDdl = skipDdl;
        this.signal = new SharedArrayBuffer(4);
        this.flag = new Int32Array(this.signal);
        const { port1, port2 } = new MessageChannel();
        this.port = port1;
        this.worker = new Worker(path.join(__dirname, 'db-pg-worker.js'), {
            workerData: { url, schema, signal: this.signal, port: port2 },
            transferList: [port2],
        });
        this.worker.unref();
        this.inTransaction = false;
    }

    _query(sql, params = []) {
        Atomics.store(this.flag, 0, 0);
        this.worker.postMessage({ sql, params: params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) });
        // 30 s ceiling: a hung database must not hang the gateway forever.
        const waited = Atomics.wait(this.flag, 0, 0, 30000);
        if (waited === 'timed-out') throw new Error('PostgreSQL did not answer within 30 s');
        const msg = receiveMessageOnPort(this.port);
        if (!msg) throw new Error('PostgreSQL worker returned no result');
        const r = msg.message;
        if (!r.ok) {
            const e = new Error(r.error.message);
            e.code = r.error.code;
            e.detail = r.error.detail;
            e.sql = sql;
            throw e;
        }
        return r;
    }

    /**
     * SQLite's INSERT OR IGNORE also skips rows that violate NOT NULL and CHECK constraints, not only duplicates.
     * ON CONFLICT DO NOTHING covers duplicates; this covers the rest (inside a savepoint when a transaction is open).
     */
    _runIgnoring(sql, params) {
        const SKIPPABLE = ['23502', '23514', '23505'];
        try {
            if (this.inTransaction) this._query('SAVEPOINT sag_ignore');
            const r = this._query(sql, params);
            if (this.inTransaction) this._query('RELEASE SAVEPOINT sag_ignore');
            return r;
        } catch (err) {
            if (this.inTransaction) { try { this._query('ROLLBACK TO SAVEPOINT sag_ignore'); } catch { /* ignore */ } }
            if (SKIPPABLE.includes(err.code)) return { rows: [], rowCount: 0 };
            throw err;
        }
    }

    /**
     * With skipDdl the gateway never runs CREATE/ALTER itself (its role has no right to: a database's DDL audit
     * triggers need access the role does not have). The schema is applied by an administrator instead:
     * an administrator, from `node scripts/print-pg-schema.js` (DEPLOY.md).
     */
    _isSkippedDdl(sql) { return this.skipDdl && /^\s*(CREATE|ALTER|DROP)\b/i.test(sql); }

    prepare(sqlite) {
        const { sql, ignore: ignoring } = translate(sqlite);
        if (this._isSkippedDdl(sql)) return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
        const flatten = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
        return {
            run: (...args) => { const r = ignoring ? this._runIgnoring(sql, flatten(args)) : this._query(sql, flatten(args)); return { changes: r.rowCount || 0 }; },
            get: (...args) => this._query(sql, flatten(args)).rows[0],
            all: (...args) => this._query(sql, flatten(args)).rows,
        };
    }

    exec(script) {
        for (const stmt of splitStatements(script)) {
            const { sql, ignore } = translate(stmt);
            if (this._isSkippedDdl(sql)) continue;
            if (ignore) this._runIgnoring(sql, []); else this._query(sql);
        }
    }

    /** SQLite pragmas (WAL, foreign_keys, checkpoint) have no meaning here. */
    pragma() { return []; }

    transaction(fn) {
        return (...args) => {
            if (this.inTransaction) return fn(...args);
            this._query('BEGIN');
            this.inTransaction = true;
            try {
                const result = fn(...args);
                this._query('COMMIT');
                return result;
            } catch (err) {
                try { this._query('ROLLBACK'); } catch { /* connection already gone */ }
                throw err;
            } finally {
                this.inTransaction = false;
            }
        };
    }

    close() { this.worker.terminate(); }
}

module.exports = { PgSyncDb, toPg, translate, splitStatements };
