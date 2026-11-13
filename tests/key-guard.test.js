/**
 * Key material + production startup guard.
 * Run: node tests/key-guard.test.js   (no running gateway required)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-keys-'));
const secrets = path.join(tmp, 'secrets');
const vault = path.join(tmp, 'vault');
const bundle = path.join(tmp, 'policy.bundle.json');
const leaked = path.join(__dirname, 'fixtures', 'leaked');

function freshKeys() {
    process.env.SAG_SECRETS_DIR = secrets;
    process.env.KMS_VAULT_DIR = vault;
    process.env.SAG_BUNDLE_PATH = bundle;
    fs.rmSync(secrets, { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(root, 'scripts', 'dev-keys.js'), '--force'], { stdio: 'pipe', env: { ...process.env, NODE_ENV: 'development' } });
}
function load() {
    for (const m of Object.keys(require.cache)) if (m.endsWith(path.join('src', 'keys.js'))) delete require.cache[m];
    return require('../src/keys');
}

console.log('\n  Key guard tests\n');

console.log('  [1] Generated dev keys are accepted in production:');
freshKeys();
process.env.NODE_ENV = 'production';
let keys = load();
for (const role of ['gateway', 'worker']) {
    const r = keys.checkKeys(role);
    assert(`${role}: no errors with freshly generated keys`, r.errors.length === 0);
}
let threw = false;
try { keys.assertKeysSafe('gateway'); } catch { threw = true; }
assert('assertKeysSafe passes in production with good keys', !threw);

console.log('\n  [2] Missing key material is refused in production:');
fs.unlinkSync(path.join(secrets, 'gateway-ed25519.key'));
keys = load();
let err = null;
try { keys.assertKeysSafe('gateway'); } catch (e) { err = e; }
assert('missing gateway private key → refuses to start', err && /Missing gateway-private/.test(err.message));
assert('error tells the operator what to provide', err && /SAG_GATEWAY_ED25519_KEY/.test(err.message));

console.log('\n  [3] Keys from environment variables:');
freshKeys();
const pem = fs.readFileSync(path.join(secrets, 'gateway-ed25519.key'), 'utf8');
fs.unlinkSync(path.join(secrets, 'gateway-ed25519.key'));
process.env.SAG_GATEWAY_ED25519_KEY = Buffer.from(pem).toString('base64');
keys = load();
assert('base64 PEM from env is accepted', keys.checkKeys('gateway').errors.length === 0);
process.env.SAG_GATEWAY_ED25519_KEY = pem.replace(/\n/g, '\\n');
keys = load();
assert('PEM with escaped newlines from env is accepted', keys.checkKeys('gateway').errors.length === 0);
delete process.env.SAG_GATEWAY_ED25519_KEY;

console.log('\n  [4] Keys that were committed to the repository are refused:');
freshKeys();
fs.copyFileSync(path.join(leaked, 'gateway-ed25519.pub'), path.join(secrets, 'gateway-ed25519.pub'));
keys = load();
let r = keys.checkKeys('worker');
assert('old gateway Ed25519 key refused (worker role)', r.errors.some(e => /gateway-public .*committed to the repository/.test(e)));
err = null; try { keys.assertKeysSafe('worker'); } catch (e) { err = e; }
assert('production startup throws for the old key', !!err && /Refusing to start in production/.test(err.message));

freshKeys();
fs.copyFileSync(path.join(leaked, 'ca-cert.pem'), path.join(secrets, 'ca-cert.pem'));
keys = load();
assert('old mTLS CA refused (gateway role)', keys.checkKeys('gateway').errors.some(e => /tls-ca-cert .*committed/.test(e)));

freshKeys();
const oldPolicyPub = path.join(leaked, 'alias_policy-authority-v0.4_public.pem');
// The leaked public key, standing in for whichever key id the bundle names.
const bundleKeyId = JSON.parse(fs.readFileSync(bundle, 'utf8')).key_id;
fs.copyFileSync(oldPolicyPub, path.join(secrets, `${bundleKeyId.replace('/', '_')}_public.pem`));
keys = load();
assert('old policy authority key refused', keys.checkKeys('gateway').errors.some(e => /leaked key/.test(e)));
const { loadAndVerifyBundle } = require('../src/bundle-loader');
err = null; try { loadAndVerifyBundle(); } catch (e) { err = e; }
assert('bundle loader refuses it in production', !!err && /leaked key/.test(err.message));

console.log('\n  [5] Outside production a leaked key only warns:');
process.env.NODE_ENV = 'development';
keys = load();
threw = false; try { keys.assertKeysSafe('gateway'); } catch { threw = true; }
assert('development: assertKeysSafe does not throw', !threw);

console.log('\n  [6] Mismatched keypair:');
freshKeys();
process.env.NODE_ENV = 'production';
const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(path.join(secrets, 'gateway-ed25519.pub'), other);
keys = load();
assert('gateway private/public mismatch refused', keys.checkKeys('gateway').errors.some(e => /does not match/.test(e)));

console.log('\n  [7] Repository hygiene:');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = tracked.filter(f => /(\.pem|\.key|\.db|\.db-shm|\.db-wal|\.log)$/.test(f) && !f.startsWith('tests/fixtures/leaked/'));
assert(`no private keys, databases or logs tracked (${bad.join(', ') || 'none'})`, bad.length === 0);
const leakedPrivate = tracked.filter(f => /^(certs|\.kms-vault)\//.test(f));
assert('certs/ and .kms-vault/ are empty in git', leakedPrivate.length === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
