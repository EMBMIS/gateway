#!/usr/bin/env node
/**
 * npm run keys:prod -- <output-dir>
 *
 * Generates the key material a production deployment needs, on a machine you trust, split by who may hold what:
 *
 *   <dir>/gateway-secrets/   mount read-only into the gateway (SAG_SECRETS_DIR): its ticket-signing key, the worker's
 *                            PUBLIC key, the mTLS client identity, the CA certificate, the policy public key
 *   <dir>/worker-secrets/    the same for each enclave worker: its own response-signing key, the gateway's PUBLIC key,
 *                            the mTLS server identity, the CA certificate, the policy public key
 *   <dir>/policy/            policy.bundle.json (signed, public) and revocation_list.json: mount into both
 *   <dir>/OFFLINE/           the policy-authority private key and the CA private key. NEVER mount these. Move them
 *                            somewhere only you can reach; you need them again only to sign a new bundle or issue certificates.
 *
 * The gateway and a worker never see each other's private keys, so compromising one does not let an attacker forge
 * the other's signatures. It refuses to overwrite an existing directory, and every key it makes is checked against
 * the leaked-key list.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const keys = require('../src/keys');

const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target) { console.error('Usage: npm run keys:prod -- <output-dir> [--key-id alias/name] [--version N]'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const dir = path.resolve(target);
if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error(`${dir} is not empty. Choose a new directory; this tool never overwrites keys.`); process.exit(1); }

const stamp = new Date().toISOString().slice(0, 10);
const keyId = arg('key-id', `alias/policy-authority-${stamp}`);
const version = parseInt(arg('version', '1'), 10);
const safe = keyId.replace('/', '_');
const stage = path.join(dir, '.stage');
const gw = path.join(dir, 'gateway-secrets');
const wk = path.join(dir, 'worker-secrets');
const policy = path.join(dir, 'policy');
const offline = path.join(dir, 'OFFLINE');
for (const d of [stage, gw, wk, policy, offline]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

const env = { ...process.env, SAG_SECRETS_DIR: stage };
execFileSync(process.execPath, [path.join(__dirname, 'generate-ed25519-keys.js')], { env, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'generate-certs.js')], { env, stdio: 'inherit' });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPath = path.join(offline, `${safe}_private.pem`);
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const policyPub = publicKey.export({ type: 'spki', format: 'pem' });
fs.copyFileSync(path.join(__dirname, '..', 'revocation_list.json'), path.join(policy, 'revocation_list.json'));

const put = (from, toDir, mode) => { const to = path.join(toDir, path.basename(from)); fs.copyFileSync(from, to); fs.chmodSync(to, mode); };
const S = (f) => path.join(stage, f);
for (const f of ['gateway-ed25519.key', 'client-key.pem']) put(S(f), gw, 0o600);
for (const f of ['worker-ed25519.pub', 'client-cert.pem', 'ca-cert.pem']) put(S(f), gw, 0o644);
for (const f of ['worker-ed25519.key', 'server-key.pem']) put(S(f), wk, 0o600);
for (const f of ['gateway-ed25519.pub', 'server-cert.pem', 'ca-cert.pem']) put(S(f), wk, 0o644);
for (const d of [gw, wk]) fs.writeFileSync(path.join(d, `${safe}_public.pem`), policyPub);
// The vault's master key. Gateway only. Losing it makes every vault asset unreadable: back it up with the database.
fs.writeFileSync(path.join(gw, 'vault-master.key'), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
put(S('ca-key.pem'), offline, 0o600);
fs.rmSync(stage, { recursive: true, force: true });

execFileSync(process.execPath, [path.join(__dirname, 'sign-bundle.js'), '--key', privPath, '--key-id', keyId, '--version', String(version), '--out', path.join(policy, 'policy.bundle.json')], { stdio: 'inherit' });

for (const d of [gw, wk, offline]) {
    for (const f of fs.readdirSync(d)) {
        if (!/\.(pem|key|pub)$/.test(f)) continue;
        const leaked = keys.compromisedMatch(fs.readFileSync(path.join(d, f)));
        if (leaked) { console.error(`Generated ${f} matches a leaked key (${leaked}). This should be impossible.`); process.exit(1); }
    }
}
// Each side must pass the production guard on its own.
for (const [role, d] of [['gateway', gw], ['worker', wk]]) {
    const saved = { s: process.env.SAG_SECRETS_DIR, b: process.env.SAG_BUNDLE_PATH };
    process.env.SAG_SECRETS_DIR = d;
    process.env.SAG_BUNDLE_PATH = path.join(policy, 'policy.bundle.json');
    const { errors } = keys.checkKeys(role);
    process.env.SAG_SECRETS_DIR = saved.s; if (saved.b === undefined) delete process.env.SAG_BUNDLE_PATH; else process.env.SAG_BUNDLE_PATH = saved.b;
    if (errors.length) { console.error(`The ${role} key set did not pass the production guard:\n  - ${errors.join('\n  - ')}`); process.exit(1); }
}

console.log(`
Done. Keys are in ${dir}

  1. Move ${offline} somewhere only you can reach (a password manager, an encrypted drive, an HSM).
     It holds the policy-authority key and the CA key. Delete it from this machine afterwards.
     To publish a changed policy:  node scripts/sign-bundle.js --key ${path.join('OFFLINE', `${safe}_private.pem`)} --key-id ${keyId} --version ${version + 1} --out policy/policy.bundle.json
  2. Copy gateway-secrets/, worker-secrets/ and policy/ to the server (DEPLOY.md has the compose file).
  3. The mTLS certificates are valid for one year. Calendar the renewal: run this tool into a new directory and roll
     the gateway and the workers together.
`);
