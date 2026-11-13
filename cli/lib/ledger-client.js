/**
 * SAG CLI — Ledger Client Abstraction
 * 
 * Provides read-only access to the audit ledger.
 * In containerized mode, copies the Gateway's SQLite DB via docker cp
 * to get a consistent snapshot. Designed for future replacement
 * with a REST Admin API without CLI UX changes.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const SNAPSHOT_PATH = path.join(config.projectRoot, '.ledger-snapshot.db');
let db = null;

/**
 * Attempt to pull a fresh DB snapshot from the Gateway container.
 * Falls back to local dwi.db if docker is unavailable.
 */
function syncFromContainer() {
    try {
        // Checkpoint WAL so all data is in the main .db file
        execSync('docker exec dwi-gateway node -e "require(\'better-sqlite3\')(\'dwi.db\').pragma(\'wal_checkpoint(TRUNCATE)\')"', {
            stdio: 'pipe', timeout: 5000
        });
        execSync(`docker cp dwi-gateway:/usr/src/app/dwi.db "${SNAPSHOT_PATH}"`, {
            stdio: 'pipe', timeout: 5000
        });
        return SNAPSHOT_PATH;
    } catch (err) {
        // Docker unavailable — fall back to local
        if (fs.existsSync(config.dbPath)) return config.dbPath;
        return null;
    }
}

function getDb() {
    if (!db) {
        const dbPath = syncFromContainer();
        if (!dbPath) {
            throw new Error('No audit ledger available. Is the Gateway running?');
        }
        db = new Database(dbPath, { readonly: true });
    }
    return db;
}

/**
 * Retrieve a single audit entry by trace_id.
 * Uses parameterized queries exclusively — no dynamic SQL.
 */
function getTraceEntry(traceId) {
    const row = getDb().prepare(
        'SELECT * FROM audit_log WHERE trace_id = ? ORDER BY seq DESC LIMIT 1'
    ).get(traceId);
    return row || null;
}

/**
 * Retrieve the most recent N audit entries.
 */
function getRecentEntries(limit = 10) {
    return getDb().prepare(
        'SELECT seq, trace_id, timestamp, agent_name, tool, action, policy_decision, risk_score, latency_ms FROM audit_log ORDER BY seq DESC LIMIT ?'
    ).all(limit);
}

/**
 * Get aggregate stats from the ledger.
 */
function getStats() {
    const d = getDb();
    const total = d.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
    const allowed = d.prepare("SELECT COUNT(*) as c FROM audit_log WHERE policy_decision = 'allow'").get().c;
    const denied = d.prepare("SELECT COUNT(*) as c FROM audit_log WHERE policy_decision = 'deny'").get().c;
    return { total, allowed, denied };
}

function close() {
    if (db) { db.close(); db = null; }
    // Clean up snapshot
    try { fs.unlinkSync(SNAPSHOT_PATH); } catch { }
}

module.exports = { getTraceEntry, getRecentEntries, getStats, close };
