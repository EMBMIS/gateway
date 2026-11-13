/**
 * Dry run: what would the gateway say about this request? Evaluates the workspace's policies and the risk score.
 * Writes nothing. Shared by the console (/api/policies/test) and agents (/api/v1/policies/test).
 */
const { getDb } = require('./database');
const { scoreRequest } = require('./risk-engine');
const { evaluateTenantPolicies } = require('./tenant-policy');

const bad = (error) => ({ status: 400, body: { error, code: 'INVALID_REQUEST' } });

function testRequest(projectId, { agentId, tool, action = 'WRITE', resource = {}, context = {}, args = {} } = {}) {
    if (typeof tool !== 'string' || !tool.trim()) return bad('tool is required');
    if (!['READ', 'WRITE', 'PAYMENT'].includes(String(action).toUpperCase())) return bad('action must be READ, WRITE or PAYMENT');
    const db = getDb();
    const agent = (agentId && db.prepare('SELECT * FROM agents WHERE id = ? AND project_id = ?').get(agentId, projectId))
        || { id: 'policy-tester', name: 'policy-tester', role: 'tester', trust_score: 75, total_requests: 0, blocked_requests: 0, status: 'active', project_id: projectId };
    const amount = context.amount !== undefined && context.amount !== '' && context.amount !== null ? Number(context.amount) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return bad('context.amount must be a non-negative number');
    const act = String(action).toUpperCase();
    const policy = evaluateTenantPolicies({ projectId, agent, tool: tool.trim(), action: act, resource, args, context: { ...context, amount } });
    const risk = scoreRequest({ agent, tool: tool.trim(), action: act, resource, args, amount });
    let decision, code, reason;
    if (policy.decision === 'deny') { decision = 'deny'; code = 'POLICY_DENY'; reason = policy.reason; }
    else if (risk.autoBlock) { decision = 'deny'; code = 'RISK_AUTO_BLOCK'; reason = `Risk score ${risk.score}/100 is at or above the auto-block threshold (${risk.threshold.autoBlock})`; }
    else if (policy.decision === 'escalate') { decision = 'escalate'; code = 'POLICY_ESCALATE'; reason = policy.reason; }
    else if (risk.needsHumanApproval) { decision = 'escalate'; code = 'RISK_ESCALATION'; reason = `Risk score ${risk.score}/100 requires human approval`; }
    else { decision = 'allow'; code = 'ALLOWED'; reason = policy.matchedPolicy ? `Allowed by policy '${policy.matchedPolicy.name}'` : 'Policy allows and risk is below the escalation threshold'; }
    return { status: 200, body: { decision, code, reason, policy, risk: { score: risk.score, factors: risk.factors, thresholds: risk.threshold }, agent: { id: agent.id, name: agent.name, role: agent.role, trustScore: agent.trust_score } } };
}

module.exports = { testRequest };
