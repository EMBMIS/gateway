/**
 * /ws: live decisions are for the signed-in workspace only. Self-contained.
 * Run: node tests/live.test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

let passed = 0, failed = 0;
const assert = (n, ok, d) => ok ? (console.log(`  ✅ ${n}`), passed++) : (console.error(`  ❌ ${n}${d !== undefined ? '  → ' + JSON.stringify(d) : ''}`), failed++);
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-live-'));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development', SAG_REQUIRE_AUTH: '1', PORT: String(port), SAG_DB_PATH: path.join(tmp, 'l.db'), ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1' } });
    const stop = () => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
    process.on('exit', stop);
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch {} await sleep(150); }

    const call = async (method, p, { cookie, key, body } = {}) => {
        const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
    };
    const reg = async (email) => { const r = await call('POST', '/api/auth/register', { body: { email, password: 'correct horse battery' } }); return { cookie: (r.setCookie || '').split(';')[0], projectId: r.body.user.projectId }; };
    const listen = (cookie) => new Promise((resolve) => {
        const msgs = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
        const out = { msgs, closed: null, ws };
        ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
        ws.on('close', (code) => { out.closed = code; });
        ws.on('open', () => resolve(out));
        ws.on('error', () => resolve(out));
    });

    console.log('\n  Live feed tests\n');
    const alice = await reg('alice@example.com');
    const bob = await reg('bob@example.com');
    const anon = await listen(null);
    await sleep(300);
    assert('no session → the socket is closed with 4401', anon.closed === 4401, anon.closed);

    const wa = await listen(alice.cookie);
    const wb = await listen(bob.cookie);
    await call('POST', '/api/policies/starter-erp', { cookie: alice.cookie, body: {} });
    const agent = await call('POST', '/api/agents', { cookie: alice.cookie, body: { name: 'bot', role: 'erp-operator', department: 'platform' } });
    await call('POST', '/api/v1/decide', { key: agent.body.apiKey, body: { tool: 'get_invoice', action: 'READ' } });
    await call('POST', '/api/v1/decide', { key: agent.body.apiKey, body: { tool: 'delete_invoice', action: 'WRITE' } });
    await sleep(500);
    const reqs = wa.msgs.filter(m => m.type === 'request');
    assert("alice's socket receives her two decisions", reqs.length === 2 && reqs.map(r => r.data.decision).sort().join() === 'allow,deny', wa.msgs);
    assert('each carries tool, agent, risk and trace id', reqs.every(r => r.data.tool && r.data.agent === 'bot' && typeof r.data.risk === 'number' && r.data.traceId), reqs[0]);
    assert("bob's socket receives nothing of alice's", wb.msgs.length === 0, wb.msgs);
    wa.ws.close(); wb.ws.close();
    stop();
    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
