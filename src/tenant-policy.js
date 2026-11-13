/**
 * EMBMIS Gateway — per-tenant policies for the decide API.
 *
 * Each tenant (workspace) owns rows in `policies`. They are evaluated in priority order (lower number
 * first), first match wins; no match is a deny (fail-closed). The default set for an ERP is seeded
 * when a platform creates the tenant.
 */
const { getDb } = require('./database');
const { createPolicy, evaluateConditions } = require('./policy-engine');

/** Default policies for a business-operations (ERP) tenant. Lower priority number = evaluated first. */
const DEFAULT_ERP_POLICIES = [
    {
        name: 'ERP: delete tools are denied', priority: 1, action: 'deny',
        description: 'Tools named delete_* never run. Archive or void instead.',
        conditions: [{ field: 'tool', operator: 'MATCHES', value: '^delete_' }],
    },
    {
        name: 'ERP: personal-data exports need approval', priority: 2, action: 'escalate',
        description: 'export_* tools that touch personal data go to a person first.',
        conditions: [
            { field: 'tool', operator: 'MATCHES', value: '^export_' },
            { field: 'resource.classification', operator: 'IN', value: 'personal,pii,personal_data,personal-data,sensitive' },
        ],
        secondary: 'log_compliance_receipt',
    },
    {
        name: 'ERP: payments need approval', priority: 3, action: 'escalate',
        description: 'Any action of type PAYMENT is sent to a person.',
        conditions: [{ field: 'action', operator: '=', value: 'PAYMENT' }],
        secondary: 'require_human_signature',
    },
    {
        name: 'ERP: amounts of 10,000 or more need approval', priority: 4, action: 'escalate',
        description: 'context.amount >= 10,000 is sent to a person, whatever the tool.',
        conditions: [{ field: 'context.amount', operator: '>=', value: '10000' }],
        secondary: 'require_human_signature',
    },
    {
        name: 'ERP: reads are allowed', priority: 10, action: 'allow',
        description: 'READ actions are allowed (still risk-scored).',
        conditions: [{ field: 'action', operator: '=', value: 'READ' }],
    },
    {
        name: 'ERP: ledger, journal, payment and approval tools need approval', priority: 20, action: 'escalate',
        description: 'Writes through ledger, journal, payment or approve tools are sent to a person.',
        conditions: [{ field: 'tool', operator: 'MATCHES', value: 'ledger|journal|payment|approve' }],
        secondary: 'require_human_signature',
    },
    {
        name: 'ERP: other writes are allowed (risk-scored)', priority: 100, action: 'allow',
        description: 'Remaining WRITE actions are allowed unless risk scoring says otherwise.',
        conditions: [{ field: 'action', operator: '=', value: 'WRITE' }],
    },
];

function seedDefaultErpPolicies(projectId) {
    for (const p of DEFAULT_ERP_POLICIES) {
        createPolicy({
            projectId, name: p.name, description: p.description, priority: p.priority,
            conditions: p.conditions, action: p.action, secondaryAction: p.secondary || null, createdBy: 'system',
        });
    }
    return DEFAULT_ERP_POLICIES.length;
}

/**
 * @returns {{decision:'allow'|'deny'|'escalate', matchedPolicy:{id,name}|null, reason:string, secondaryAction:string|null, evaluationMs:string}}
 */
function evaluateTenantPolicies({ projectId, agent, tool, action, resource, args, context }) {
    const start = process.hrtime.bigint();
    const db = getDb();
    const policies = db.prepare('SELECT * FROM policies WHERE enabled = 1 AND project_id = ? ORDER BY priority ASC, created_at ASC').all(projectId);
    const ctx = { agent, tool, action, resource, args, context };

    for (const policy of policies) {
        let conditions;
        try { conditions = JSON.parse(policy.conditions); } catch { continue; }
        if (!Array.isArray(conditions) || conditions.length === 0) continue;
        if (evaluateConditions(conditions, ctx)) {
            db.prepare('UPDATE policies SET hit_count = hit_count + 1 WHERE id = ?').run(policy.id);
            return {
                decision: policy.action === 'rate_limit' ? 'allow' : policy.action,
                matchedPolicy: { id: policy.id, name: policy.name },
                reason: `${policy.name}${policy.description ? ' — ' + policy.description : ''}`,
                secondaryAction: policy.secondary_action || null,
                evaluationMs: (Number(process.hrtime.bigint() - start) / 1e6).toFixed(2),
            };
        }
    }
    return {
        decision: 'deny', matchedPolicy: null,
        reason: 'No policy matches this action — denied by default (fail-closed)',
        secondaryAction: null,
        evaluationMs: (Number(process.hrtime.bigint() - start) / 1e6).toFixed(2),
    };
}

module.exports = { DEFAULT_ERP_POLICIES, seedDefaultErpPolicies, evaluateTenantPolicies };
