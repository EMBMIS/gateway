/**
 * Data vault: persistent master key, per-person erasure, production guard.
 * Run: node tests/vault.test.js   (no running gateway required)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function assert(name, ok) {
    if (ok) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ ${name}`); failed++; }
}

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-vault-'));
const db = path.join(tmp, 'vault.db');
const masterKey = crypto.randomBytes(32).toString('hex');

// Each step runs in its own process, so "restart" means exactly that.
function step(code, env = {}) {
    const out = execFileSync(process.execPath, ['-e', `const v=require('./src/vault');const log=(x)=>console.log(JSON.stringify(x));${code}`], {
        cwd: root, encoding: 'utf8', env: { ...process.env, SAG_DB_PATH: db, SAG_VAULT_MASTER_KEY: masterKey, ...env },
    });
    return JSON.parse(out.trim().split('\n').pop());
}

console.log('\n  Vault\n');
const stored = step(`
  const a=v.storeAsset({name:'File A',classification:'PII',subject:'Alice@Example.com',data:{n:1}});
  const b=v.storeAsset({name:'File B',classification:'PII',subject:'bob@example.com',data:{n:2}});
  const c=v.storeAsset({name:'No subject',classification:'PII',data:{n:3}});
  log({a:a.id,b:b.id,c:c.id});`);

const afterRestart = step(`log({a:v.retrieveAsset('${stored.a}','agent-1').data, b:v.retrieveAsset('${stored.b}','agent-1').data})`);
assert('assets are readable after a restart with the same master key', afterRestart.a.n === 1 && afterRestart.b.n === 2);

const wrongKey = step(`log(v.retrieveAsset('${stored.a}','agent-1'))`, { SAG_VAULT_MASTER_KEY: crypto.randomBytes(32).toString('hex') });
assert('a different master key cannot decrypt', !!wrongKey.error);

const raw = JSON.stringify(step(`log(v.listAssets())`));
assert('the listing never exposes the subject', !/alice|bob/i.test(raw));

const erased = step(`log(v.processErasure('alice@example.com'))`);
assert('erasure finds the person case-insensitively and reports one asset', erased.assetsAffected === 1 && erased.status === 'completed');

const after = step(`log({a:v.retrieveAsset('${stored.a}','agent-1').data, b:v.retrieveAsset('${stored.b}','agent-1').data, c:v.retrieveAsset('${stored.c}','agent-1').data})`);
assert("the person's asset is destroyed", after.a.erased === true && after.a.n === undefined);
assert("other people's and unlabelled assets are untouched", after.b.n === 2 && after.c.n === 3);

const nobody = step(`log(v.processErasure('nobody@example.com'))`);
assert('erasing someone with no assets affects nothing', nobody.assetsAffected === 0);

let threw = false;
try { step(`v.processErasure('  ')`); } catch { threw = true; }
assert('an empty identifier is rejected', threw);

// Production: no master key means no start.
const guard = (extra) => {
    try {
        execFileSync(process.execPath, ['-e', `require('./src/keys').assertKeysSafe('gateway')`], { cwd: root, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production', SAG_SECRETS_DIR: tmp, SAG_VAULT_MASTER_KEY: '', ...extra } });
        return { ok: true, err: '' };
    } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; }
};
const noKey = guard({});
assert('production refuses to start without a vault master key', !noKey.ok && /vault-master/.test(noKey.err));
const badKey = guard({ SAG_VAULT_MASTER_KEY: 'tooshort' });
assert('a malformed master key is rejected', !badKey.ok && /vault-master/.test(badKey.err));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
