#!/usr/bin/env node
/**
 * npm test — run every suite.
 *
 *   1. Unit tests that need nothing running.
 *   2. Self-contained suites: each starts its own gateway on a free port with a throw-away database
 *      (key-guard, v1-api, access, console-api, live).
 *   3. The stack suites (the original ones): they talk to a gateway on localhost:3000, so one is started here,
 *      with its enclave worker and a throw-away database, and stopped afterwards.
 *
 * Development keys are generated first if none exist (npm run keys:dev). Exit code is non-zero if any suite fails.
 *
 *   node scripts/run-tests.js            everything
 *   node scripts/run-tests.js v1 access  only suites whose file name contains one of the words
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const filter = process.argv.slice(2);
const wanted = (name) => filter.length === 0 || filter.some((f) => name.includes(f));

const UNIT = ['risk-engine', 'risk-replay', 'intent-analysis', 'security-invariants', 'audit-integrity', 'policy-rollback', 'key-guard', 'vault', 'mcp'];
const SELF = ['v1-api', 'access', 'console-api', 'live', 'base-path'];
// Order matters: integration first, because later suites change agent history that its $50k check depends on.
const STACK = ['integration', 'crypto', 'failure-modes', 'fuzz', 'benchmark', 'clock-skew', 'nonce-persistence', 'sandbox', 'scenarios'];

const results = [];
function run(name) {
    if (!wanted(name)) return;
    const file = path.join('tests', `${name}.test.js`);
    process.stdout.write(`\n━━ ${name} ━━\n`);
    const r = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit', env: process.env, timeout: 300000 });
    results.push({ name, ok: r.status === 0, status: r.status });
}

const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

(async () => {
    const staleKeys = () => {
        if (process.env.SAG_SECRETS_DIR) return false;
        if (!fs.existsSync(path.join(root, 'certs', 'gateway-ed25519.key')) || !fs.existsSync(path.join(root, 'policy.bundle.json'))) return true;
        try {
            const id = JSON.parse(fs.readFileSync(path.join(root, 'policy.bundle.json'), 'utf8')).key_id;
            return JSON.parse(fs.readFileSync(path.join(root, 'revocation_list.json'), 'utf8')).revoked_keys.includes(id);
        } catch { return true; }
    };
    if (staleKeys()) {
        console.log('No usable development keys found (or the bundle is signed by a revoked key); generating them (npm run keys:dev)…');
        const r = spawnSync(process.execPath, ['scripts/dev-keys.js', '--force'], { cwd: root, stdio: 'inherit' });
        if (r.status !== 0) process.exit(r.status || 1);
    }

    // key-guard builds its own keys. The other older "unit" suites read the database and policy bundle the stack uses,
    // so they run with the stack below.
    run('key-guard');
    for (const n of SELF) run(n);

    const stackNames = [...STACK, ...UNIT.filter((n) => n !== 'key-guard')].filter(wanted);
    if (stackNames.length) {
        if (!(await portFree(3000))) {
            console.error('\nPort 3000 is in use. Stop whatever is listening there (the stack suites need to start their own gateway).');
            process.exit(2);
        }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-stack-'));
        const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development', PORT: '3000', SAG_DB_PATH: path.join(tmp, 'stack.db'), LLM_API_KEY: '', OPENAI_API_KEY: '' } });
        let log = '';
        child.stdout.on('data', (d) => { log += d; });
        child.stderr.on('data', (d) => { log += d; });
        const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
        process.on('exit', stop);
        let up = false;
        for (let i = 0; i < 120 && !up; i++) {
            try { up = (await fetch('http://127.0.0.1:3000/api/health')).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
        }
        if (!up) { console.error('The gateway did not start:\n' + log.slice(-2000)); stop(); process.exit(1); }
        console.log('\nGateway for the stack suites is up on :3000 (throw-away database).');
        for (const n of STACK) run(n);
        for (const n of UNIT.filter((u) => u !== 'key-guard')) run(n);
        stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log('\n══ Summary ══');
    for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} suites passed${bad.length ? `; failed: ${bad.map((b) => b.name).join(', ')}` : ''}`);
    process.exit(bad.length ? 1 : 0);
})();
