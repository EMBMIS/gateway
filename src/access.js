/**
 * EMBMIS Gateway — access control for the management API (/api/*).
 *
 * Enabled when NODE_ENV=production or SAG_REQUIRE_AUTH=1. Then every management call needs a console
 * session (cookie), is scoped to the signed-in user's workspace, and global operations (LLM settings,
 * tool registry, role matrix, vault, key rotation) need an operator: an email listed in SAG_ADMIN_EMAILS.
 *
 * Agent-key and platform-key endpoints (/api/gateway/execute, /api/v1/*) authenticate themselves.
 */
const { getDb } = require('./database');
const { validateSession } = require('./auth');

function enabled() {
    return process.env.NODE_ENV === 'production' || process.env.SAG_REQUIRE_AUTH === '1';
}

function operators() {
    return (process.env.SAG_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Reachable without a console session.
const PUBLIC = [
    /^\/api\/v1(\/|$)/,
    /^\/api\/auth\/(register|login|logout|me)$/,
    /^\/api\/health$/,
    /^\/api\/gateway\/execute$/,
    /^\/api\/billing\/plans$/,
];

// Global, not per-workspace: operators only.
const OPERATOR_ONLY = [
    /^\/api\/settings\//,
    /^\/api\/enclave\//,
    /^\/api\/workers\//,
    /^\/api\/vault\//,
    /^\/api\/metrics$/,
    /^\/api\/permissions$/,
    /^\/api\/tools$/,
];

// path prefix → table holding project_id, for /api/<prefix>/:id ownership checks
const OWNED = [
    [/^\/api\/agents\/([^/]+)/, 'agents'],
    [/^\/api\/policies\/(?!test$|starter-erp$)([^/]+)/, 'policies'],
    [/^\/api\/alerts\/([^/]+)/, 'threat_alerts'],
    [/^\/api\/escalation\/config\/([^/]+)/, 'escalation_configs'],
    [/^\/api\/financial-threshold\/([^/]+)$/, 'financial_thresholds'],
];

function deny(res, status, code, error) { return res.status(status).json({ error, code }); }

function guard(req, res, next) {
    if (!enabled()) return next();
    const p = req.path;
    if (!p.startsWith('/api/') || PUBLIC.some(r => r.test(p))) return next();

    const user = validateSession(req.cookies && req.cookies.sag_session);
    if (!user) return deny(res, 401, 'AUTH_REQUIRED', 'Sign in to use the console API');
    req.user = user;
    const isOperator = operators().includes(String(user.email).toLowerCase());

    if (OPERATOR_ONLY.some(r => r.test(p)) && !(req.method === 'GET' && p === '/api/tools') && !isOperator) {
        return deny(res, 403, 'OPERATOR_ONLY', 'This is a gateway-wide setting. Ask an operator (SAG_ADMIN_EMAILS).');
    }

    // Everything else is scoped to the user's own workspace.
    const pid = user.projectId;
    const asked = req.query.projectId || (req.body && req.body.projectId) || null;
    if (asked && asked !== pid && !isOperator) return deny(res, 403, 'WORKSPACE_FORBIDDEN', 'That workspace belongs to someone else');
    if (!isOperator || !asked) {
        // Express 5: req.query is a getter, so shadow it on the request object.
        Object.defineProperty(req, 'query', { value: { ...req.query, projectId: pid }, writable: true, configurable: true });
        if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) req.body.projectId = pid;
    }

    // /api/projects/:id/..., /api/workspaces/:id/..., /api/escalation/:projectId, /api/financial-threshold/:projectId
    const m = p.match(/^\/api\/(?:projects|workspaces|escalation|financial-threshold)\/([^/]+)/);
    if (m && m[1] !== 'config' && !isOperator) {
        const owned = OWNED.find(([re]) => re.test(p));
        if (!owned && m[1] !== pid) return deny(res, 403, 'WORKSPACE_FORBIDDEN', 'That workspace belongs to someone else');
    }

    // Object-level ownership
    for (const [re, table] of OWNED) {
        const mm = p.match(re);
        if (!mm) continue;
        const row = getDb().prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(mm[1]);
        if (!row) return deny(res, 404, 'NOT_FOUND', 'No such object');
        if (row.project_id !== pid && !isOperator) return deny(res, 404, 'NOT_FOUND', 'No such object');
        break;
    }
    next();
}

module.exports = { guard, enabled, operators };
