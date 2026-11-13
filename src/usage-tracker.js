/**
 * SAG — Usage Tracker (Monetization Layer)
 * 
 * Tracks per-workspace resource consumption for tier enforcement.
 * Period format: YYYY-MM (monthly billing cycle).
 */
const { getDb, uuidv4 } = require('./database');

/**
 * Increment usage counters for a workspace.
 * @param {string} projectId
 * @param {'api_requests'|'llm_calls'|'blocked_requests'|'cache_hits'} field
 */
function trackUsage(projectId, field) {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    const db = getDb();

    // Upsert: create row if missing, increment if exists
    const existing = db.prepare(
        'SELECT id FROM workspace_usage WHERE project_id = ? AND period = ?'
    ).get(projectId, period);

    if (existing) {
        db.prepare(
            `UPDATE workspace_usage SET ${field} = ${field} + 1 WHERE project_id = ? AND period = ?`
        ).run(projectId, period);
    } else {
        const row = { id: uuidv4(), project_id: projectId, period, api_requests: 0, llm_calls: 0, blocked_requests: 0, cache_hits: 0 };
        row[field] = 1;
        db.prepare(
            'INSERT INTO workspace_usage (id, project_id, period, api_requests, llm_calls, blocked_requests, cache_hits) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(row.id, row.project_id, row.period, row.api_requests, row.llm_calls, row.blocked_requests, row.cache_hits);
    }
}

/**
 * Get usage for a workspace (current period or specified).
 */
function getUsage(projectId, period) {
    const p = period || new Date().toISOString().slice(0, 7);
    const db = getDb();
    return db.prepare(
        'SELECT * FROM workspace_usage WHERE project_id = ? AND period = ?'
    ).get(projectId, p) || { api_requests: 0, llm_calls: 0, blocked_requests: 0, cache_hits: 0, period: p };
}

/**
 * Get usage history for a workspace (last N months).
 */
function getUsageHistory(projectId, months = 6) {
    const db = getDb();
    return db.prepare(
        'SELECT * FROM workspace_usage WHERE project_id = ? ORDER BY period DESC LIMIT ?'
    ).all(projectId, months);
}

// ─── Tier Definitions ───
const TIERS = {
    free:       { maxRequests: 1000,    maxLlm: 200,    name: 'Free' },
    starter:    { maxRequests: 10000,   maxLlm: 2000,   name: 'Starter' },
    pro:        { maxRequests: 100000,  maxLlm: 20000,  name: 'Pro' },
    enterprise: { maxRequests: Infinity, maxLlm: Infinity, name: 'Enterprise' },
};

/**
 * Check if a workspace has exceeded its tier limits.
 * Returns null if within limits, or an error object if exceeded.
 */
function checkTierLimits(projectId, tier = 'free') {
    const usage = getUsage(projectId);
    const limits = TIERS[tier] || TIERS.free;

    if (usage.api_requests >= limits.maxRequests) {
        return { exceeded: true, type: 'api_requests', current: usage.api_requests, max: limits.maxRequests, tier: limits.name };
    }
    if (usage.llm_calls >= limits.maxLlm) {
        return { exceeded: true, type: 'llm_calls', current: usage.llm_calls, max: limits.maxLlm, tier: limits.name };
    }
    return null;
}

module.exports = { trackUsage, getUsage, getUsageHistory, checkTierLimits, TIERS };
