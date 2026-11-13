'use strict';
/**
 * EMBMIS Gateway — plans.
 *
 * The Gateway is free and open source: one plan, no check limit, no overage, no payment integration.
 * Usage is still counted per workspace (src/usage-tracker.js) so the console can show it.
 *
 * enforcePlanLimit stays as the single place a limit would be applied, so a self-hosted operator who wants
 * per-workspace quotas can add a plan with a finite `limit` below; with every plan unlimited it never blocks.
 */
const { getDb } = require('./database');

const PLANS = {
    starter: { name: 'Free', price: 0, limit: Infinity },
};

function enforcePlanLimit(projectId) {
    const db      = getDb();
    const project = db.prepare('SELECT plan FROM projects WHERE id = ?').get(projectId);
    const plan    = project?.plan || 'starter';
    const limits  = PLANS[plan] || PLANS.starter;
    if (limits.limit === Infinity) return null;

    const period  = new Date().toISOString().slice(0, 7);
    const usage   = db.prepare('SELECT api_requests FROM workspace_usage WHERE project_id = ? AND period = ?').get(projectId, period);
    const used    = usage?.api_requests || 0;

    if (used >= limits.limit) {
        return {
            blocked: true,
            reason:  `Monthly limit of ${limits.limit.toLocaleString()} checks reached on the ${limits.name} plan.`,
            used,
            limit:   limits.limit,
            plan:    limits.name,
        };
    }
    return null;
}

module.exports = { PLANS, enforcePlanLimit };
