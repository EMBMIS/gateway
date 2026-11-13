/**
 * EMBMIS Gateway — Risk Scoring Engine v1.0
 *
 * Deterministic risk scoring for AI agent tool calls.
 * No ML. No randomness. Every score is explainable.
 *
 * FORMULA:
 *   risk = trust_penalty
 *        + tool_risk_weight
 *        + action_severity
 *        + payload_modifier
 *        + resource_sensitivity
 *        + velocity_penalty
 *        + block_rate_penalty
 *        + off_hours_penalty
 *
 * THRESHOLDS:
 *   0–59:   APPROVED  (execute immediately)
 *   60–84:  ESCALATED (requires human approval)
 *   85–100: AUTO-BLOCK (denied, alert generated)
 *
 * Cap: 100. All weights are static. No dynamic tuning.
 */
const { getDb } = require('./database');

// ─── Thresholds (frozen v1) ───
const AUTO_BLOCK_THRESHOLD = 85;
const ESCALATION_THRESHOLD = 60;

// ─── Payload Modifiers ───
// Deterministic rules based on tool + argument values.
// These make risk context-aware without introducing ML.
const PAYLOAD_RULES = {
    'payment.initiate': (args) => {
        const amount = parseFloat(args?.amount) || 0;
        if (amount >= 100000) return { weight: 40, detail: `Payment amount $${amount.toLocaleString()} exceeds $100k critical threshold` };
        if (amount >= 50000) return { weight: 25, detail: `Payment amount $${amount.toLocaleString()} exceeds $50k high threshold` };
        if (amount >= 10000) return { weight: 15, detail: `Payment amount $${amount.toLocaleString()} exceeds $10k elevated threshold` };
        return null;
    },
    'db.query': (args) => {
        const sql = (args?.sql || '').toUpperCase();
        if (sql.includes('SELECT *') && !sql.includes('LIMIT'))
            return { weight: 10, detail: 'Unbounded SELECT * query without LIMIT' };
        if (sql.includes('INFORMATION_SCHEMA') || sql.includes('SQLITE_MASTER'))
            return { weight: 20, detail: 'Schema introspection detected' };
        return null;
    },
    'db.write': (args) => {
        const sql = (args?.sql || '').toUpperCase();
        if (sql.includes('DROP')) return { weight: 40, detail: 'DROP statement detected in payload' };
        if (sql.includes('TRUNCATE')) return { weight: 35, detail: 'TRUNCATE statement detected in payload' };
        if (sql.includes('DELETE') && !sql.includes('WHERE'))
            return { weight: 30, detail: 'DELETE without WHERE clause — unbounded deletion' };
        if (sql.includes('DELETE'))
            return { weight: 15, detail: 'DELETE operation on production data' };
        return null;
    },
    'system.config': (args) => {
        const action = (args?.action || '').toLowerCase();
        if (action.includes('disable') || action.includes('remove'))
            return { weight: 30, detail: `Security-degrading config change: "${args.action}"` };
        return null;
    },
};

/**
 * Calculate a deterministic risk score for a tool call request.
 *
 * @param {Object} params
 * @param {Object} params.agent - Agent record from DB
 * @param {string} params.tool  - Tool identifier
 * @param {string} params.action - Action type (READ, WRITE, DELETE, EXECUTE)
 * @param {Object} params.resource - Resource metadata { classification }
 * @param {Object} params.args - Tool call arguments (payload)
 * @param {string} [params.replayTimestamp] - Override current timestamp for deterministic audit replay
 * @param {Object} [params.replayAgentStats] - Override DB stats ({ recentCount }) for deterministic replay
 * @returns {{ score, factors, autoBlock, needsHumanApproval, threshold }}
 */
function scoreRequest({ agent, tool, action, resource, args, amount, replayTimestamp, replayAgentStats, semanticSuspicion }) {
    const db = getDb();
    let score = 0;
    const factors = [];

    // 1. Agent trust penalty (inverse — low trust = high risk)
    if (agent.trust_score < 40) {
        score += 35;
        factors.push({ factor: 'low_trust_score', weight: 35, detail: `Agent trust score is ${agent.trust_score}/100` });
    } else if (agent.trust_score < 60) {
        score += 15;
        factors.push({ factor: 'medium_trust_score', weight: 15, detail: `Agent trust score is ${agent.trust_score}/100` });
    }

    // 2. Tool risk level (from registry)
    const toolInfo = db.prepare('SELECT risk_level FROM tool_registry WHERE name = ?').get(tool);
    if (toolInfo) {
        const riskWeights = { critical: 25, high: 15, medium: 5, low: 0 };
        const w = riskWeights[toolInfo.risk_level] || 0;
        if (w > 0) {
            score += w;
            factors.push({ factor: 'tool_risk_level', weight: w, detail: `Tool "${tool}" is classified as ${toolInfo.risk_level} risk` });
        }
    }

    // 3. Action severity
    const actionWeights = { DELETE: 30, WRITE: 15, CREATE: 10, EXECUTE: 20, PAYMENT: 20, READ: 0 };
    const actionW = actionWeights[action?.toUpperCase()] || 0;
    if (actionW > 0) {
        score += actionW;
        factors.push({ factor: 'action_severity', weight: actionW, detail: `Action "${action}" has elevated risk` });
    }

    // 4. Payload-based modifiers (deterministic, tool-specific)
    const payloadRule = PAYLOAD_RULES[tool];
    if (payloadRule && args) {
        const modifier = payloadRule(args);
        if (modifier) {
            score += modifier.weight;
            factors.push({ factor: 'payload_modifier', weight: modifier.weight, detail: modifier.detail });
        }
    }

    // 4b. Monetary amount supplied by the caller (decide API: context.amount)
    if (typeof amount === 'number' && Number.isFinite(amount) && !(payloadRule && args && payloadRule(args))) {
        const w = amount >= 100000 ? 40 : amount >= 50000 ? 25 : amount >= 10000 ? 15 : 0;
        if (w > 0) {
            score += w;
            factors.push({ factor: 'payload_modifier', weight: w, detail: `Amount ${amount.toLocaleString()} is above the ${amount >= 100000 ? '100k critical' : amount >= 50000 ? '50k high' : '10k elevated'} threshold` });
        }
    }

    // 5. Resource classification sensitivity
    const classWeights = { PII: 20, PERSONAL: 20, PERSONAL_DATA: 20, HEALTH: 25, FINANCIAL: 20, CREDENTIAL: 30, INTERNAL: 5 };
    const classW = classWeights[resource?.classification?.toUpperCase()] || 0;
    if (classW > 0) {
        score += classW;
        factors.push({ factor: 'data_sensitivity', weight: classW, detail: `Resource classified as ${resource?.classification}` });
    }

    // 6. Request velocity — check last 5 minutes
    let recentCount = 0;
    if (replayAgentStats && replayAgentStats.recentCount !== undefined) {
        recentCount = replayAgentStats.recentCount;
    } else {
        const timeRef = replayTimestamp ? new Date(replayTimestamp).toISOString() : new Date().toISOString();
        recentCount = db.prepare(`
        SELECT COUNT(*) as c FROM audit_log
        WHERE agent_id = ? AND timestamp > datetime(?, '-5 minutes')
      `).get(agent.id, timeRef)?.c || 0;
    }

    if (recentCount > 100) {
        score += 20;
        factors.push({ factor: 'high_request_velocity', weight: 20, detail: `${recentCount} requests in last 5 minutes` });
    } else if (recentCount > 50) {
        score += 10;
        factors.push({ factor: 'elevated_request_velocity', weight: 10, detail: `${recentCount} requests in last 5 minutes` });
    }

    // 7. Historical block rate
    if (agent.total_requests > 0) {
        const blockRate = agent.blocked_requests / agent.total_requests;
        if (blockRate > 0.3) {
            score += 15;
            factors.push({ factor: 'high_block_rate', weight: 15, detail: `Agent has ${(blockRate * 100).toFixed(1)}% historical block rate` });
        }
    }

    // 8. Off-hours access (outside 06:00–22:00)
    const timeToUse = replayTimestamp ? new Date(replayTimestamp) : new Date();
    const hour = timeToUse.getHours();
    if (hour < 6 || hour > 22) {
        score += 10;
        factors.push({ factor: 'off_hours_access', weight: 10, detail: `Request made at ${hour}:00 (outside business hours)` });
    }

    // 9. Semantic suspicion from LLM intent analyzer
    if (semanticSuspicion && semanticSuspicion.score > 0 && !semanticSuspicion.skipped) {
        const semanticWeight = Math.round(semanticSuspicion.score * 0.3); // max 30 points
        if (semanticWeight > 0) {
            score += semanticWeight;
            factors.push({
                factor: 'semantic_suspicion',
                weight: semanticWeight,
                detail: `LLM intent analysis: ${semanticSuspicion.reasoning}`,
                flags: semanticSuspicion.flags
            });
        }
    }

    // Cap at 100
    score = Math.min(100, score);

    return {
        score,
        factors,
        autoBlock: score >= AUTO_BLOCK_THRESHOLD,
        needsHumanApproval: score >= ESCALATION_THRESHOLD && score < AUTO_BLOCK_THRESHOLD,
        threshold: { autoBlock: AUTO_BLOCK_THRESHOLD, escalation: ESCALATION_THRESHOLD }
    };
}

module.exports = { scoreRequest, AUTO_BLOCK_THRESHOLD, ESCALATION_THRESHOLD, PAYLOAD_RULES };
