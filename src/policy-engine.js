/**
 * DWI — Policy Enforcement Engine
 * Deterministic RBAC/ABAC evaluation. Every tool call is evaluated
 * against enterprise policies BEFORE execution. <10ms target.
 */
const { getDb } = require('./database');

/**
 * Evaluate a tool call request against all enabled policies.
 * Returns: { decision: 'allow'|'deny'|'escalate', matchedPolicy, reason, evaluationMs }
 *
 * Evaluation order: policies are sorted by priority (lower = higher priority).
 * First match wins.
 */
function evaluateRequest({ agent, tool, action, resource, args, projectId }) {
    const start = process.hrtime.bigint();
    const db = getDb();

    // 1. Check role-based permission matrix first (fastest path)
    const rolePerm = db.prepare(
        'SELECT permission FROM role_permissions WHERE role = ? AND tool_name = ?'
    ).get(agent.role, tool);

    if (rolePerm && rolePerm.permission === 'deny') {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        return {
            decision: 'deny',
            matchedPolicy: null,
            reason: `Role "${agent.role}" is denied access to tool "${tool}" by permission matrix`,
            evaluationMs: ms.toFixed(2)
        };
    }

    // 2. Evaluate all enabled policies, ordered by priority (low number = high priority)
    // Policies belong to a workspace; the legacy simulator uses the default one.
    const policies = db.prepare(
        'SELECT * FROM policies WHERE enabled = 1 AND project_id = ? ORDER BY priority ASC'
    ).all(projectId || agent.project_id || 'default_project');

    for (const policy of policies) {
        const conditions = JSON.parse(policy.conditions);
        const match = evaluateConditions(conditions, { agent, tool, action, resource, args });

        if (match) {
            // Increment hit counter
            db.prepare('UPDATE policies SET hit_count = hit_count + 1 WHERE id = ?').run(policy.id);

            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            return {
                decision: policy.action,
                matchedPolicy: { id: policy.id, name: policy.name },
                secondaryAction: policy.secondary_action,
                reason: `Matched policy: "${policy.name}" — ${policy.description || ''}`,
                evaluationMs: ms.toFixed(2)
            };
        }
    }

    // 3. Check role permission for escalation
    if (rolePerm && rolePerm.permission === 'escalate') {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        return {
            decision: 'escalate',
            matchedPolicy: null,
            reason: `Role "${agent.role}" requires approval for tool "${tool}"`,
            evaluationMs: ms.toFixed(2)
        };
    }

    // 4. Default policy: deny (fail-closed)
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        decision: rolePerm?.permission === 'allow' ? 'allow' : 'deny',
        matchedPolicy: null,
        reason: rolePerm?.permission === 'allow'
            ? `Allowed by role permission matrix (default)`
            : `No matching policy — default deny (fail-closed)`,
        evaluationMs: ms.toFixed(2)
    };
}

/**
 * Evaluate a set of conditions against the request context.
 * All conditions must match (AND logic).
 */
function evaluateConditions(conditions, ctx) {
    return conditions.every(cond => evaluateCondition(cond, ctx));
}

/**
 * Evaluate a single condition against the request context.
 */
function evaluateCondition(cond, ctx) {
    const fieldValue = resolveField(cond.field, ctx);
    const targetValue = cond.value;

    switch (cond.operator) {
        case '=':
        case '==':
            return String(fieldValue).toLowerCase() === String(targetValue).toLowerCase();
        case '!=':
            return String(fieldValue).toLowerCase() !== String(targetValue).toLowerCase();
        case '>':
            return Number(fieldValue) > Number(targetValue);
        case '<':
            return Number(fieldValue) < Number(targetValue);
        case '>=':
            return Number(fieldValue) >= Number(targetValue);
        case '<=':
            return Number(fieldValue) <= Number(targetValue);
        case 'IN':
            return String(targetValue).split(',').map(s => s.trim().toLowerCase())
                .includes(String(fieldValue).toLowerCase());
        case 'NOT_IN':
            return !String(targetValue).split(',').map(s => s.trim().toLowerCase())
                .includes(String(fieldValue).toLowerCase());
        case 'CONTAINS':
            return String(fieldValue).toLowerCase().includes(String(targetValue).toLowerCase());
        case 'STARTS_WITH':
            return String(fieldValue).toLowerCase().startsWith(String(targetValue).toLowerCase());
        case 'MATCHES':
            return safeRegexTest(targetValue, fieldValue);
        default:
            return false;
    }
}

/** Case-insensitive regex test that never throws (an invalid pattern simply does not match). */
function safeRegexTest(pattern, value) {
    if (value === null || value === undefined) return false;
    const p = String(pattern);
    if (p.length > 200) return false;
    try { return new RegExp(p, 'i').test(String(value)); } catch { return false; }
}

/**
 * Resolve a dotted field path to a value from the request context.
 */
function resolveField(field, ctx) {
    const map = {
        'agent.role': ctx.agent?.role,
        'agent.name': ctx.agent?.name,
        'agent.trust_score': ctx.agent?.trust_score,
        'agent.department': ctx.agent?.department,
        'agent.status': ctx.agent?.status,
        'tool': ctx.tool,
        'action': ctx.action,
        'resource.classification': ctx.resource?.classification,
        'resource.type': ctx.resource?.type || ctx.resource?.classification,
        'resource.env': ctx.resource?.env || 'production',
        'data.residency': ctx.resource?.residency || 'EU-WEST-1',
        'args.amount': ctx.args?.amount,
        'resource.kind': ctx.resource?.kind,
        'resource.module': ctx.resource?.module,
        'context.amount': ctx.context?.amount,
        'context.currency': ctx.context?.currency,
        'context.userId': ctx.context?.userId,
        'context.tenantId': ctx.context?.tenantId,
        'request_time': new Date().getHours(),
    };
    if (map[field] !== undefined) return map[field];
    // args.<path> — any argument, e.g. args.account.type
    if (typeof field === 'string' && field.startsWith('args.') && ctx.args) {
        let cur = ctx.args;
        for (const part of field.slice(5).split('.')) {
            if (cur === null || typeof cur !== 'object') return null;
            cur = cur[part];
        }
        return cur === undefined ? null : cur;
    }
    return null;
}

/**
 * CRUD operations for policies
 */
function createPolicy({ name, description, priority, conditions, action, secondaryAction, createdBy, projectId }) {
    const db = getDb();
    const { uuidv4 } = require('./database');
    const id = uuidv4();
    db.prepare(`
    INSERT INTO policies (id, project_id, name, description, priority, conditions, action, secondary_action, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId || 'default_project', name, description || '', priority || 100, JSON.stringify(conditions), action, secondaryAction || null, createdBy || 'api');
    return { id, name };
}

function updatePolicy(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority); }
    if (updates.conditions !== undefined) { fields.push('conditions = ?'); values.push(JSON.stringify(updates.conditions)); }
    if (updates.action !== undefined) { fields.push('action = ?'); values.push(updates.action); }
    if (updates.secondaryAction !== undefined) { fields.push('secondary_action = ?'); values.push(updates.secondaryAction); }
    fields.push("updated_at = datetime('now')"); values.push(id);
    db.prepare(`UPDATE policies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function deletePolicy(id) {
    const db = getDb();
    db.prepare('DELETE FROM policies WHERE id = ?').run(id);
}

function listPolicies(projectId) {
    const db = getDb();
    if (projectId) {
        return db.prepare('SELECT * FROM policies WHERE project_id = ? ORDER BY priority ASC').all(projectId);
    }
    return db.prepare('SELECT * FROM policies ORDER BY priority ASC').all();
}

function getPolicy(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM policies WHERE id = ?').get(id);
}

/**
 * Seed default policies
 */
function seedPolicies() {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM policies').get().c;
    if (count > 0) return;

    const policies = [
        { name: 'Block All DELETE Operations', desc: 'Deny all DELETE actions — production safety net', priority: 1, conditions: [{ field: 'action', operator: '=', value: 'DELETE' }], action: 'deny', secondary: 'alert_ciso' },
        { name: 'Low Trust Agent Restriction', desc: 'Block write operations from agents with trust score below 50', priority: 2, conditions: [{ field: 'agent.trust_score', operator: '<', value: '50' }, { field: 'action', operator: 'IN', value: 'WRITE,DELETE,CREATE,EXECUTE' }], action: 'deny', secondary: 'alert_ciso' },
        { name: 'Cross-Border PII Block', desc: 'Block PII data movement outside designated region', priority: 3, conditions: [{ field: 'resource.classification', operator: '=', value: 'PII' }, { field: 'data.residency', operator: '!=', value: 'EU-WEST-1' }], action: 'deny', secondary: 'alert_ciso' },
        { name: 'Payment — Human Approval Required', desc: 'Escalate all payment.initiate calls for human signature', priority: 5, conditions: [{ field: 'tool', operator: '=', value: 'payment.initiate' }], action: 'escalate', secondary: 'require_human_signature' },
        { name: 'PII Read — Finance Role Only', desc: 'Allow finance role to read PII classified data', priority: 10, conditions: [{ field: 'agent.role', operator: '=', value: 'finance' }, { field: 'resource.classification', operator: '=', value: 'PII' }, { field: 'action', operator: '=', value: 'READ' }], action: 'allow', secondary: 'log_compliance_receipt' },
        { name: 'Email Rate Limit', desc: 'Block agents sending more than 50 emails per day', priority: 20, conditions: [{ field: 'tool', operator: '=', value: 'email.send' }], action: 'allow', secondary: 'rate_limit_check' },
        { name: 'Internal Slack — All Agents', desc: 'Allow all agents to post to internal Slack', priority: 50, conditions: [{ field: 'tool', operator: '=', value: 'slack.post' }], action: 'allow', secondary: null },
    ];

    const seedRolePerms = [
        ['finance', 'db.query', 'allow'], ['finance', 'db.write', 'escalate'], ['finance', 'payment.initiate', 'escalate'], ['finance', 'email.send', 'allow'], ['finance', 'file.read', 'allow'], ['finance', 'user.lookup', 'escalate'],
        ['engineering', 'db.query', 'allow'], ['engineering', 'db.write', 'allow'], ['engineering', 'email.send', 'allow'], ['engineering', 'file.read', 'allow'], ['engineering', 'file.write', 'allow'], ['engineering', 'slack.post', 'allow'],
        ['hr', 'email.send', 'allow'], ['hr', 'user.lookup', 'allow'], ['hr', 'file.read', 'escalate'], ['hr', 'slack.post', 'allow'],
        ['analytics', 'db.query', 'allow'], ['analytics', 'email.send', 'allow'], ['analytics', 'file.read', 'allow'], ['analytics', 'report.generate', 'allow'], ['analytics', 'user.lookup', 'escalate'],
        ['operations', 'db.query', 'escalate'], ['operations', 'order.create', 'allow'], ['operations', 'inventory.check', 'allow'], ['operations', 'email.send', 'allow'], ['operations', 'payment.initiate', 'escalate'],
        ['security', 'db.query', 'allow'], ['security', 'db.write', 'allow'], ['security', 'user.lookup', 'allow'], ['security', 'file.read', 'allow'], ['security', 'file.write', 'allow'],
        ['compliance', 'db.query', 'allow'], ['compliance', 'user.lookup', 'allow'], ['compliance', 'report.generate', 'allow'], ['compliance', 'email.send', 'allow'],
        ['sales', 'api.salesforce.read', 'allow'], ['sales', 'api.salesforce.write', 'escalate'], ['sales', 'email.send', 'allow'], ['sales', 'calendar.update', 'allow'],
    ];

    for (const p of policies) {
        createPolicy({ name: p.name, description: p.desc, priority: p.priority, conditions: p.conditions, action: p.action, secondaryAction: p.secondary, createdBy: 'system' });
    }

    const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, tool_name, permission) VALUES (?, ?, ?)');
    for (const [role, tool, perm] of seedRolePerms) {
        insertPerm.run(role, tool, perm);
    }

    console.log('[POLICY-ENGINE] Seeded', policies.length, 'policies +', seedRolePerms.length, 'role permissions');
}

module.exports = { evaluateRequest, evaluateConditions, createPolicy, updatePolicy, deletePolicy, listPolicies, getPolicy, seedPolicies };
