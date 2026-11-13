/**
 * The API the console uses: escalation queue, entry inspection, policy tester, starter policies, billing and system status.
 * Self-contained: starts its own gateway with a throw-away database.
 * Run: node tests/console-api.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let passed = 0, failed = 0;
const assert = (n, ok, d) => ok ? (console.log(`  ✅ ${n}`), passed++) : (console.error(`  ❌ ${n}${d !== undefined ? '  → ' + JSON.stringify(d) : ''}`), failed++);
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-console-'));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root, stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'development', SAG_REQUIRE_AUTH: '1', PORT: String(port), SAG_DB_PATH: path.join(tmp, 'c.db'), ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1', SAG_PLATFORM_KEYS: 'pk', STRIPE_SECRET_KEY: '' },
    });
    const stop = () => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
    process.on('exit', stop);
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    const call = async (method, p, { cookie, key, body } = {}) => {
        const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
    };
    const register = async (email) => { const r = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse battery' } }); return { cookie: (r.setCookie || '').split(';')[0], projectId: r.body.user.projectId }; };

    console.log('\n  Console API tests\n');
    const alice = await register('alice@example.com');
    const bob = await register('bob@example.com');

    let r = await call('POST', '/api/policies/test', { cookie: alice.cookie, body: { tool: 'x', action: 'READ' } });
    assert('policy tester on an empty workspace: deny (nothing matches)', r.status === 200 && r.body.decision === 'deny' && /No policy matches/.test(r.body.reason), r.body);
    r = await call('POST', '/api/policies/starter-erp', { cookie: alice.cookie, body: {} });
    assert('starter set → 201 with 7 policies', r.status === 201 && r.body.created === 7, r.body);
    r = await call('POST', '/api/policies/starter-erp', { cookie: alice.cookie, body: {} });
    assert('starter set twice → 409 POLICIES_EXIST', r.status === 409 && r.body.code === 'POLICIES_EXIST', r.body);
    r = await call('GET', '/api/policies', { cookie: bob.cookie });
    assert("bob does not get alice's policies", Array.isArray(r.body) && r.body.length === 0, r.body);

    const t = (tool, action, extra = {}) => call('POST', '/api/policies/test', { cookie: alice.cookie, body: { tool, action, ...extra } });
    r = await t('get_invoice', 'READ');
    assert('tester: read → allow', r.body.decision === 'allow' && /reads are allowed/.test(r.body.policy.matchedPolicy.name), r.body);
    r = await t('delete_invoice', 'WRITE');
    assert('tester: delete_* → deny POLICY_DENY', r.body.decision === 'deny' && r.body.code === 'POLICY_DENY', r.body);
    r = await t('create_payment', 'PAYMENT', { context: { amount: 25000 } });
    assert('tester: payment → escalate with risk factors', r.body.decision === 'escalate' && r.body.risk.factors.length > 0, r.body);
    r = await t('x', 'DELETE');
    assert('tester: bad action → 400', r.status === 400 && r.body.code === 'INVALID_REQUEST', r.body);
    r = await t('x', 'READ', { context: { amount: 'lots' } });
    assert('tester: bad amount → 400', r.status === 400, r.body);

    // an agent + escalated decisions through the v1 API, then the queue
    r = await call('POST', '/api/agents', { cookie: alice.cookie, body: { name: 'bot', role: 'erp-operator', department: 'platform', trustScore: 75 } });
    const key = r.body.apiKey;
    const decide = (tool, action, extra = {}) => call('POST', '/api/v1/decide', { key, body: { tool, action, args: {}, resource: extra.resource || {}, context: { amount: extra.amount } } });
    const a = await decide('create_payment', 'PAYMENT', { amount: 900 });
    const b = await decide('post_journal_entry', 'WRITE');
    const ok = await decide('get_invoice', 'READ');
    assert('three decisions: 2 escalate, 1 allow', a.body.decision === 'escalate' && b.body.decision === 'escalate' && ok.body.decision === 'allow', [a.body, b.body, ok.body].map(x => x.decision));

    r = await call('GET', '/api/escalations', { cookie: alice.cookie });
    assert('queue lists the 2 open escalations, newest first', r.body.open.length === 2 && r.body.open[0].trace_id === b.body.traceId && r.body.resolved.length === 0, r.body.open.map(x => x.tool));
    assert('queue rows carry the explanation', r.body.open[0].explanation && r.body.open[0].explanation.matchedPolicy && Array.isArray(r.body.open[0].explanation.riskFactors), r.body.open[0].explanation);
    r = await call('GET', '/api/escalations', { cookie: bob.cookie });
    assert("bob's queue is empty", r.body.open.length === 0, r.body);

    r = await call('POST', `/api/escalations/${a.body.traceId}/resolve`, { cookie: bob.cookie, body: { outcome: 'approved' } });
    assert("bob cannot resolve alice's escalation → 404", r.status === 404 && r.body.code === 'DECISION_NOT_FOUND', r.body);
    r = await call('POST', `/api/escalations/${a.body.traceId}/resolve`, { cookie: alice.cookie, body: { outcome: 'maybe' } });
    assert('bad outcome → 400', r.status === 400, r.body);
    r = await call('POST', `/api/escalations/${a.body.traceId}/resolve`, { cookie: alice.cookie, body: { outcome: 'approved', reason: 'Matches the PO' } });
    assert('console approves an escalation → 200 with audit hash', r.status === 200 && r.body.outcome === 'approved' && /^[0-9a-f]{64}$/.test(r.body.auditHash), r.body);
    r = await call('POST', `/api/escalations/${a.body.traceId}/resolve`, { cookie: alice.cookie, body: { outcome: 'rejected' } });
    assert('answering twice → 409 ALREADY_RESOLVED', r.status === 409 && r.body.code === 'ALREADY_RESOLVED', r.body);
    r = await call('POST', `/api/escalations/${ok.body.traceId}/resolve`, { cookie: alice.cookie, body: { outcome: 'approved' } });
    assert('an allow cannot be resolved → 409 NOT_ESCALATED', r.status === 409 && r.body.code === 'NOT_ESCALATED', r.body);
    r = await call('GET', '/api/escalations', { cookie: alice.cookie });
    assert('queue now has 1 open and 1 answered (by the console user)', r.body.open.length === 1 && r.body.resolved.length === 1 && /console:alice@example.com/.test(r.body.resolved[0].by) && r.body.resolved[0].outcome === 'approved', r.body);

    // the platform's own view of the same answer
    const agentKeyResolve = await call('POST', `/api/v1/decisions/${b.body.traceId}/resolve`, { key, body: { outcome: 'rejected', by: 'user:7' } });
    assert('the platform can still answer the other one through v1', agentKeyResolve.status === 200, agentKeyResolve.body);
    r = await call('GET', '/api/escalations', { cookie: alice.cookie });
    assert('queue empty after both answered', r.body.open.length === 0 && r.body.resolved.length === 2, r.body);

    // entry inspection
    r = await call('GET', `/api/audit?kind=decision&limit=50`, { cookie: alice.cookie });
    assert('/api/audit?kind=decision hides resolution entries', r.body.length === 3 && r.body.every(x => x.action !== 'RESOLVE'), r.body.map(x => x.action));
    const row = r.body.find(x => x.trace_id === a.body.traceId);
    r = await call('GET', `/api/audit/entry/${row.id}`, { cookie: alice.cookie });
    assert('entry inspection: hash recomputed, chain intact, resolution attached', r.status === 200 && /^[0-9a-f]{64}$/.test(r.body.entryHash) && r.body.chain.intact === true && r.body.resolution && r.body.entry.explanation, r.body.chain);
    r = await call('GET', `/api/audit/entry/${row.id}`, { cookie: bob.cookie });
    assert("bob cannot inspect alice's entry → 404", r.status === 404, r.body);
    r = await call('GET', '/api/audit/verify?limit=1000', { cookie: alice.cookie });
    assert('chain verifies', r.body.valid === true, r.body);

    // status endpoints
    r = await call('GET', '/api/billing/status', { cookie: alice.cookie });
    assert('billing status: free and unlimited, no checkout', r.status === 200 && r.body.free === true && r.body.unlimited === true && r.body.checkoutAvailable === false, r.body);
    r = await call('GET', '/api/system/status', { cookie: alice.cookie });
    assert('system status: bundle verified, access control on, platform keys counted, no secrets', r.status === 200 && r.body.bundle.signatureVerified === true && r.body.accessControl === true && r.body.platformKeys === 1 && !/pk/.test(JSON.stringify(r.body).replace(/platformKeys/g, '')) , r.body);
    r = await call('GET', '/api/system/status');
    assert('system status needs a session', r.status === 401, r.body);

    // secrets never reach the browser
    await call('POST', `/api/escalation/${alice.projectId}`, { cookie: alice.cookie, body: { channel: 'slack', slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRETSECRET', minSeverity: 'high' } });
    r = await call('GET', `/api/escalation/${alice.projectId}`, { cookie: alice.cookie });
    assert('notification config never returns the webhook URL', r.body.length === 1 && r.body[0].has_slack_webhook === true && !JSON.stringify(r.body).includes('SECRETSECRET'), r.body);
    await call('POST', `/api/escalation/${alice.projectId}`, { cookie: alice.cookie, body: { channel: 'slack', minSeverity: 'critical' } });
    // Read through the gateway's own database module, so this works for SQLite and PostgreSQL alike.
    const kept = JSON.parse(require('child_process').execFileSync(process.execPath, ['-e',
        "const { getDb } = require('./src/database'); console.log(JSON.stringify(getDb().prepare('SELECT slack_webhook_url, min_severity FROM escalation_configs').get()))"],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, SAG_DB_PATH: path.join(tmp, 'c.db') } }).trim().split('\n').pop());
    assert('a blank secret keeps the stored one', kept.slack_webhook_url.includes('SECRETSECRET') && kept.min_severity === 'critical', kept);

    // the console is served, with SPA fallback and JSON 404 for the API
    const index = await fetch(`${base}/decisions/queue`);
    const html = await index.text();
    assert('SPA fallback serves the console index for a client route', index.status === 200 && /<div id="root">/.test(html), index.status);
    const miss = await fetch(`${base}/api/nothing-here`);
    assert('unknown /api paths are not swallowed by the SPA fallback', !(await miss.text()).includes('id="root"'));

    stop();
    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
