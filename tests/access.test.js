/**
 * Management API access control (SAG_REQUIRE_AUTH=1 / production): login required, workspace scoping,
 * operator-only global settings. Self-contained: starts its own gateway.
 * Run: node tests/access.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let passed = 0, failed = 0;
const assert = (n, ok, d) => ok ? (console.log(`  ✅ ${n}`), passed++) : (console.error(`  ❌ ${n}${d !== undefined ? '  → ' + JSON.stringify(d) : ''}`), failed++);
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-access-'));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root, stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'development', SAG_REQUIRE_AUTH: '1', PORT: String(port), SAG_DB_PATH: path.join(tmp, 'a.db'), ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1', SAG_ADMIN_EMAILS: 'ops@example.com', SAG_PLATFORM_KEYS: 'pk' },
    });
    const stop = () => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
    process.on('exit', stop);
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    const call = async (method, p, { cookie, body } = {}) => {
        const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
    };
    const register = async (email) => {
        const r = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse battery' } });
        return { cookie: (r.setCookie || '').split(';')[0], projectId: r.body.user.projectId, status: r.status };
    };

    console.log('\n  Access control tests\n');
    let r = await call('GET', '/api/agents');
    assert('management API without a session → 401 AUTH_REQUIRED', r.status === 401 && r.body.code === 'AUTH_REQUIRED', r.body);
    r = await call('GET', '/api/v1/health');
    assert('v1 health stays public', r.status === 200);
    r = await call('GET', '/api/auth/me');
    assert('/api/auth/me answers 401 itself', r.status === 401);

    const alice = await register('alice@example.com');
    const bob = await register('bob@example.com');
    const ops = await register('ops@example.com');
    assert('users register and get a session cookie', alice.cookie.startsWith('sag_session=') && bob.cookie && ops.cookie);

    r = await call('POST', '/api/agents', { cookie: alice.cookie, body: { name: 'alice-bot', role: 'finance', department: 'x' } });
    assert('alice creates an agent', r.status === 201, r.body);
    const aliceAgent = r.body.id;
    r = await call('GET', '/api/agents', { cookie: alice.cookie });
    assert('alice sees only her workspace', r.body.length === 1 && r.body[0].name === 'alice-bot', r.body);
    r = await call('GET', '/api/agents', { cookie: bob.cookie });
    assert('bob sees none of alice\'s agents', r.body.length === 0, r.body);
    r = await call('GET', `/api/agents?projectId=${alice.projectId}`, { cookie: bob.cookie });
    assert('bob asking for alice\'s workspace → 403', r.status === 403 && r.body.code === 'WORKSPACE_FORBIDDEN', r.body);
    r = await call('POST', `/api/agents/${aliceAgent}/kill`, { cookie: bob.cookie });
    assert('bob cannot kill alice\'s agent → 404', r.status === 404, r.body);
    r = await call('POST', `/api/projects/${alice.projectId}/keys`, { cookie: bob.cookie });
    assert('bob cannot rotate alice\'s workspace key → 403', r.status === 403, r.body);
    r = await call('GET', '/api/projects', { cookie: bob.cookie });
    assert('bob lists only his own workspace', r.body.length === 1 && r.body[0].id === bob.projectId, r.body);
    r = await call('POST', '/api/policies', { cookie: alice.cookie, body: { name: 'p', conditions: [{ field: 'tool', operator: '=', value: 'x' }], action: 'deny' } });
    r = await call('GET', '/api/policies', { cookie: bob.cookie });
    assert('policies are workspace-scoped', r.body.length === 0, r.body);
    r = await call('GET', '/api/audit', { cookie: bob.cookie });
    assert('audit is workspace-scoped', Array.isArray(r.body) && r.body.every(x => x.project_id === bob.projectId), r.body);

    r = await call('GET', '/api/settings/llm', { cookie: alice.cookie });
    assert('global settings are operator-only → 403', r.status === 403 && r.body.code === 'OPERATOR_ONLY', r.body);
    r = await call('GET', '/api/settings/llm', { cookie: ops.cookie });
    assert('operator may read them', r.status === 200, r.body);
    r = await call('GET', '/api/vault/assets', { cookie: alice.cookie });
    assert('vault is operator-only', r.status === 403);

    stop();
    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
