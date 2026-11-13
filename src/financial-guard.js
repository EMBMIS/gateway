/**
 * SAG — Financial Threshold Guard
 * Hard-blocks any tool call where a monetary amount exceeds a configured limit.
 * Thresholds are per-workspace and per-tool (or global with tool = '*').
 *
 * Amount extraction: checks args.amount, args.value, args.total, args.price
 * in that order. All values treated as USD unless currency conversion is added.
 */
const { getDb } = require('./database');

// Fields we scan for a monetary amount, in priority order
const AMOUNT_FIELDS = ['amount', 'value', 'total', 'price', 'sum'];

/**
 * Extract a numeric amount from tool call args.
 * Returns null if no recognizable amount field is found.
 */
function extractAmount(args) {
    if (!args || typeof args !== 'object') return null;
    for (const field of AMOUNT_FIELDS) {
        const raw = args[field];
        if (raw !== undefined && raw !== null) {
            const n = parseFloat(raw);
            if (!isNaN(n)) return n;
        }
    }
    return null;
}

/**
 * Check a tool call against financial thresholds for the workspace.
 * Returns { blocked: false } if allowed, or { blocked: true, reason, threshold, amount } if denied.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.tool
 * @param {Object} params.args
 */
function checkThreshold({ projectId, tool, args }) {
    const amount = extractAmount(args);
    if (amount === null) return { blocked: false }; // no monetary value in this call

    const db = getDb();

    // Look for a tool-specific threshold first, then a wildcard '*'
    const threshold =
        db.prepare(`SELECT * FROM financial_thresholds WHERE project_id = ? AND (tool = ? OR tool = '*') AND enabled = 1 ORDER BY CASE WHEN tool = ? THEN 0 ELSE 1 END LIMIT 1`)
          .get(projectId, tool, tool);

    if (!threshold) return { blocked: false };

    if (amount > threshold.max_amount) {
        return {
            blocked: true,
            code: 'FINANCIAL_THRESHOLD_EXCEEDED',
            reason: `Financial threshold exceeded: $${amount.toLocaleString()} > $${threshold.max_amount.toLocaleString()} limit for tool '${tool}'`,
            threshold: threshold.max_amount,
            amount,
            currency: threshold.currency || 'USD',
        };
    }

    return { blocked: false };
}

// ─── CRUD for financial_thresholds ───

function listThresholds(projectId) {
    const db = getDb();
    return db.prepare('SELECT * FROM financial_thresholds WHERE project_id = ? ORDER BY tool ASC').all(projectId);
}

function upsertThreshold({ projectId, tool, maxAmount, currency, enabled }) {
    const db = getDb();
    const { v4: uuidv4 } = require('uuid');
    const existing = db.prepare('SELECT id FROM financial_thresholds WHERE project_id = ? AND tool = ?').get(projectId, tool);
    if (existing) {
        db.prepare(`UPDATE financial_thresholds SET max_amount = ?, currency = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(maxAmount, currency || 'USD', enabled !== false ? 1 : 0, existing.id);
        return { id: existing.id, updated: true };
    }
    const id = uuidv4();
    db.prepare(`INSERT INTO financial_thresholds (id, project_id, tool, max_amount, currency, enabled) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, tool || '*', maxAmount, currency || 'USD', enabled !== false ? 1 : 0);
    return { id, created: true };
}

function deleteThreshold(id) {
    const db = getDb();
    db.prepare('DELETE FROM financial_thresholds WHERE id = ?').run(id);
}

module.exports = { checkThreshold, listThresholds, upsertThreshold, deleteThreshold };
