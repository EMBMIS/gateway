/**
 * DWI — Audit Logger
 * Append-only, hash-chained, immutable audit log.
 * Every gateway action is recorded with cryptographic integrity.
 *
 * Each entry is chained: hash(entry) includes hash(prev_entry),
 * creating a tamper-evident Merkle-like chain.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb, uuidv4 } = require('./database');

// SAG_LOG_DIR: where checkpoints are written (a mounted volume in production). Default: <repo>/logs.
const CHECKPOINT_FILE = path.join(process.env.SAG_LOG_DIR ? path.resolve(process.env.SAG_LOG_DIR) : path.join(__dirname, '..', 'logs'), 'audit-checkpoints.log');

/**
 * Export a checkpoint of the current chain head.
 */
function exportCheckpoint(seq, hash, timestamp) {
    const logDir = path.dirname(CHECKPOINT_FILE);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    const entry = `${timestamp} | seq=${seq} | hash=${hash}\n`;
    fs.appendFileSync(CHECKPOINT_FILE, entry, 'utf8');
}

/**
 * Verify if a specific sequence matches the anchored checkpoint.
 */
function verifyCheckpoint(seq, expectedHash) {
    if (!fs.existsSync(CHECKPOINT_FILE)) return false;
    const content = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
        const parts = line.split(' | ');
        if (parts.length >= 3) {
            const lineSeq = parseInt(parts[1].split('=')[1], 10);
            const lineHash = parts[2].split('=')[1].trim();
            if (lineSeq === parseInt(seq, 10)) {
                return lineHash === expectedHash;
            }
        }
    }
    return false;
}

/**
 * Append an immutable audit entry to the log.
 * Returns the entry with its hash and sequence number.
 */
function logAction({
    traceId, agentId, agentName, projectId, tool, action, resourceClassification,
    policyDecision, matchedPolicyId, matchedPolicyName,
    riskScore, latencyMs, enclaveAttestation,
    requestPayload, responseSummary
}) {
    const db = getDb();

    // Get current sequence and previous hash
    const meta = db.prepare('SELECT key, value FROM meta WHERE key IN (?, ?)').all('audit_seq', 'last_audit_hash');
    const seqRow = meta.find(m => m.key === 'audit_seq');
    const prevHashRow = meta.find(m => m.key === 'last_audit_hash');

    const seq = parseInt(seqRow?.value || '0') + 1;
    const prevHash = prevHashRow?.value || '0'.repeat(64);

    const id = uuidv4();
    const timestamp = new Date().toISOString();

    // Compute request hash — deterministic fingerprint of the action
    const requestHash = crypto.createHash('sha256').update(
        JSON.stringify({ agentId, tool, action, requestPayload, timestamp })
    ).digest('hex');

    // Compute result hash
    const resultHash = responseSummary
        ? crypto.createHash('sha256').update(JSON.stringify(responseSummary)).digest('hex')
        : null;

    // Chain hash: includes previous hash for tamper-evidence
    // This creates an append-only verifiable chain
    const entryPayload = `${seq}:${prevHash}:${requestHash}:${resultHash || 'null'}:${policyDecision}:${traceId || 'none'}:${timestamp}`;
    const entryHash = crypto.createHash('sha256').update(entryPayload).digest('hex');

    // Insert the audit entry
    db.prepare(`
    INSERT INTO audit_log (id, project_id, seq, trace_id, timestamp, agent_id, agent_name, tool, action,
      resource_classification, policy_decision, matched_policy_id, matched_policy_name,
      risk_score, latency_ms, enclave_attestation, request_hash, result_hash, prev_hash,
      request_payload, response_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        id, projectId || 'default_project', seq, traceId || null, timestamp, agentId, agentName, tool, action,
        resourceClassification || null, policyDecision, matchedPolicyId || null, matchedPolicyName || null,
        riskScore || 0, latencyMs || 0, enclaveAttestation || null,
        requestHash, resultHash, prevHash,
        JSON.stringify(requestPayload || {}), JSON.stringify(responseSummary || {})
    );

    // Update chain state
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(seq), 'audit_seq');
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(entryHash, 'last_audit_hash');

    if (seq > 0 && seq % 100 === 0) {
        exportCheckpoint(seq, entryHash, timestamp);
    }

    return {
        id, seq, timestamp, requestHash, resultHash, prevHash, entryHash, policyDecision
    };
}

/**
 * Verify the integrity of the audit chain.
 * Returns true if the chain is valid (no tampering detected).
 */
function verifyChain(limit = 1000) {
    const db = getDb();
    const entries = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC LIMIT ?').all(limit);

    let expectedPrevHash = '0'.repeat(64);
    const errors = [];
    const checkpointHashes = {};

    for (const entry of entries) {
        // Verify prev_hash chain
        if (entry.prev_hash !== expectedPrevHash) {
            errors.push({ seq: entry.seq, error: 'prev_hash mismatch', expected: expectedPrevHash, got: entry.prev_hash });
        }

        // Recompute entry hash
        const entryPayload = `${entry.seq}:${entry.prev_hash}:${entry.request_hash}:${entry.result_hash || 'null'}:${entry.policy_decision}:${entry.trace_id || 'none'}:${entry.timestamp}`;
        expectedPrevHash = crypto.createHash('sha256').update(entryPayload).digest('hex');

        if (entry.seq > 0 && entry.seq % 100 === 0) {
            checkpointHashes[entry.seq] = expectedPrevHash;
        }
    }

    return {
        valid: errors.length === 0,
        entriesChecked: entries.length,
        errors,
        lastHash: expectedPrevHash,
        checkpointHashes
    };
}

/**
 * Query audit log with filters.
 */
function queryLog({ projectId, agentId, tool, decision, traceId, decisionsOnly, limit = 50, offset = 0 } = {}) {
    const db = getDb();
    let where = [];
    let params = [];

    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    if (tool) { where.push('tool = ?'); params.push(tool); }
    if (decision) { where.push('policy_decision = ?'); params.push(decision); }
    if (traceId) { where.push('trace_id = ?'); params.push(traceId); }
    if (decisionsOnly) where.push("action != 'RESOLVE'");

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit, offset);

    return db.prepare(`SELECT * FROM audit_log ${whereClause} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params);
}

/**
 * Get audit statistics.
 */
function getStats(projectId) {
    const db = getDb();
    // Resolution entries (action RESOLVE) record a person's answer to an escalation; they are not decisions.
    const where = projectId ? "WHERE action != 'RESOLVE' AND project_id = ?" : "WHERE action != 'RESOLVE'";
    const params = projectId ? [projectId] : [];
    const andWhere = projectId ? "AND action != 'RESOLVE' AND project_id = ?" : "AND action != 'RESOLVE'";
    
    const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log ${where}`).get(...params).c;
    const approved = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE policy_decision = 'allow' ${andWhere}`).get(...params).c;
    const denied = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE policy_decision = 'deny' ${andWhere}`).get(...params).c;
    const escalated = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE policy_decision = 'escalate' ${andWhere}`).get(...params).c;
    const avgLatency = db.prepare(`SELECT AVG(latency_ms) as avg FROM audit_log ${where}`).get(...params).avg || 0;
    const avgRisk = db.prepare(`SELECT AVG(risk_score) as avg FROM audit_log ${where}`).get(...params).avg || 0;

    return {
        totalActions: total,
        approved,
        denied,
        escalated,
        approvalRate: total > 0 ? ((approved / total) * 100).toFixed(1) : '0',
        averageLatencyMs: avgLatency.toFixed(2),
        averageRiskScore: avgRisk.toFixed(1),
    };
}

const EXPORT_COLUMNS = [
    'seq', 'timestamp', 'trace_id', 'agent_id', 'agent_name', 'tool', 'action',
    'resource_classification', 'policy_decision', 'matched_policy_id', 'matched_policy_name',
    'risk_score', 'latency_ms', 'request_hash', 'result_hash', 'prev_hash',
    'request_payload', 'response_summary'
];

function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/**
 * Export audit log entries for SOC2 compliance.
 * Supports CSV and JSON formats with date-range and field filtering.
 */
function exportAuditLog({ projectId, agentId, tool, decision, from, to, format = 'json' } = {}) {
    const db = getDb();
    const where = [];
    const params = [];

    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (agentId)   { where.push('agent_id = ?');   params.push(agentId); }
    if (tool)      { where.push('tool = ?');        params.push(tool); }
    if (decision)  { where.push('policy_decision = ?'); params.push(decision); }
    if (from)      { where.push('timestamp >= ?');  params.push(from); }
    if (to)        { where.push('timestamp <= ?');  params.push(to); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(
        `SELECT ${EXPORT_COLUMNS.join(', ')} FROM audit_log ${whereClause} ORDER BY seq ASC`
    ).all(...params);

    if (format === 'csv') {
        const lines = [EXPORT_COLUMNS.join(',')];
        for (const row of rows) {
            lines.push(EXPORT_COLUMNS.map(h => csvEscape(row[h])).join(','));
        }
        return { data: lines.join('\r\n'), count: rows.length, format: 'csv' };
    }

    return { data: rows, count: rows.length, format: 'json' };
}

module.exports = { logAction, verifyChain, queryLog, getStats, exportCheckpoint, verifyCheckpoint, exportAuditLog };
