#!/usr/bin/env node
/**
 * npm run keys:dev — generate a complete set of DEVELOPMENT key material.
 *
 * Writes (all gitignored):
 *   <secrets dir>/            gateway/worker Ed25519 keys, mTLS CA + server + client certs,
 *                             policy authority public key       (SAG_SECRETS_DIR, default certs/)
 *   .kms-vault/               the dev policy-authority private key (KMS_VAULT_DIR)
 *   policy.bundle.json        policy bundle signed with that key
 *
 * Refuses to overwrite existing keys unless --force is given.
 * These keys are for local development only. Production keys come from env vars or a mounted
 * secrets directory (see DEPLOY.md / SECURITY-ROTATION.md).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const keys = require('../src/keys');

const root = path.join(__dirname, '..');
const force = process.argv.includes('--force');
const dir = keys.secretsDir();
const vault = process.env.KMS_VAULT_DIR || path.join(root, '.kms-vault');
const { canonicalize, buildPolicyLogic, KEY_ID, BUNDLE_PATH } = require('../src/policy-compiler');
const safeId = KEY_ID.replace('/', '_');
const privPath = path.join(vault, `${safeId}_private.pem`);
const pubPath = path.join(dir, `${safeId}_public.pem`);

if (keys.isProduction()) {
    console.error('keys:dev is for development only and refuses to run with NODE_ENV=production.');
    process.exit(1);
}

const existing = [privPath, pubPath, path.join(dir, 'gateway-ed25519.key'), path.join(dir, 'ca-cert.pem')].filter(fs.existsSync);
if (existing.length && !force) {
    console.log('Key material already exists; nothing changed. Use `npm run keys:dev -- --force` to regenerate.');
    process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(vault, { recursive: true });

const run = (script) => execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit', env: process.env });
run('generate-ed25519-keys.js');
run('generate-certs.js');
const vaultKeyPath = path.join(dir, 'vault-master.key');
if (!fs.existsSync(vaultKeyPath)) fs.writeFileSync(vaultKeyPath, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });

// Policy authority keypair + signed bundle
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

const bundle = buildPolicyLogic();
const canonical = canonicalize(bundle);
const artifact = {
    metadata: {
        version: '1.0.0',
        compiler_version: '0.4.0',
        created_at: new Date().toISOString(),
        policy_bundle_hash: crypto.createHash('sha256').update(canonical).digest('hex'),
    },
    bundle,
    signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
    key_id: KEY_ID,
};
fs.writeFileSync(BUNDLE_PATH, JSON.stringify(artifact, null, 2));

// Never leave a leaked key behind by accident.
for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!/\.(pem|key|pub)$/.test(f) || f === 'vault-master.key') continue;
    const leaked = keys.compromisedMatch(fs.readFileSync(full));
    if (leaked) { console.error(`Generated file ${full} matches a leaked key (${leaked}) — this should be impossible.`); process.exit(1); }
}

console.log(`\nDev keys written to ${dir} (policy authority private key in ${vault}).`);
console.log('Signed policy bundle written to policy.bundle.json. Start the gateway with: npm start');
