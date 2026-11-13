/**
 * DWI — Database Layer
 * Dual-adapter: SQLite (default, local dev) or PostgreSQL (production).
 * Set DB_ADAPTER=postgres to use PostgreSQL.
 */

// The gateway's pipeline uses this module synchronously (better-sqlite3); the PostgreSQL adapter in
// database-pg.js is asynchronous and cannot be dropped in. Refuse loudly instead of failing obscurely later.
if (process.env.DB_ADAPTER === 'postgres') {
    throw new Error('DB_ADAPTER=postgres is not supported. To store the gateway\'s data in PostgreSQL set SAG_DATABASE_URL (and optionally SAG_DB_SCHEMA) instead; see DEPLOY.md.');
}

const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.SAG_DB_PATH ? path.resolve(process.env.SAG_DB_PATH) : path.join(__dirname, '..', 'dwi.db');
let db;

// SAG_DATABASE_URL selects PostgreSQL , in its own schema; otherwise SQLite at SAG_DB_PATH.
function getDb() {
  if (!db) {
    if (process.env.SAG_DATABASE_URL) {
      const { PgSyncDb } = require('./db-pg-sync');
      // A throw-away SAG_DB_PATH (tests) gets its own schema, so isolated runs stay isolated.
      const schema = process.env.SAG_DB_SCHEMA
        || (process.env.SAG_DB_PATH && process.env.NODE_ENV !== 'production' ? 't_' + require('crypto').createHash('sha1').update(path.resolve(process.env.SAG_DB_PATH)).digest('hex').slice(0, 12) : 'gateway');
      db = new PgSyncDb({ url: process.env.SAG_DATABASE_URL, schema, skipDdl: process.env.SAG_DB_DDL === 'off' });
    } else {
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
    }
    initSchema();
  }
  return db;
}

/**
 * The schema as PostgreSQL DDL, for an administrator to apply (see db-pg-sync.js skipDdl). Records what initSchema
 * would execute against a stand-in handle; touches no database.
 */
function pgSchemaStatements() {
  const { translate, splitStatements } = require('./db-pg-sync');
  const out = [];
  const record = (sql) => { const t = translate(sql).sql; if (/^\s*(CREATE|ALTER)\b/i.test(t)) out.push(t); };
  const saved = db;
  db = {
    exec: (script) => { for (const st of splitStatements(script)) record(st); },
    prepare: () => ({ get: () => ({ id: 'x', c: 1 }), run: () => ({ changes: 0 }), all: () => [] }),
    pragma: () => [],
  };
  try { initSchema(); } finally { db = saved; }
  return out;
}

function initSchema() {
  db.exec(`
    -- SAAS Projects / Workspaces
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Registered AI agents
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default_project',
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      trust_score INTEGER DEFAULT 50 CHECK(trust_score >= 0 AND trust_score <= 100),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
      api_key_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT,
      total_requests INTEGER DEFAULT 0,
      blocked_requests INTEGER DEFAULT 0,
      UNIQUE(project_id, name)
    );

    -- MCP Tool Registry (signed manifest)
    CREATE TABLE IF NOT EXISTS tool_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      category TEXT,
      risk_level TEXT DEFAULT 'medium' CHECK(risk_level IN ('low','medium','high','critical')),
      requires_tee INTEGER DEFAULT 0,
      signature TEXT NOT NULL,
      schema_json TEXT,
      registered_at TEXT DEFAULT (datetime('now'))
    );

    -- RBAC/ABAC Policies
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default_project',
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 100,
      conditions TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('allow','deny','escalate','rate_limit')),
      secondary_action TEXT,
      created_by TEXT DEFAULT 'system',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      hit_count INTEGER DEFAULT 0
    );

    -- Role ↔ Tool permission matrix
    CREATE TABLE IF NOT EXISTS role_permissions (
      role TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('allow','deny','escalate')),
      PRIMARY KEY(role, tool_name)
    );

    -- Immutable audit log (append-only)
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default_project',
      seq INTEGER,
      trace_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now','utc')),
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_classification TEXT,
      policy_decision TEXT NOT NULL,
      matched_policy_id TEXT,
      matched_policy_name TEXT,
      risk_score INTEGER DEFAULT 0,
      latency_ms REAL DEFAULT 0,
      enclave_attestation TEXT,
      request_hash TEXT NOT NULL,
      result_hash TEXT,
      prev_hash TEXT,
      request_payload TEXT,
      response_summary TEXT
    );

    -- Threat alerts
    CREATE TABLE IF NOT EXISTS threat_alerts (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'default_project',
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Vault assets (encrypted credential store for MVP)
    CREATE TABLE IF NOT EXISTS vault_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('PII','FINANCIAL','HEALTH','INTERNAL','CREDENTIAL')),
      encrypted_data TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT,
      tee_protected INTEGER DEFAULT 0,
      subject_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Vault access log
    CREATE TABLE IF NOT EXISTS vault_access_log (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- GDPR erasure requests
    CREATE TABLE IF NOT EXISTS erasure_requests (
      id TEXT PRIMARY KEY,
      user_identifier TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
      proof_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- SaaS Users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Session store (HttpOnly cookie-based)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Usage tracking (monetization hooks)
    CREATE TABLE IF NOT EXISTS workspace_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      period TEXT NOT NULL,
      api_requests INTEGER DEFAULT 0,
      llm_calls INTEGER DEFAULT 0,
      blocked_requests INTEGER DEFAULT 0,
      cache_hits INTEGER DEFAULT 0,
      UNIQUE(project_id, period)
    );

    -- Sequence counter for audit chain
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('audit_seq', '0');
    INSERT OR IGNORE INTO meta (key, value) VALUES ('last_audit_hash', '0000000000000000000000000000000000000000000000000000000000000000');
  `);

  // Migrate existing tables — safe to re-run, errors mean column already exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS financial_thresholds (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      tool        TEXT NOT NULL DEFAULT '*',
      max_amount  REAL NOT NULL DEFAULT 10000,
      currency    TEXT NOT NULL DEFAULT 'USD',
      enabled     INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, tool)
    );
  `);

  // Tenants created by platforms (EMBMIS Business OS etc.) through the v1 API.
  // One tenant = one workspace (project); the tenant id is the platform's own id for the company.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id   TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_log(trace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_project_seq ON audit_log(project_id, seq);
  `);

  // Escalation notification configs (per workspace)
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalation_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('slack','email')),
      slack_webhook_url TEXT,
      smtp_url TEXT,
      email_from TEXT,
      email_to TEXT,
      min_severity TEXT DEFAULT 'high' CHECK(min_severity IN ('critical','high','medium','low')),
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, channel)
    );
  `);

  const columnMigrations = [
    ['agents',       'project_id TEXT DEFAULT \'default_project\''],
    ['policies',     'project_id TEXT DEFAULT \'default_project\''],
    ['audit_log',    'project_id TEXT DEFAULT \'default_project\''],
    ['threat_alerts','project_id TEXT DEFAULT \'default_project\''],
    ['vault_assets', 'subject_hash TEXT'],
    ['erasure_requests', 'proof_hash TEXT'],
    ['erasure_requests', 'created_at TEXT'],
    ['erasure_requests', 'completed_at TEXT'],
    ['projects',     'plan TEXT DEFAULT \'starter\''],
    ['projects',     'stripe_customer_id TEXT'],
    ['projects',     'stripe_subscription_id TEXT'],
  ];
  for (const [table, col] of columnMigrations) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch (_) { /* column already exists */ }
  }

  // Ensure default project exists
  const crypto = require('crypto');
  const dflt = db.prepare('SELECT id FROM projects WHERE id = ?').get('default_project');
  if (!dflt) {
    // We store the hash of the default api key so we can auth the legacy dashboard
    const defaultApiHash = crypto.createHash('sha256').update(
      (process.env.NODE_ENV !== 'production' || process.env.SAG_SEED_DEMO === '1') ? 'sag_live_default_demo_key' : crypto.randomBytes(32)
    ).digest('hex');
    db.prepare('INSERT INTO projects (id, name, api_key_hash) VALUES (?, ?, ?)')
      .run('default_project', 'Main Workspace', defaultApiHash);
    console.log('[DB] Seeded Default Workspace (default_project).');
  }
}

module.exports = { getDb, uuidv4, pgSchemaStatements };
