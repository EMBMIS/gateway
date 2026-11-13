'use strict';
/**
 * Worker thread that owns the PostgreSQL connection for src/db-pg-sync.js.
 * It receives {id, sql, params} on a MessagePort, runs the query, posts the result back and wakes the
 * main thread (which is blocked in Atomics.wait). One connection, so BEGIN/COMMIT sent by the main thread
 * bracket the statements in between.
 */
const { parentPort, workerData } = require('worker_threads');
const { Client, types } = require('pg');

// SQLite hands back JS numbers for counts and sums; keep that.
types.setTypeParser(20, (v) => Number(v));       // bigint
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

const { url, schema, signal, port } = workerData;
const flag = new Int32Array(signal);
const client = new Client({ connectionString: url, application_name: 'embmis-gateway' });

const ready = (async () => {
    await client.connect();
    if (schema) {
        // CREATE SCHEMA IF NOT EXISTS still needs CREATE on the database, which the least-privilege role does not have:
        // only try when the schema is really missing (an administrator creates it in production; DEPLOY.md).
        const have = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
        if (!have.rowCount) await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
    }
})();

function wake(state) {
    Atomics.store(flag, 0, state);
    Atomics.notify(flag, 0);
}

parentPort.on('message', async (msg) => {
    try {
        await ready;
        const res = await client.query({ text: msg.sql, values: msg.params });
        port.postMessage({ ok: true, rows: res.rows, rowCount: res.rowCount });
    } catch (err) {
        port.postMessage({ ok: false, error: { message: err.message, code: err.code, detail: err.detail } });
    }
    wake(1);
});
