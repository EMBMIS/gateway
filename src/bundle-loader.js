const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const keys = require('./keys');
const BUNDLE_PATH = keys.bundlePath();

// Consistent with policy-compiler.js
function canonicalize(obj) {
    if (obj === undefined) {
        throw new Error('Undefined values not allowed in policy bundle canonicalization.');
    }
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj) || 'null';
    }

    if (Array.isArray(obj)) {
        const arrElements = obj.map(item => canonicalize(item));
        return `[${arrElements.join(',')}]`;
    }

    const sortedKeys = Object.keys(obj).sort();
    const objElements = sortedKeys.map(key => {
        return `${JSON.stringify(key)}:${canonicalize(obj[key])}`;
    });

    return `{${objElements.join(',')}}`;
}

function loadAndVerifyBundle() {
    console.log('[BundleLoader] Loading policy bundle artifact...');

    if (!fs.existsSync(BUNDLE_PATH)) {
        throw new Error('CRITICAL: Missing policy.bundle.json. Cannot start secure boundary.');
    }

    const artifact = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
    // Validate wrapper structure
    if (!artifact.bundle || !artifact.metadata || !artifact.signature || !artifact.key_id) {
        throw new Error('CRITICAL: Malformed policy bundle artifact. Missing required fields.');
    }

    const CRL_PATH = process.env.SAG_CRL_PATH ? path.resolve(process.env.SAG_CRL_PATH) : path.join(__dirname, '..', 'revocation_list.json');
    if (!fs.existsSync(CRL_PATH)) {
        throw new Error('CRITICAL: Missing revocation_list.json. Cannot establish trust boundary without CRL.');
    }
    const crl = JSON.parse(fs.readFileSync(CRL_PATH, 'utf8'));
    if (crl.revoked_keys && crl.revoked_keys.includes(artifact.key_id)) {
        throw new Error(`CRITICAL: Signing key '${artifact.key_id}' is REVOKED. Boot sequence arbitrarily aborted.`);
    }

    // Public key from env SAG_POLICY_PUBLIC_KEY or <secrets dir>/<key_id>_public.pem
    const publicKeyPem = keys.readPolicyPublicKey(artifact.key_id);
    const leaked = keys.compromisedMatch(publicKeyPem);
    if (leaked) {
        const msg = `Policy public key for '${artifact.key_id}' belongs to a leaked key (${leaked}). Re-sign the bundle with a new key: see SECURITY-ROTATION.md`;
        if (keys.isProduction()) throw new Error(`CRITICAL: ${msg}`);
        console.warn(`[BundleLoader] ⚠️  ${msg}`);
    }

    // 1. Serialize deterministic payload
    const canonicalString = canonicalize(artifact.bundle);

    // 2. Hash payload
    const computedHash = crypto.createHash('sha256').update(canonicalString).digest('hex');

    // 3. Verify hash against metadata (Sanity check)
    // metadata.policy_bundle_hash is informational and validated, but NOT trusted unless signature verification passes.
    if (computedHash.length !== artifact.metadata.policy_bundle_hash.length ||
        !crypto.timingSafeEqual(Buffer.from(computedHash, 'utf8'), Buffer.from(artifact.metadata.policy_bundle_hash, 'utf8'))) {
        throw new Error(`CRITICAL: Computed payload hash does not match metadata hash.\nComputed: ${computedHash}\nMetadata: ${artifact.metadata.policy_bundle_hash}`);
    }

    // 4. Verify Signature cryptographically
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const signatureBuffer = Buffer.from(artifact.signature, 'base64');

    const isValid = crypto.verify(
        null,
        Buffer.from(canonicalString, 'utf8'),
        publicKey,
        signatureBuffer
    );

    if (!isValid) {
        throw new Error('CRITICAL: Ed25519 signature verification failed! Policy bundle has been tampered with or signed by unknown authority.');
    }

    console.log(`[BundleLoader] Signature verified via Ed25519. Hash: ${computedHash.substring(0, 8)}...`);

    return {
        bundle: artifact.bundle,
        hash: computedHash,
        metadata: artifact.metadata
    };
}

module.exports = { loadAndVerifyBundle };
