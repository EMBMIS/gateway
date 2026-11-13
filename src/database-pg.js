'use strict';

const { Pool } = require('pg');
const crypto   = require('crypto');

let pool;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            host:     process.env.PGHOST     || 'localhost',
            port:     parseInt(process.env.PGPORT || '5432'),
            user:     process.env.PGUSER     || 'admin',
            password: process.env.PGPASSWORD || 'secretpassword',
            database: process.env.PGDATABASE || 'sag_db',
            max:      parseInt(process.env.PG_POOL_MAX || '20'),
            idleTimeoutMillis:    30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            console.error('[DB-PG] Unexpected pool error:', err.message);
        });
    }
    return pool;
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        plan        TEXT DEFAULT 'starter',
        plan                  TEXT DEFAULT 'starter',
        stripe_customer_id    TEXT,
        stripe_subscription_id TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agents (
        id               TEXT PRIMARY KEY,
        project_id       TEXT DEFAULT 'default_project',
        name             TEXT NOT NULL,
        role             TEXT NOT NULL,
        department       TEXT NOT NULL,
        trust_score      INTEGER DEFAULT 50 CHECK(trust_score >= 0 AND trust_score <= 100),
        status           TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
        api_key_hash     TEXT NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        last_seen        TIMESTAMPTZ,
        total_requests   INTEGER DEFAULT 0,
        blocked_requests INTEGER DEFAULT 0,
        UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS tool_registry (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        description   TEXT,
        category      TEXT,
        risk_level    TEXT DEFAULT 'medium' CHECK(risk_level IN ('low','medium','high','critical')),
        requires_tee  BOOLEAN DEFAULT FALSE,
        signature     TEXT NOT NULL,
        schema_json   TEXT,
        registered_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS policies (
        id               TEXT PRIMARY KEY,
        project_id       TEXT DEFAULT 'default_project',
        name             TEXT NOT NULL,
        description      TEXT,
        enabled          BOOLEAN DEFAULT TRUE,
        priority         INTEGER DEFAULT 100,
        conditions       TEXT NOT NULL,
        action           TEXT NOT NULL CHECK(action IN ('allow','deny','escalate','rate_limit')),
        secondary_action TEXT,
        created_by       TEXT DEFAULT 'system',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        hit_count        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
        role       TEXT NOT NULL,
        tool_name  TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('allow','deny','escalate')),
        PRIMARY KEY(role, tool_name)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id                      TEXT PRIMARY KEY,
        project_id              TEXT DEFAULT 'default_project',
        seq                     BIGSERIAL,
        trace_id                TEXT,
        timestamp               TIMESTAMPTZ DEFAULT NOW(),
        agent_id                TEXT NOT NULL,
        agent_name              TEXT NOT NULL,
        tool                    TEXT NOT NULL,
        action                  TEXT NOT NULL,
        resource_classification TEXT,
        policy_decision         TEXT NOT NULL,
        matched_policy_id       TEXT,
        matched_policy_name     TEXT,
        risk_score              INTEGER DEFAULT 0,
        latency_ms              DOUBLE PRECISION DEFAULT 0,
        enclave_attestation     TEXT,
        request_hash            TEXT NOT NULL,
        result_hash             TEXT,
        prev_hash               TEXT,
        request_payload         TEXT,
        response_summary        TEXT
    );

    CREATE TABLE IF NOT EXISTS threat_alerts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT DEFAULT 'default_project',
        severity    TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_id    TEXT,
        agent_name  TEXT,
        resolved    BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vault_assets (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        classification   TEXT NOT NULL CHECK(classification IN ('PII','FINANCIAL','HEALTH','INTERNAL','CREDENTIAL')),
        encrypted_data   TEXT NOT NULL,
        encryption_key_id TEXT NOT NULL,
        iv               TEXT NOT NULL,
        auth_tag         TEXT,
        tee_protected    BOOLEAN DEFAULT FALSE,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vault_access_log (
        id         TEXT PRIMARY KEY,
        asset_id   TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        action     TEXT NOT NULL,
        status     TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS erasure_requests (
        id              TEXT PRIMARY KEY,
        user_identifier TEXT NOT NULL,
        status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed'))
    );

    CREATE TABLE IF NOT EXISTS financial_thresholds (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        tool        TEXT NOT NULL DEFAULT '*',
        max_amount  DOUBLE PRECISION NOT NULL DEFAULT 10000,
        currency    TEXT NOT NULL DEFAULT 'USD',
        enabled     BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, tool)
    );

    CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        role          TEXT DEFAULT 'admin',
        created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspace_usage (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        period           TEXT NOT NULL,
        api_requests     INTEGER DEFAULT 0,
        llm_calls        INTEGER DEFAULT 0,
        blocked_requests INTEGER DEFAULT 0,
        cache_hits       INTEGER DEFAULT 0,
        UNIQUE(project_id, period)
    );

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_audit_project    ON audit_log(project_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_agent      ON audit_log(agent_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_project   ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_project   ON threat_alerts(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_project    ON workspace_usage(project_id, period);
`;

async function initSchema(client) {
    await client.query(SCHEMA);

    await client.query(`
        INSERT INTO meta (key, value) VALUES ('audit_seq', '0')
        ON CONFLICT (key) DO NOTHING
    `);
    await client.query(`
        INSERT INTO meta (key, value)
        VALUES ('last_audit_hash', '0000000000000000000000000000000000000000000000000000000000000000')
        ON CONFLICT (key) DO NOTHING
    `);

    const defaultApiHash = crypto.createHash('sha256').update('sag_live_default_demo_key').digest('hex');
    await client.query(`
        INSERT INTO projects (id, name, api_key_hash)
        VALUES ('default_project', 'Main Workspace', $1)
        ON CONFLICT (id) DO NOTHING
    `, [defaultApiHash]);
}

async function connect() {
    const p = getPool();
    const client = await p.connect();
    try {
        await initSchema(client);
        console.log('[DB-PG] Connected and schema ready');
    } finally {
        client.release();
    }
    return p;
}

// Convenience wrapper — mirrors the SQLite `db.prepare().get/run/all` style
// but returns Promises. Callers use await.
function query(sql, params = []) {
    return getPool().query(sql, params);
}

async function getOne(sql, params = []) {
    const result = await getPool().query(sql, params);
    return result.rows[0] || null;
}

async function getAll(sql, params = []) {
    const result = await getPool().query(sql, params);
    return result.rows;
}

async function run(sql, params = []) {
    const result = await getPool().query(sql, params);
    return { changes: result.rowCount };
}

async function transaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { connect, query, getOne, getAll, run, transaction, getPool };
