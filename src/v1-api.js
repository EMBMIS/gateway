/**
 * EMBMIS Gateway — v1 API for platforms that execute their own tools.
 *
 *   GET  /api/v1/health
 *   PUT  /api/v1/tenants/:tenantId                     (platform key)
 *   POST /api/v1/tenants/:tenantId/agents              (platform key)
 *   POST /api/v1/decide                                (agent key)
 *   POST /api/v1/decisions/:traceId/resolve            (agent key)
 *   GET  /api/v1/policies                              (agent key, read only)
 *   POST /api/v1/policies/test                         (agent key, dry run, writes nothing)
 *   POST /api/v1/policy-proposals                      (agent key; always created disabled, a person enables it)
 *   GET  /api/v1/openapi.yaml
 *
 * Errors are always { error, code }. See docs/openapi.yaml.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDb, uuidv4 } = require('./database');
const { decide } = require('./gateway');
const { logAction } = require('./audit-logger');
const { seedDefaultErpPolicies } = require('./tenant-policy');
const { resolveDecision, DecisionError } = require('./decisions');
const { createPolicy, updatePolicy } = require('./policy-engine');
const { testRequest } = require('./policy-test');

const VERSION = require('../package.json').version;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/;
const TOOL_RE = /^[A-Za-z0-9_.:\-/]{1,200}$/;
const ACTIONS = ['READ', 'WRITE', 'PAYMENT'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fail(res, status, code, message) {
    return res.status(status).json({ error: message, code });
}

function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ─── Platform keys ───
// SAG_PLATFORM_KEY_HASHES: comma-separated SHA-256 hex of the keys (preferred; create with `npm run platform-key`)
// SAG_PLATFORM_KEYS:       comma-separated raw keys (convenient for development)
function platformKeyHashes() {
    const hashes = (process.env.SAG_PLATFORM_KEY_HASHES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const raw = (process.env.SAG_PLATFORM_KEYS || '').split(',').map(s => s.trim()).filter(Boolean).map(sha256);
    return [...hashes, ...raw];
}

function requirePlatformKey(req, res, next) {
    const hashes = platformKeyHashes();
    if (hashes.length === 0) {
        return fail(res, 503, 'PLATFORM_KEY_NOT_CONFIGURED', 'No platform key is configured on this gateway. Run `npm run platform-key` and set SAG_PLATFORM_KEY_HASHES.');
    }
    const token = bearer(req);
    if (!token) return fail(res, 401, 'INVALID_PLATFORM_KEY', 'Missing Authorization: Bearer <platform key>');
    const given = Buffer.from(sha256(token), 'hex');
    let ok = false;
    for (const h of hashes) {
        const want = Buffer.from(h, 'hex');
        if (want.length === given.length && crypto.timingSafeEqual(want, given)) ok = true;
    }
    if (!ok) return fail(res, 401, 'INVALID_PLATFORM_KEY', 'The platform key is not valid');
    next();
}

// ─── Agent keys ───
function loadAgent(req, res, next) {
    const token = bearer(req);
    if (!token) return fail(res, 401, 'INVALID_AGENT_KEY', 'Missing Authorization: Bearer <agent key>');
    const agent = getDb().prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(sha256(token));
    if (!agent) return fail(res, 401, 'INVALID_AGENT_KEY', 'The agent key is not valid or was rotated');
    req.agent = agent;
    next();
}

function tenantOfAgent(agent) {
    return getDb().prepare('SELECT * FROM tenants WHERE project_id = ?').get(agent.project_id) || null;
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const router = express.Router();

router.get('/health', (req, res) => {
    let dbOk = true;
    try { getDb().prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, version: VERSION, mode: process.env.SAG_MODE || 'enforce' });
});

router.get('/openapi.yaml', (req, res) => {
    res.type('application/yaml').send(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
});

// ─── Tenants ───
router.put('/tenants/:tenantId', requirePlatformKey, (req, res) => {
    const { tenantId } = req.params;
    const name = req.body && req.body.name;
    if (!TENANT_RE.test(tenantId)) return fail(res, 400, 'INVALID_TENANT_ID', 'tenantId must be 1-128 characters: letters, digits, _ . : @ -');
    if (typeof name !== 'string' || !name.trim() || name.length > 200) return fail(res, 400, 'INVALID_REQUEST', 'name is required (1-200 characters)');

    const db = getDb();
    const existing = db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(tenantId);
    if (existing) {
        if (existing.name !== name.trim()) {
            db.prepare('UPDATE tenants SET name = ? WHERE tenant_id = ?').run(name.trim(), tenantId);
            db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), existing.project_id);
        }
        return res.status(200).json({ tenantId, projectId: existing.project_id, created: false });
    }

    const projectId = 'proj_' + crypto.randomBytes(12).toString('hex');
    const create = db.transaction(() => {
        // Platform tenants authenticate with agent keys; the workspace key is random and never shown.
        db.prepare('INSERT INTO projects (id, name, api_key_hash) VALUES (?, ?, ?)')
            .run(projectId, name.trim(), sha256(crypto.randomBytes(32)));
        db.prepare('INSERT INTO tenants (tenant_id, project_id, name) VALUES (?, ?, ?)').run(tenantId, projectId, name.trim());
        seedDefaultErpPolicies(projectId);
    });
    create();
    res.status(201).json({ tenantId, projectId, created: true });
});

// ─── Agents ───
router.post('/tenants/:tenantId/agents', requirePlatformKey, (req, res) => {
    const { tenantId } = req.params;
    const { name, role } = req.body || {};
    if (!TENANT_RE.test(tenantId)) return fail(res, 400, 'INVALID_TENANT_ID', 'tenantId is not valid');
    if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) return fail(res, 400, 'INVALID_REQUEST', 'name is required (1-64 characters: letters, digits, space, _ . : -)');
    if (typeof role !== 'string' || !role.trim() || role.length > 64) return fail(res, 400, 'INVALID_REQUEST', 'role is required (1-64 characters)');

    const db = getDb();
    const tenant = db.prepare('SELECT * FROM tenants WHERE tenant_id = ?').get(tenantId);
    if (!tenant) return fail(res, 404, 'TENANT_NOT_FOUND', `Tenant '${tenantId}' does not exist. Create it first with PUT /api/v1/tenants/${tenantId}`);

    const rotate = req.query.rotate === 'true';
    const existing = db.prepare('SELECT * FROM agents WHERE project_id = ? AND name = ?').get(tenant.project_id, name);
    const key = 'sag_agent_' + crypto.randomBytes(24).toString('hex');

    if (existing) {
        if (!rotate) return fail(res, 409, 'AGENT_EXISTS', `Agent '${name}' already exists for this tenant. Use ?rotate=true to issue a new key (the old key stops working).`);
        db.prepare('UPDATE agents SET api_key_hash = ?, role = ? WHERE id = ?').run(sha256(key), role.trim(), existing.id);
        return res.status(200).json({ agentId: existing.id, name, role: role.trim(), key, rotated: true });
    }

    const agentId = 'ag_' + uuidv4().replace(/-/g, '').substring(0, 16);
    db.prepare('INSERT INTO agents (id, project_id, name, role, department, trust_score, api_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(agentId, tenant.project_id, name, role.trim(), 'platform', 75, sha256(key));
    res.status(201).json({ agentId, name, role: role.trim(), key });
});

// ─── Decide ───
router.post('/decide', loadAgent, async (req, res) => {
    try {
        const body = req.body || {};
        const tool = body.tool;
        if (typeof tool !== 'string' || !TOOL_RE.test(tool)) return fail(res, 400, 'INVALID_REQUEST', 'tool is required (1-200 characters: letters, digits, _ . : - /)');
        const action = typeof body.action === 'string' ? body.action.toUpperCase() : '';
        if (!ACTIONS.includes(action)) return fail(res, 400, 'INVALID_REQUEST', `action must be one of ${ACTIONS.join(', ')}`);
        const args = body.args === undefined ? {} : body.args;
        if (!isPlainObject(args)) return fail(res, 400, 'INVALID_REQUEST', 'args must be an object');
        const resource = body.resource === undefined ? {} : body.resource;
        if (!isPlainObject(resource)) return fail(res, 400, 'INVALID_REQUEST', 'resource must be an object');
        const context = body.context === undefined ? {} : body.context;
        if (!isPlainObject(context)) return fail(res, 400, 'INVALID_REQUEST', 'context must be an object');
        if (context.amount !== undefined && context.amount !== null) {
            const n = Number(context.amount);
            if (typeof context.amount === 'boolean' || !Number.isFinite(n) || n < 0) return fail(res, 400, 'INVALID_REQUEST', 'context.amount must be a non-negative number');
            context.amount = n;
        }
        if (body.agentName !== undefined && (typeof body.agentName !== 'string' || body.agentName.length > 128)) return fail(res, 400, 'INVALID_REQUEST', 'agentName must be a string');

        const agent = req.agent;
        const tenant = tenantOfAgent(agent);
        if (context.tenantId && tenant && String(context.tenantId) !== tenant.tenant_id) {
            return fail(res, 403, 'TENANT_MISMATCH', 'context.tenantId does not match the tenant this agent key belongs to');
        }

        if (agent.status !== 'active') {
            // A suspended or killed agent is a decision (deny), not an error: the caller must see it as a verdict.
            const code = agent.status === 'revoked' ? 'AGENT_REVOKED' : 'AGENT_SUSPENDED';
            const reason = agent.status === 'revoked' ? 'This agent was revoked with the kill-switch' : 'This agent is suspended';
            const traceId = crypto.randomUUID();
            const entry = logAction({
                traceId, agentId: agent.id, agentName: agent.name, projectId: agent.project_id, tool, action,
                resourceClassification: resource.classification, policyDecision: 'deny', matchedPolicyName: code,
                riskScore: 100, latencyMs: 0,
                requestPayload: { ...args, _context: { ...context, actor: body.agentName || null, resource } },
                responseSummary: { blocked: true, reason, explanation: { decision: 'deny', code, reason, matchedPolicy: null, riskScore: 100, riskFactors: [], intent: null } },
            });
            return res.json({
                decision: 'deny', code, reason, traceId, riskScore: 100, riskFactors: [], matchedPolicy: null,
                auditId: entry.id, auditHash: entry.entryHash, auditSeq: entry.seq, latencyMs: 0,
            });
        }

        const result = await decide(agent, { tool, action, args, resource, context, actor: body.agentName || null });
        res.json(result);
    } catch (err) {
        console.error('[v1/decide]', err);
        fail(res, 500, 'INTERNAL_ERROR', 'The gateway could not evaluate this request. Reference: ' + crypto.randomBytes(4).toString('hex'));
    }
});

// ─── Resolve ───
router.post('/decisions/:traceId/resolve', loadAgent, (req, res) => {
    try {
        const { traceId } = req.params;
        const { outcome, by, reason } = req.body || {};
        if (outcome !== 'approved' && outcome !== 'rejected') return fail(res, 400, 'INVALID_REQUEST', "outcome must be 'approved' or 'rejected'");
        if (typeof by !== 'string' || !by.trim() || by.length > 200) return fail(res, 400, 'INVALID_REQUEST', 'by is required: who made the decision (1-200 characters)');
        if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 2000)) return fail(res, 400, 'INVALID_REQUEST', 'reason must be a string of at most 2000 characters');

        const out = resolveDecision({ projectId: req.agent.project_id, traceId, outcome, by: by.trim(), reason: reason || null });
        res.json(out);
    } catch (err) {
        if (err instanceof DecisionError) return fail(res, err.status, err.code, err.message);
        console.error('[v1/resolve]', err);
        fail(res, 500, 'INTERNAL_ERROR', 'The gateway could not record this resolution. Reference: ' + crypto.randomBytes(4).toString('hex'));
    }
});

// ─── Policies: an agent may read them, dry-run them and PROPOSE changes. It can never enable one. ───
// A proposal is an ordinary policy row created disabled with created_by 'ai:<agent>'. Disabled policies are not
// evaluated, so a proposal changes nothing until a person enables it in the console. There is deliberately no
// agent endpoint that enables, edits or deletes a policy: an AI must not be able to loosen its own rules.
const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT_IN', 'CONTAINS', 'STARTS_WITH', 'MATCHES'];
const POLICY_ACTIONS = ['allow', 'deny', 'escalate', 'rate_limit'];
const MAX_OPEN_PROPOSALS = 20;

router.get('/policies', loadAgent, (req, res) => {
    const rows = getDb().prepare('SELECT id, name, description, enabled, priority, conditions, action, created_by FROM policies WHERE project_id = ? ORDER BY priority, name').all(req.agent.project_id);
    res.json({ policies: rows.map(r => ({ id: r.id, name: r.name, description: r.description, enabled: !!r.enabled, priority: r.priority, action: r.action, conditions: safeJson(r.conditions), proposedByAi: String(r.created_by).startsWith('ai:') && !r.enabled })) });
});

router.post('/policies/test', loadAgent, (req, res) => {
    try {
        const body = req.body || {};
        const out = testRequest(req.agent.project_id, { ...body, agentId: undefined });
        res.status(out.status).json(out.body);
    } catch (err) {
        console.error('[v1/policies/test]', err);
        fail(res, 500, 'INTERNAL_ERROR', 'The gateway could not evaluate this request. Reference: ' + crypto.randomBytes(4).toString('hex'));
    }
});

router.post('/policy-proposals', loadAgent, (req, res) => {
    try {
        const { name, description, priority, conditions, action } = req.body || {};
        if (typeof name !== 'string' || !name.trim() || name.length > 200) return fail(res, 400, 'INVALID_REQUEST', 'name is required (1-200 characters)');
        if (description !== undefined && (typeof description !== 'string' || description.length > 2000)) return fail(res, 400, 'INVALID_REQUEST', 'description must be a string of at most 2000 characters');
        if (!POLICY_ACTIONS.includes(action)) return fail(res, 400, 'INVALID_REQUEST', `action must be one of ${POLICY_ACTIONS.join(', ')}`);
        if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 10000)) return fail(res, 400, 'INVALID_REQUEST', 'priority must be an integer from 0 to 10000');
        if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 20) return fail(res, 400, 'INVALID_REQUEST', 'conditions must be a list of 1 to 20 { field, operator, value }');
        for (const c of conditions) {
            if (!isPlainObject(c) || typeof c.field !== 'string' || !c.field || c.field.length > 100 || !OPERATORS.includes(c.operator) || (typeof c.value !== 'string' && typeof c.value !== 'number') || String(c.value).length > 200) {
                return fail(res, 400, 'INVALID_REQUEST', `each condition needs a field, an operator (${OPERATORS.join(' ')}) and a short string or number value`);
            }
            if (c.operator === 'MATCHES') { try { new RegExp(String(c.value)); } catch { return fail(res, 400, 'INVALID_REQUEST', 'a MATCHES value must be a valid regular expression'); } }
        }
        const db = getDb();
        const open = db.prepare("SELECT COUNT(*) AS n FROM policies WHERE project_id = ? AND enabled = 0 AND created_by LIKE 'ai:%'").get(req.agent.project_id).n;
        if (open >= MAX_OPEN_PROPOSALS) return fail(res, 429, 'TOO_MANY_PROPOSALS', `There are already ${MAX_OPEN_PROPOSALS} proposals waiting for a person. Ask them to review those first.`);

        const made = createPolicy({
            projectId: req.agent.project_id, name: `Proposed: ${name.trim()}`, description: (description || '').trim(), priority: priority ?? 100,
            conditions: conditions.map(c => ({ field: c.field, operator: c.operator, value: String(c.value) })), action, createdBy: `ai:${req.agent.name}`,
        });
        updatePolicy(made.id, { enabled: false });
        const traceId = crypto.randomUUID();
        logAction({
            traceId, agentId: req.agent.id, agentName: req.agent.name, projectId: req.agent.project_id, tool: 'gateway.policy_proposal', action: 'WRITE',
            policyDecision: 'escalate', matchedPolicyName: 'POLICY_PROPOSAL', riskScore: 0, latencyMs: 0,
            requestPayload: { policyId: made.id, name: name.trim(), action, conditions },
            responseSummary: { blocked: false, reason: 'Proposed by an agent. Disabled until a person enables it.' },
        });
        res.status(201).json({ policyId: made.id, enabled: false, status: 'awaiting_review', traceId, message: 'Created disabled. A person must enable it in the console before it has any effect.' });
    } catch (err) {
        console.error('[v1/policy-proposals]', err);
        fail(res, 500, 'INTERNAL_ERROR', 'The gateway could not record this proposal. Reference: ' + crypto.randomBytes(4).toString('hex'));
    }
});

function safeJson(t) { try { return JSON.parse(t); } catch { return []; } }

// Anything else under /api/v1 is a clean JSON 404 (never HTML).
router.use((req, res) => fail(res, 404, 'NOT_FOUND', `No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}`));

// Malformed JSON bodies etc.
router.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'INVALID_JSON', 'The request body is not valid JSON');
    if (err && err.type === 'entity.too.large') return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
    console.error('[v1]', err);
    fail(res, 500, 'INTERNAL_ERROR', 'Unexpected error');
});

module.exports = { router, platformKeyHashes };
