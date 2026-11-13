#!/usr/bin/env node
/**
 * Sign the policy bundle with a policy-authority private key you hold (offline, or in your own tooling).
 *
 *   node scripts/sign-bundle.js --key policy-authority/alias_policy-authority-2026-10-09_private.pem \
 *        --key-id alias/policy-authority-2026-10-09 --version 7 --out policy.bundle.json
 *
 * Run it on an admin machine, not on the gateway host: the host only ever needs the public key and the signed
 * bundle. Bundle versions must increase: workers refuse a bundle older than the highest they have seen.
 * With a real KMS or HSM use `sag compile` instead; this is for installations that keep the key in a file.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
}

const keyFile = arg('key');
const keyId = arg('key-id', process.env.SAG_POLICY_KEY_ID);
const version = parseInt(arg('version', process.env.BUNDLE_VERSION || ''), 10);
const out = path.resolve(arg('out', 'policy.bundle.json'));

if (!keyFile || !keyId || !Number.isInteger(version) || version < 1) {
    console.error('Usage: node scripts/sign-bundle.js --key <private.pem> --key-id <alias/name> --version <integer> [--out policy.bundle.json]');
    process.exit(1);
}
if (keyId === 'alias/policy-authority-v0.4') {
    console.error('That key id belongs to the key that leaked and is revoked. Use a new one.');
    process.exit(1);
}

process.env.BUNDLE_VERSION = String(version);
const { canonicalize, buildPolicyLogic } = require('../src/policy-compiler');
const keys = require('../src/keys');

const pem = fs.readFileSync(keyFile);
const leaked = keys.compromisedMatch(pem);
if (leaked) { console.error(`That key is one that was committed to the repository (${leaked}). Generate a new one.`); process.exit(1); }
const privateKey = crypto.createPrivateKey(pem);

const bundle = buildPolicyLogic();
const canonical = canonicalize(bundle);
const artifact = {
    metadata: { version: '1.0.0', compiler_version: '0.4.0', created_at: new Date().toISOString(), policy_bundle_hash: crypto.createHash('sha256').update(canonical).digest('hex') },
    bundle,
    signature: crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
    key_id: keyId,
};
fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
console.log(`Signed bundle v${bundle.version} with ${keyId} → ${out}`);
