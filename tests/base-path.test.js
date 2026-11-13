/**
 * The gateway served under a path of a shared host (SAG_BASE_PATH=/gateway, as on embmis.com/gateway).
 * Run: node tests/base-path.test.js   (starts its own gateway)
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let passed = 0, failed = 0;
function assert(name, ok, detail) {
    if (ok) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); failed++; }
}

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-base-'));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root, stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'development', SAG_REQUIRE_AUTH: '1', SAG_BASE_PATH: '/gateway', PORT: String(port), SAG_DB_PATH: path.join(tmp, 'b.db'), ENCLAVE_POOL_SIZE: '0', ENCLAVE_ADDRESS: '127.0.0.1:1', SAG_PLATFORM_KEYS: 'pk' },
    });
    const stop = () => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
    process.on('exit', stop);
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/gateway/api/v1/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    console.log('\n  Served under /gateway\n');
    let res = await fetch(`${origin}/gateway/api/v1/health`);
    assert('the v1 API answers under the prefix', res.status === 200 && (await res.json()).ok === true);

    res = await fetch(`${origin}/gateway`, { redirect: 'manual' });
    assert('/gateway redirects to /gateway/', res.status === 301 && /\/gateway\/$/.test(res.headers.get('location') || ''), res.headers.get('location'));

    res = await fetch(`${origin}/gateway/decisions/queue`);
    const html = await res.text();
    assert('a client route serves the console', res.status === 200 && /<div id="root">/.test(html));
    // Built with CONSOLE_BASE=/gateway/ (the Docker image) its assets live under the prefix; a default build serves them from /.
    assert('the console page references its assets', /src="\/(gateway\/)?assets\//.test(html), html.slice(0, 300));

    res = await fetch(`${origin}/gateway/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'p@example.com', password: 'correct horse battery' }) });
    const cookie = res.headers.get('set-cookie') || '';
    assert('the session cookie is scoped to /gateway', /sag_session=/.test(cookie) && /Path=\/gateway(;|$)/i.test(cookie), cookie);

    const sid = cookie.split(';')[0];
    const ok = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway/ws`, { headers: { Cookie: sid } });
        ws.on('open', () => { ws.close(); resolve(true); });
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 4000);
    });
    assert('the live feed connects at /gateway/ws', ok);

    res = await fetch(`${origin}/gateway/api/auth/logout`, { method: 'POST', headers: { Cookie: sid } });
    assert('logout clears the cookie on the same path', /Path=\/gateway/i.test(res.headers.get('set-cookie') || ''), res.headers.get('set-cookie'));

    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
