#!/usr/bin/env node
/**
 * Development helper: create a demo console user, the ERP starter policies, two agents, and a spread of decisions
 * (allowed, blocked, sent to a person, answered) so the console has something real to show.
 *
 *   node scripts/demo-traffic.js [http://localhost:3000]
 *
 * Everything goes through the public API, so every row it creates is a real decision with a real audit entry.
 * Refuses to run against a production gateway.
 */
const BASE = process.argv[2] || process.env.SAG_URL || 'http://localhost:3000';
const EMAIL = process.env.DEMO_EMAIL || 'demo@example.com';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-password-123';

async function call(method, path, { cookie, key, body } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

async function seed(base = BASE) {
    if (base !== BASE) throw new Error('seed(base) must use the configured BASE');
    const health = await call('GET', '/api/v1/health');
    if (health.status !== 200) throw new Error(`Gateway not reachable at ${BASE}`);

    let reg = await call('POST', '/api/auth/register', { body: { email: EMAIL, password: PASSWORD } });
    if (reg.status === 409) reg = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    if (reg.status !== 200) throw new Error(`Could not register or sign in the demo user: ${reg.status} ${JSON.stringify(reg.json)}`);
    const cookie = (reg.setCookie || '').split(';')[0];
    const projectId = reg.json.user.projectId;

    await call('POST', '/api/policies/starter-erp', { cookie, body: { projectId } });
    await call('POST', '/api/financial-threshold/' + projectId, { cookie, body: { tool: 'issue_refund', maxAmount: 5000, currency: 'EUR' } });

    const keys = {};
    for (const [name, role] of [['simeli', 'erp-operator'], ['report-bot', 'analytics']]) {
        const r = await call('POST', '/api/agents', { cookie, body: { name, role, department: 'platform', trustScore: 75, projectId } });
        if (r.status === 201) keys[name] = r.json.apiKey;
    }
    if (!keys.simeli) return { cookie, projectId, email: EMAIL, seeded: false };

    const D = (tool, action, extra = {}) => ({ agentName: extra.actor || 'simeli', tool, action, args: extra.args || {}, resource: extra.resource || { kind: tool, module: 'general', classification: 'internal' }, context: { tenantId: projectId, userId: 'u_81', ...(extra.context || {}) } });
    const scenarios = [
        ...Array.from({ length: 9 }, (_, i) => D(['get_invoice', 'list_customers', 'get_trial_balance', 'list_purchase_orders'][i % 4], 'READ')),
        ...Array.from({ length: 4 }, (_, i) => D(['update_customer', 'create_quote', 'update_item'][i % 3], 'WRITE', { args: { id: i + 1 } })),
        D('delete_invoice', 'WRITE', { args: { id: 12 } }),
        D('delete_customer', 'WRITE', { args: { id: 4 } }),
        D('post_journal_entry', 'WRITE', { args: { lines: 2 }, resource: { kind: 'journal_entry', module: 'finance', classification: 'financial' } }),
        D('create_payment', 'PAYMENT', { args: { supplier: 'Northwind', reference: 'INV-1042' }, resource: { kind: 'payment', module: 'finance', classification: 'financial' }, context: { amount: 25000, currency: 'EUR' } }),
        D('create_payment', 'PAYMENT', { args: { supplier: 'Hartwell', reference: 'INV-1055' }, resource: { kind: 'payment', module: 'finance', classification: 'financial' }, context: { amount: 640, currency: 'EUR' } }),
        D('create_quote', 'WRITE', { context: { amount: 18500, currency: 'EUR' } }),
        D('export_customers', 'READ', { resource: { kind: 'customer', module: 'crm', classification: 'personal' } }),
        D('issue_refund', 'WRITE', { context: { amount: 7200, currency: 'EUR' } }),
        D('get_trial_balance', 'READ', { actor: 'report-bot' }),
        D('approve_invoice', 'WRITE', { args: { id: 77 } }),
    ];
    const traces = [];
    for (const s of scenarios) {
        const r = await call('POST', '/api/v1/decide', { key: keys.simeli, body: s });
        if (r.status !== 200) throw new Error(`decide failed: ${r.status} ${JSON.stringify(r.json)}`);
        if (r.json.decision === 'escalate') traces.push(r.json.traceId);
    }
    // Two of the escalations get an answer; the rest stay in the queue.
    if (traces[0]) await call('POST', `/api/escalations/${traces[0]}/resolve`, { cookie, body: { outcome: 'approved', reason: 'Matches the signed purchase order', projectId } });
    if (traces[1]) await call('POST', `/api/escalations/${traces[1]}/resolve`, { cookie, body: { outcome: 'rejected', reason: 'Supplier bank details changed last week', projectId } });
    return { cookie, projectId, email: EMAIL, password: PASSWORD, seeded: true, decisions: scenarios.length, open: Math.max(0, traces.length - 2) };
}

module.exports = { seed, EMAIL, PASSWORD };

if (require.main === module) {
    if (process.env.NODE_ENV === 'production') { console.error('demo-traffic refuses to run with NODE_ENV=production.'); process.exit(1); }
    seed().then((r) => {
        console.log(r.seeded ? `Seeded ${r.decisions} decisions for ${r.email} (${r.open} waiting in the queue).` : 'Already seeded: agents exist.');
        console.log(`Sign in at ${BASE}/login with ${EMAIL} / ${PASSWORD}`);
    }).catch((e) => { console.error(e.message); process.exit(1); });
}
