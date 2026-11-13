/**
 * EMBMIS Gateway — escalations and their resolution.
 *
 * An escalated decision stays open until a person answers it. The answer is appended to the hash-chained
 * audit log as a RESOLVE entry on the same trace id. The v1 API (/api/v1/decisions/:traceId/resolve) and
 * the console's escalation queue both end up here.
 */
const crypto = require('crypto');
const { getDb } = require('./database');
const { logAction } = require('./audit-logger');

class DecisionError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Append a person's answer to an escalation.
 * @throws {DecisionError} 404 DECISION_NOT_FOUND | 409 NOT_ESCALATED | 409 ALREADY_RESOLVED
 */
function resolveDecision({ projectId, traceId, outcome, by, reason }) {
    const db = getDb();
    const original = db.prepare("SELECT * FROM audit_log WHERE trace_id = ? AND project_id = ? AND action != 'RESOLVE' ORDER BY seq ASC LIMIT 1").get(traceId, projectId);
    if (!original) throw new DecisionError(404, 'DECISION_NOT_FOUND', 'No decision with this traceId exists for this tenant');
    if (original.policy_decision !== 'escalate') throw new DecisionError(409, 'NOT_ESCALATED', `Only escalated decisions can be resolved; this one was '${original.policy_decision}'`);
    const done = db.prepare("SELECT 1 FROM audit_log WHERE trace_id = ? AND project_id = ? AND action = 'RESOLVE'").get(traceId, projectId);
    if (done) throw new DecisionError(409, 'ALREADY_RESOLVED', 'This decision was already resolved');

    const resolvedAt = new Date().toISOString();
    const entry = logAction({
        traceId, agentId: original.agent_id, agentName: original.agent_name, projectId,
        tool: original.tool, action: 'RESOLVE',
        policyDecision: outcome === 'approved' ? 'resolved_approved' : 'resolved_rejected',
        matchedPolicyName: 'HUMAN_RESOLUTION', riskScore: original.risk_score, latencyMs: 0,
        requestPayload: { traceId, outcome, by, reason: reason || null, resolvedAt, originalAuditId: original.id },
        responseSummary: { resolved: true, outcome },
    });
    return { traceId, outcome, by, resolvedAt, auditId: entry.id, auditHash: entry.entryHash, auditSeq: entry.seq };
}

/** Open escalations (no RESOLVE entry yet) for a workspace, newest first, with their explanation. */
function listOpenEscalations(projectId, limit = 100) {
    const rows = getDb().prepare(`
        SELECT a.* FROM audit_log a
         WHERE a.project_id = ? AND a.policy_decision = 'escalate' AND a.action != 'RESOLVE'
           AND NOT EXISTS (SELECT 1 FROM audit_log r WHERE r.trace_id = a.trace_id AND r.project_id = a.project_id AND r.action = 'RESOLVE')
         ORDER BY a.seq DESC LIMIT ?`).all(projectId, Math.min(Math.max(Number(limit) || 100, 1), 500));
    return rows.map(presentRow);
}

/** Resolved escalations, so the queue can show what was decided and by whom. */
function listResolvedEscalations(projectId, limit = 50) {
    const rows = getDb().prepare(`
        SELECT r.* FROM audit_log r
         WHERE r.project_id = ? AND r.action = 'RESOLVE'
         ORDER BY r.seq DESC LIMIT ?`).all(projectId, Math.min(Math.max(Number(limit) || 50, 1), 200));
    return rows.map((r) => {
        const p = parseJson(r.request_payload, {});
        return { id: r.id, seq: r.seq, trace_id: r.trace_id, tool: r.tool, agent_name: r.agent_name, outcome: p.outcome, by: p.by, reason: p.reason, resolved_at: p.resolvedAt || r.timestamp, risk_score: r.risk_score };
    });
}

/** An audit row with its JSON columns parsed and the explanation lifted out. */
function presentRow(row) {
    const summary = parseJson(row.response_summary, {});
    const payload = parseJson(row.request_payload, {});
    const context = payload._context || null;
    const trace = payload._trace || null;
    const { _context, _trace, ...args } = payload; // eslint-disable-line no-unused-vars
    return {
        ...row,
        request_payload: undefined,
        response_summary: undefined,
        args,
        context,
        trace,
        summary,
        explanation: summary.explanation || null,
    };
}

/** Recompute an entry's chain hash and say whether its neighbours agree. */
function inspectEntry(id, projectId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ? AND project_id = ?').get(id, projectId);
    if (!row) return null;
    const payload = `${row.seq}:${row.prev_hash}:${row.request_hash}:${row.result_hash || 'null'}:${row.policy_decision}:${row.trace_id || 'none'}:${row.timestamp}`;
    const entryHash = crypto.createHash('sha256').update(payload).digest('hex');
    const prev = db.prepare('SELECT * FROM audit_log WHERE seq = ?').get(row.seq - 1);
    let prevHashMatches = row.seq === 1 ? row.prev_hash === '0'.repeat(64) : false;
    if (prev) {
        const prevPayload = `${prev.seq}:${prev.prev_hash}:${prev.request_hash}:${prev.result_hash || 'null'}:${prev.policy_decision}:${prev.trace_id || 'none'}:${prev.timestamp}`;
        prevHashMatches = crypto.createHash('sha256').update(prevPayload).digest('hex') === row.prev_hash;
    }
    const next = db.prepare('SELECT prev_hash FROM audit_log WHERE seq = ?').get(row.seq + 1);
    const linkedFromNext = next ? next.prev_hash === entryHash : null; // null: this is the newest entry
    const resolution = row.policy_decision === 'escalate'
        ? db.prepare("SELECT * FROM audit_log WHERE trace_id = ? AND project_id = ? AND action = 'RESOLVE'").get(row.trace_id, projectId)
        : null;
    return {
        entry: presentRow(row),
        entryHash,
        chain: { prevHashMatches, linkedFromNext, intact: prevHashMatches && linkedFromNext !== false },
        resolution: resolution ? presentRow(resolution) : null,
    };
}

module.exports = { resolveDecision, listOpenEscalations, listResolvedEscalations, presentRow, inspectEntry, DecisionError };
