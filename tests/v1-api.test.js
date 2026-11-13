/**
 * v1 API tests: tenants, agents, decide (allow / deny / escalate / bad key), resolve, isolation, audit chain.
 *
 * Self-contained: starts its own gateway on a free port with a throw-away database, so it needs no running stack.
 * Run: node tests/v1-api.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let passed = 0, failed = 0;
function assert(name, ok, detail) {
    if (ok) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`); failed++; }
}

const PLATFORM_KEY = 'sag_platform_test_' + Math.random().toString(16).slice(2);
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-v1-'));

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
        s.on('error', reject);
    });
}

async function main() {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            NODE_ENV: 'development', PORT: String(port),
            SAG_DB_PATH: path.join(tmp, 'v1.db'),
            ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1',
            SAG_PLATFORM_KEYS: PLATFORM_KEY, SAG_MODE: 'enforce',
            SAG_REQUIRE_AUTH: '', LLM_API_KEY: '', OPENAI_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });

    const stop = () => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
    process.on('exit', stop);

    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(`${base}/api/v1/health`); if (r.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 150));
        if (i === 99) { console.error(log); throw new Error('gateway did not start'); }
    }

    const call = async (method, p, { key, body, raw } = {}) => {
        const res = await fetch(base + p, {
            method,
            headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, body: json };
    };
    const decide = (key, b) => call('POST', '/api/v1/decide', { key, body: b });
    const D = (over) => ({ agentName: 'simeli', tool: 'get_invoice', action: 'READ', args: {}, resource: { kind: 'invoice', module: 'sales', classification: 'internal' }, context: { tenantId: 'acme', userId: 'u1' }, ...over });

    console.log('\n  v1 API tests\n');

    console.log('  [1] Health:');
    let r = await call('GET', '/api/v1/health');
    assert('GET /health → {ok, version, mode}', r.status === 200 && r.body.ok === true && typeof r.body.version === 'string' && r.body.mode === 'enforce', r.body);

    console.log('\n  [2] Tenants (platform key):');
    r = await call('PUT', '/api/v1/tenants/acme', { body: { name: 'Acme Ltd' } });
    assert('no key → 401 INVALID_PLATFORM_KEY', r.status === 401 && r.body.code === 'INVALID_PLATFORM_KEY' && !!r.body.error, r.body);
    r = await call('PUT', '/api/v1/tenants/acme', { key: 'wrong', body: { name: 'Acme Ltd' } });
    assert('wrong key → 401', r.status === 401 && r.body.code === 'INVALID_PLATFORM_KEY', r.body);
    r = await call('PUT', '/api/v1/tenants/acme', { key: PLATFORM_KEY, body: {} });
    assert('missing name → 400 INVALID_REQUEST', r.status === 400 && r.body.code === 'INVALID_REQUEST', r.body);
    r = await call('PUT', '/api/v1/tenants/acme', { key: PLATFORM_KEY, body: { name: 'Acme Ltd' } });
    assert('create → 201 {tenantId, projectId, created:true}', r.status === 201 && r.body.tenantId === 'acme' && /^proj_/.test(r.body.projectId) && r.body.created === true, r.body);
    const acmeProject = r.body.projectId;
    r = await call('PUT', '/api/v1/tenants/acme', { key: PLATFORM_KEY, body: { name: 'Acme Ltd' } });
    assert('idempotent → same projectId, created:false', r.status === 200 && r.body.projectId === acmeProject && r.body.created === false, r.body);
    r = await call('GET', `/api/policies?projectId=${acmeProject}`);
    assert('default ERP policies seeded (7)', Array.isArray(r.body) && r.body.length === 7, r.body && r.body.length);
    r = await call('PUT', '/api/v1/tenants/globex', { key: PLATFORM_KEY, body: { name: 'Globex' } });
    const globexProject = r.body.projectId;
    assert('second tenant gets its own project', r.status === 201 && globexProject !== acmeProject, r.body);

    console.log('\n  [3] Agents (platform key):');
    r = await call('POST', '/api/v1/tenants/nope/agents', { key: PLATFORM_KEY, body: { name: 'simeli', role: 'erp' } });
    assert('unknown tenant → 404 TENANT_NOT_FOUND', r.status === 404 && r.body.code === 'TENANT_NOT_FOUND', r.body);
    r = await call('POST', '/api/v1/tenants/acme/agents', { key: PLATFORM_KEY, body: { name: 'simeli' } });
    assert('missing role → 400', r.status === 400 && r.body.code === 'INVALID_REQUEST', r.body);
    r = await call('POST', '/api/v1/tenants/acme/agents', { key: PLATFORM_KEY, body: { name: 'simeli', role: 'erp-operator' } });
    assert('create → 201 {agentId, name, role, key}', r.status === 201 && /^ag_/.test(r.body.agentId) && r.body.name === 'simeli' && r.body.role === 'erp-operator' && /^sag_agent_/.test(r.body.key), r.body);
    const simeliKey = r.body.key, simeliId = r.body.agentId;
    r = await call('POST', '/api/v1/tenants/acme/agents', { key: PLATFORM_KEY, body: { name: 'simeli', role: 'erp-operator' } });
    assert('again → 409 AGENT_EXISTS', r.status === 409 && r.body.code === 'AGENT_EXISTS', r.body);
    r = await call('POST', '/api/v1/tenants/globex/agents', { key: PLATFORM_KEY, body: { name: 'simeli', role: 'erp-operator' } });
    const globexKey = r.body.key;
    assert('same agent name in another tenant is fine', r.status === 201 && globexKey !== simeliKey, r.body);

    console.log('\n  [4] Decide — bad key and bad input:');
    r = await decide('sag_agent_nope', D());
    assert('bad agent key → 401 INVALID_AGENT_KEY', r.status === 401 && r.body.code === 'INVALID_AGENT_KEY', r.body);
    r = await decide(null, D());
    assert('no key → 401', r.status === 401 && r.body.code === 'INVALID_AGENT_KEY', r.body);
    r = await decide(PLATFORM_KEY, D());
    assert('platform key is not an agent key → 401', r.status === 401, r.body);
    r = await decide(simeliKey, D({ action: 'DELETE' }));
    assert('unknown action → 400 INVALID_REQUEST', r.status === 400 && r.body.code === 'INVALID_REQUEST', r.body);
    r = await decide(simeliKey, D({ tool: '' }));
    assert('empty tool → 400', r.status === 400, r.body);
    r = await decide(simeliKey, D({ context: { amount: 'lots' } }));
    assert('non-numeric amount → 400', r.status === 400, r.body);
    r = await call('POST', '/api/v1/decide', { key: simeliKey, raw: '{not json' });
    assert('malformed JSON → 400 INVALID_JSON', r.status === 400 && r.body.code === 'INVALID_JSON', r.body);
    r = await decide(simeliKey, D({ context: { tenantId: 'globex' } }));
    assert('context.tenantId of another tenant → 403 TENANT_MISMATCH', r.status === 403 && r.body.code === 'TENANT_MISMATCH', r.body);

    console.log('\n  [5] Decide — allow:');
    r = await decide(simeliKey, D());
    const allow = r.body;
    assert('read → allow', r.status === 200 && allow.decision === 'allow' && allow.code === 'ALLOWED', allow);
    assert('response carries traceId, riskScore, riskFactors, matchedPolicy, auditId, latencyMs',
        typeof allow.traceId === 'string' && typeof allow.riskScore === 'number' && Array.isArray(allow.riskFactors) &&
        allow.matchedPolicy && /reads are allowed/.test(allow.matchedPolicy.name) && typeof allow.auditId === 'string' && typeof allow.latencyMs === 'number', allow);
    r = await decide(simeliKey, D({ tool: 'update_customer', action: 'WRITE', args: { id: 7, phone: '123' } }));
    assert('ordinary write → allow', r.body.decision === 'allow', r.body);
    r = await decide(simeliKey, D({ tool: 'export_customers', action: 'READ', resource: { kind: 'customer', module: 'crm', classification: 'internal' } }));
    assert('export of non-personal data → allow', r.body.decision === 'allow', r.body);

    console.log('\n  [6] Decide — deny:');
    r = await decide(simeliKey, D({ tool: 'delete_invoice', action: 'WRITE', args: { id: 1 } }));
    const del = r.body;
    assert('delete_* → deny POLICY_DENY', del.decision === 'deny' && del.code === 'POLICY_DENY' && /delete tools are denied/.test(del.matchedPolicy.name), del);
    r = await decide(simeliKey, D({ tool: 'delete_invoice', action: 'READ' }));
    assert('delete_* is denied even as a READ', r.body.decision === 'deny', r.body);
    r = await call('POST', `/api/financial-threshold/${acmeProject}`, { body: { tool: 'issue_refund', maxAmount: 5000 } });
    r = await decide(simeliKey, D({ tool: 'issue_refund', action: 'WRITE', context: { tenantId: 'acme', amount: 6000, currency: 'EUR' } }));
    assert('financial threshold → deny FINANCIAL_THRESHOLD_EXCEEDED', r.body.decision === 'deny' && r.body.code === 'FINANCIAL_THRESHOLD_EXCEEDED', r.body);

    console.log('\n  [7] Decide — escalate:');
    r = await decide(simeliKey, D({ tool: 'post_journal_entry', action: 'WRITE', args: { lines: 2 } }));
    const journal = r.body;
    assert('journal tool → escalate', journal.decision === 'escalate' && journal.code === 'POLICY_ESCALATE' && /ledger, journal/.test(journal.matchedPolicy.name), journal);
    for (const tool of ['adjust_ledger', 'create_payment_run', 'approve_invoice']) {
        r = await decide(simeliKey, D({ tool, action: 'WRITE' }));
        assert(`${tool} → escalate`, r.body.decision === 'escalate', r.body);
    }
    r = await decide(simeliKey, D({ tool: 'transfer_funds', action: 'PAYMENT', args: { to: 'X' } }));
    assert('PAYMENT action → escalate', r.body.decision === 'escalate', r.body);
    r = await decide(simeliKey, D({ tool: 'create_quote', action: 'WRITE', context: { tenantId: 'acme', amount: 10000 } }));
    assert('amount = 10,000 → escalate', r.body.decision === 'escalate' && /10,000/.test(r.body.matchedPolicy.name), r.body);
    r = await decide(simeliKey, D({ tool: 'create_quote', action: 'WRITE', context: { tenantId: 'acme', amount: 9999.99 } }));
    assert('amount just under 10,000 → allow', r.body.decision === 'allow', r.body);
    r = await decide(simeliKey, D({ tool: 'export_customers', action: 'READ', resource: { kind: 'customer', module: 'crm', classification: 'personal' } }));
    const exp = r.body;
    assert('export_* of personal data → escalate', exp.decision === 'escalate' && /personal-data exports/.test(exp.matchedPolicy.name), exp);
    r = await decide(simeliKey, D({ tool: 'get_ledger_balance', action: 'READ' }));
    assert('reading a ledger is still a read → allow', r.body.decision === 'allow', r.body);
    r = await decide(simeliKey, D({ tool: 'create_payment', action: 'PAYMENT', context: { tenantId: 'acme', amount: 150000 } }));
    assert('large payment → escalate with a higher risk score', r.body.decision === 'escalate' && r.body.riskScore > journal.riskScore, r.body);

    console.log('\n  [8] Resolve:');
    r = await call('POST', `/api/v1/decisions/${journal.traceId}/resolve`, { key: simeliKey, body: { outcome: 'approved', by: 'user:u_81', reason: 'Checked the entry' } });
    assert('approve an escalation → 200 with audit hash', r.status === 200 && r.body.outcome === 'approved' && typeof r.body.auditHash === 'string' && r.body.traceId === journal.traceId, r.body);
    r = await call('POST', `/api/v1/decisions/${journal.traceId}/resolve`, { key: simeliKey, body: { outcome: 'rejected', by: 'user:u_81' } });
    assert('resolving twice → 409 ALREADY_RESOLVED', r.status === 409 && r.body.code === 'ALREADY_RESOLVED', r.body);
    r = await call('POST', `/api/v1/decisions/${exp.traceId}/resolve`, { key: simeliKey, body: { outcome: 'rejected', by: 'user:u_81', reason: 'Not needed' } });
    assert('reject an escalation → 200', r.status === 200 && r.body.outcome === 'rejected', r.body);
    r = await call('POST', `/api/v1/decisions/${allow.traceId}/resolve`, { key: simeliKey, body: { outcome: 'approved', by: 'x' } });
    assert('resolving an allow → 409 NOT_ESCALATED', r.status === 409 && r.body.code === 'NOT_ESCALATED', r.body);
    r = await call('POST', `/api/v1/decisions/${del.traceId}/resolve`, { key: simeliKey, body: { outcome: 'approved', by: 'x' } });
    assert('resolving a deny → 409 NOT_ESCALATED', r.status === 409 && r.body.code === 'NOT_ESCALATED', r.body);
    r = await call('POST', '/api/v1/decisions/00000000-0000-0000-0000-000000000000/resolve', { key: simeliKey, body: { outcome: 'approved', by: 'x' } });
    assert('unknown traceId → 404 DECISION_NOT_FOUND', r.status === 404 && r.body.code === 'DECISION_NOT_FOUND', r.body);
    r = await call('POST', `/api/v1/decisions/${exp.traceId}/resolve`, { key: simeliKey, body: { outcome: 'maybe', by: 'x' } });
    assert('bad outcome → 400', r.status === 400 && r.body.code === 'INVALID_REQUEST', r.body);
    r = await call('POST', `/api/v1/decisions/${exp.traceId}/resolve`, { key: simeliKey, body: { outcome: 'approved' } });
    assert('missing "by" → 400', r.status === 400, r.body);
    r = await call('POST', `/api/v1/decisions/${exp.traceId}/resolve`, { key: 'sag_agent_nope', body: { outcome: 'approved', by: 'x' } });
    assert('bad key → 401', r.status === 401, r.body);
    const other = await decide(simeliKey, D({ tool: 'post_journal_entry', action: 'WRITE' }));
    r = await call('POST', `/api/v1/decisions/${other.body.traceId}/resolve`, { key: globexKey, body: { outcome: 'approved', by: 'x' } });
    assert('another tenant cannot resolve it → 404', r.status === 404 && r.body.code === 'DECISION_NOT_FOUND', r.body);

    console.log('\n  [9] Audit chain and explanations:');
    r = await call('GET', '/api/audit/verify?limit=5000');
    assert('hash chain verifies', r.body.valid === true && r.body.entriesChecked > 15, { valid: r.body.valid, n: r.body.entriesChecked, errors: r.body.errors && r.body.errors.slice(0, 2) });
    r = await call('GET', `/api/audit?projectId=${acmeProject}&limit=500`);
    const rows = r.body;
    const delRow = rows.find(x => x.trace_id === del.traceId);
    const expl = delRow && JSON.parse(delRow.response_summary).explanation;
    assert('audit rows are tenant-scoped', rows.length > 0 && rows.every(x => x.project_id === acmeProject), rows.length);
    assert('a decision explains itself (policy, risk factors, intent, bundle hash)', expl && expl.matchedPolicy && Array.isArray(expl.riskFactors) && 'intent' in expl && /^[0-9a-f]{64}$/.test(expl.policyBundleHash), expl);
    assert('resolution is in the chain', rows.some(x => x.action === 'RESOLVE' && x.trace_id === journal.traceId && x.policy_decision === 'resolved_approved'));
    r = await call('GET', `/api/audit/stats?projectId=${acmeProject}`);
    assert('stats count decisions, not resolutions', r.body.escalated >= 8 && r.body.denied >= 3, r.body);

    console.log('\n  [10] Kill-switch is a verdict, not an error:');
    await call('POST', `/api/agents/${simeliId}/suspend`);
    r = await decide(simeliKey, D());
    assert('suspended agent → 200 deny AGENT_SUSPENDED', r.status === 200 && r.body.decision === 'deny' && r.body.code === 'AGENT_SUSPENDED', r.body);
    await call('POST', `/api/agents/${simeliId}/kill`);
    r = await decide(simeliKey, D());
    assert('killed agent → 200 deny AGENT_REVOKED', r.status === 200 && r.body.decision === 'deny' && r.body.code === 'AGENT_REVOKED', r.body);

    console.log('\n  [11] Key rotation:');
    r = await call('POST', '/api/v1/tenants/globex/agents?rotate=true', { key: PLATFORM_KEY, body: { name: 'simeli', role: 'erp-operator' } });
    const newGlobexKey = r.body.key;
    assert('?rotate=true → new key', r.status === 200 && /^sag_agent_/.test(newGlobexKey) && newGlobexKey !== globexKey, r.body);
    r = await decide(globexKey, D({ context: { tenantId: 'globex' } }));
    assert('old key revoked → 401', r.status === 401, r.body);
    r = await decide(newGlobexKey, D({ context: { tenantId: 'globex' } }));
    assert('new key works', r.status === 200 && r.body.decision === 'allow', r.body);

    console.log('\n  [12] AI-governed configuration (an agent may propose, never apply):');
    r = await call('GET', '/api/v1/policies');
    assert('listing policies needs an agent key', r.status === 401, r.body);
    r = await call('GET', '/api/v1/policies', { key: newGlobexKey });
    assert('agent can read its tenant policies (7 seeded)', r.status === 200 && r.body.policies.length === 7 && r.body.policies.every(p => p.enabled), r.body);
    r = await call('POST', '/api/v1/policies/test', { key: newGlobexKey, body: { tool: 'delete_supplier', action: 'WRITE' } });
    assert('dry run says what /decide would say, deny', r.status === 200 && r.body.decision === 'deny', r.body);
    const before = (await call('GET', '/api/audit?projectId=' + globexProject + '&limit=1000')).body;
    r = await call('POST', '/api/v1/policy-proposals', { key: newGlobexKey, body: { name: 'Refunds over 500 need approval', action: 'escalate', priority: 5, conditions: [{ field: 'tool', operator: 'MATCHES', value: '^create_refund' }, { field: 'context.amount', operator: '>', value: '500' }] } });
    assert('proposal → 201 disabled, awaiting_review', r.status === 201 && r.body.enabled === false && r.body.status === 'awaiting_review', r.body);
    const proposalId = r.body.policyId;
    r = await call('GET', '/api/v1/policies', { key: newGlobexKey });
    const prop = r.body.policies.find(p => p.id === proposalId);
    assert('proposal is listed, disabled, flagged as AI-proposed', prop && prop.enabled === false && prop.proposedByAi === true && /^Proposed:/.test(prop.name), prop);
    r = await call('POST', '/api/v1/decide', { key: newGlobexKey, body: D({ tool: 'create_refund', action: 'WRITE', context: { tenantId: 'globex', amount: 900 } }) });
    assert('a proposal has no effect until a person enables it', r.body.decision === 'allow', r.body);
    await call('PUT', `/api/policies/${proposalId}`, { body: { enabled: true } });
    r = await call('POST', '/api/v1/decide', { key: newGlobexKey, body: D({ tool: 'create_refund', action: 'WRITE', context: { tenantId: 'globex', amount: 900 } }) });
    assert('after a person enables it, it applies', r.body.decision === 'escalate', r.body);
    r = await call('PUT', `/api/v1/policies/${proposalId}`, { key: newGlobexKey, body: { enabled: false } });
    assert('there is no agent endpoint to edit a policy', r.status === 404, r.status);
    r = await call('DELETE', `/api/v1/policies/${proposalId}`, { key: newGlobexKey });
    assert('there is no agent endpoint to delete a policy', r.status === 404, r.status);
    r = await call('POST', '/api/v1/policy-proposals', { key: newGlobexKey, body: { name: 'x', action: 'allow', conditions: [{ field: 'tool', operator: 'MATCHES', value: '(' }] } });
    assert('an invalid regular expression is rejected', r.status === 400, r.body);
    r = await call('POST', '/api/v1/policy-proposals', { key: newGlobexKey, body: { name: 'x', action: 'maybe', conditions: [] } });
    assert('an unknown action is rejected', r.status === 400, r.body);
    const after = (await call('GET', '/api/audit?projectId=' + globexProject + '&limit=1000')).body;
    assert('the proposal is in the audit chain', JSON.stringify(after).includes('POLICY_PROPOSAL') && !JSON.stringify(before).includes('POLICY_PROPOSAL'));
    let last;
    for (let i = 0; i < 21; i++) last = await call('POST', '/api/v1/policy-proposals', { key: newGlobexKey, body: { name: 'p' + i, action: 'escalate', conditions: [{ field: 'tool', operator: '=', value: 't' + i }] } });
    assert('proposals waiting for review are capped (429)', last.status === 429 && last.body.code === 'TOO_MANY_PROPOSALS', last.body);

    console.log('\n  [13] OpenAPI:');
    const res = await fetch(`${base}/api/v1/openapi.yaml`);
    const text = await res.text();
    const spec = require('yaml').parse(text);
    assert('served at /api/v1/openapi.yaml', res.status === 200 && spec.openapi.startsWith('3.1'), spec.openapi);
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter(m => ['get', 'put', 'post'].includes(m)).map(m => `${m.toUpperCase()} ${p}`));
    const expected = ['GET /api/v1/health', 'GET /api/v1/openapi.yaml', 'PUT /api/v1/tenants/{tenantId}', 'POST /api/v1/tenants/{tenantId}/agents', 'POST /api/v1/decide', 'POST /api/v1/decisions/{traceId}/resolve', 'GET /api/v1/policies', 'POST /api/v1/policies/test', 'POST /api/v1/policy-proposals'];
    assert('documents every v1 endpoint', expected.every(e => documented.includes(e)) && documented.length === expected.length, documented);
    assert('file docs/openapi.yaml equals the served document', fs.readFileSync(path.join(root, 'docs', 'openapi.yaml'), 'utf8') === text);
    r = await call('GET', '/api/v1/nothing');
    assert('unknown v1 path → JSON 404 {error, code}', r.status === 404 && r.body.code === 'NOT_FOUND', r.body);

    stop();
    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
