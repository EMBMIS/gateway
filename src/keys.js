/**
 * EMBMIS Gateway — key material provider and startup guard.
 *
 * Private keys are NEVER read from the repository. Each secret comes from, in order:
 *   1. an environment variable (PEM text, or base64 of the PEM), or
 *   2. a file in the secrets directory: $SAG_SECRETS_DIR, default <repo>/certs
 *      (mount a read-only secrets volume there in production).
 *
 * `npm run keys:dev` generates a fresh set for local development.
 *
 * Production guard (NODE_ENV=production): refuses to start when key material is missing,
 * malformed, mismatched, or matches one of the keys that were once committed to this
 * repository (compared by public-key SHA-256 fingerprint). See SECURITY-ROTATION.md.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** name → { env var, file name in the secrets dir, kind } */
const SECRETS = {
    'gateway-private':  { env: 'SAG_GATEWAY_ED25519_KEY', file: 'gateway-ed25519.key', kind: 'private' },
    'gateway-public':   { env: 'SAG_GATEWAY_ED25519_PUB', file: 'gateway-ed25519.pub', kind: 'public' },
    'worker-private':   { env: 'SAG_WORKER_ED25519_KEY',  file: 'worker-ed25519.key',  kind: 'private' },
    'worker-public':    { env: 'SAG_WORKER_ED25519_PUB',  file: 'worker-ed25519.pub',  kind: 'public' },
    'tls-ca-cert':      { env: 'SAG_TLS_CA_CERT',         file: 'ca-cert.pem',         kind: 'cert' },
    'tls-server-cert':  { env: 'SAG_TLS_SERVER_CERT',     file: 'server-cert.pem',     kind: 'cert' },
    'tls-server-key':   { env: 'SAG_TLS_SERVER_KEY',      file: 'server-key.pem',      kind: 'private' },
    'tls-client-cert':  { env: 'SAG_TLS_CLIENT_CERT',     file: 'client-cert.pem',     kind: 'cert' },
    'tls-client-key':   { env: 'SAG_TLS_CLIENT_KEY',      file: 'client-key.pem',      kind: 'private' },
    'vault-master':     { env: 'SAG_VAULT_MASTER_KEY',    file: 'vault-master.key',    kind: 'symmetric' },
};

/** What each process needs. The policy public key is added separately (depends on the bundle's key_id). */
const ROLE_SECRETS = {
    gateway: ['gateway-private', 'worker-public', 'tls-ca-cert', 'tls-client-cert', 'tls-client-key'],
    worker:  ['worker-private', 'gateway-public', 'tls-ca-cert', 'tls-server-cert', 'tls-server-key'],
};

/**
 * SHA-256 fingerprints (of the SPKI public key) of every key that has been committed to this
 * repository. They are public-key hashes, so listing them here discloses nothing.
 * A production process refuses to run with any of them. Do not remove entries.
 */
const COMPROMISED_FINGERPRINTS = new Map([
    ['9bc37037082eb6bab5a69bf5873bb9f642fb9e83febdd582258def6be78c6fd7', 'certs/ca-key.pem (mTLS root CA)'],
    ['b070d705611c610dd70ed777b4bc28923353286b0a8a8a7f90ae1e57e7c02c42', 'certs/client-key.pem (gateway mTLS client)'],
    ['b3a22c4a7e36b953d2f6017861f0eeca506955ccd33a85d74e301e4fbe8007b5', 'certs/server-key.pem (enclave mTLS server)'],
    ['d98aa00665f9291ef114ab6a4ceb4c0ec66f957499effce96e9d61cbbff1db90', 'certs/gateway-ed25519.key (ticket signing)'],
    ['be425457fc4104fb248f3087bf8ff731e366765b2ff24a9e4e908f9c00da829c', 'certs/worker-ed25519.key (response signing)'],
    ['f48a72656410702d571daf3107638d4dc217035d4b638c07e323695b0f92399e', 'policy_private.pem (policy signing)'],
    ['5a9fef4fdc3f3ab7edac2772ebba796c83b181cbbc5878d95fdcafbaca2d55f3', '.kms-vault/alias_policy-authority-v0.4_private.pem (policy authority)'],
]);

class KeyError extends Error {
    constructor(message) { super(message); this.name = 'KeyError'; this.code = 'KEY_MATERIAL'; }
}

function secretsDir() {
    return process.env.SAG_SECRETS_DIR ? path.resolve(process.env.SAG_SECRETS_DIR) : path.join(ROOT, 'certs');
}

/** Signed policy bundle location (override with SAG_BUNDLE_PATH). */
function bundlePath() {
    return process.env.SAG_BUNDLE_PATH ? path.resolve(process.env.SAG_BUNDLE_PATH) : path.join(ROOT, 'policy.bundle.json');
}

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

/** Accepts PEM text or base64-encoded PEM (handy for env vars). */
function decodeMaybeBase64(text) {
    const trimmed = text.trim();
    if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n') + '\n';
    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
        if (decoded.includes('-----BEGIN')) return decoded.trim() + '\n';
    } catch { /* fall through */ }
    return trimmed;
}

/** Returns the secret as a Buffer, or null when it is not provided. */
function readSecret(name) {
    const spec = SECRETS[name];
    if (!spec) throw new Error(`Unknown secret '${name}'`);
    const fromEnv = process.env[spec.env];
    if (fromEnv && fromEnv.trim()) return Buffer.from(decodeMaybeBase64(fromEnv), 'utf8');
    const file = path.join(secretsDir(), spec.file);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    return null;
}

function describeSource(name) {
    const spec = SECRETS[name];
    return `env ${spec.env} or ${path.join(secretsDir(), spec.file)}`;
}

function requireSecret(name) {
    const buf = readSecret(name);
    if (!buf) {
        throw new KeyError(`Missing key material '${name}'. Provide ${describeSource(name)}. For local development run: npm run keys:dev`);
    }
    return buf;
}

/** Public-key fingerprint of a PEM private key, public key or certificate. */
function fingerprint(pem) {
    const text = Buffer.isBuffer(pem) ? pem.toString('utf8') : String(pem);
    let publicKey;
    if (text.includes('BEGIN CERTIFICATE')) {
        publicKey = new crypto.X509Certificate(text).publicKey;
    } else if (text.includes('PRIVATE KEY')) {
        publicKey = crypto.createPublicKey(crypto.createPrivateKey(text));
    } else {
        publicKey = crypto.createPublicKey(text);
    }
    return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Returns the label of the leaked key this material matches, or null. */
function compromisedMatch(pem) {
    return COMPROMISED_FINGERPRINTS.get(fingerprint(pem)) || null;
}

function policyKeyId() {
    try {
        const artifact = JSON.parse(fs.readFileSync(bundlePath(), 'utf8'));
        return artifact.key_id || null;
    } catch { return null; }
}

/** Public key (PEM) that verifies the policy bundle signed under `keyId`. */
function readPolicyPublicKey(keyId) {
    if (process.env.SAG_POLICY_PUBLIC_KEY && process.env.SAG_POLICY_PUBLIC_KEY.trim()) {
        return decodeMaybeBase64(process.env.SAG_POLICY_PUBLIC_KEY);
    }
    const file = path.join(secretsDir(), `${String(keyId).replace('/', '_')}_public.pem`);
    if (!fs.existsSync(file)) {
        throw new KeyError(`Missing policy public key for key_id '${keyId}'. Provide env SAG_POLICY_PUBLIC_KEY or ${file}`);
    }
    return fs.readFileSync(file, 'utf8');
}

/**
 * The vault's master key: 32 random bytes, hex (64 chars) or base64. Returns a Buffer, or null when absent.
 * Throws KeyError when present but malformed. Losing it makes every vault asset unreadable: back it up with the data.
 */
function readVaultMasterKey() {
    const raw = readSecret('vault-master');
    if (!raw) return null;
    const text = raw.toString('utf8').trim();
    const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
    if (key.length !== 32) {
        throw new KeyError(`vault-master must be 32 random bytes as hex or base64 (${describeSource('vault-master')}). Generate one with: openssl rand -hex 32`);
    }
    return key;
}

/**
 * Inspect the key material a process needs.
 * @param {'gateway'|'worker'} role
 * @returns {{errors: string[], warnings: string[]}}
 */
function checkKeys(role) {
    const errors = [];
    const warnings = [];
    const names = ROLE_SECRETS[role];
    if (!names) throw new Error(`Unknown role '${role}'`);

    const loaded = {};
    for (const name of names) {
        const buf = readSecret(name);
        if (!buf) { errors.push(`Missing ${name}: provide ${describeSource(name)}`); continue; }
        try {
            const fp = fingerprint(buf);
            loaded[name] = fp;
            const leaked = COMPROMISED_FINGERPRINTS.get(fp);
            if (leaked) errors.push(`${name} is a key that was committed to the repository (${leaked}). Rotate it: see SECURITY-ROTATION.md`);
        } catch (e) {
            errors.push(`${name} is not valid key material: ${e.message}`);
        }
    }

    // The policy bundle must verify under a key that was not leaked.
    const keyId = policyKeyId();
    if (!keyId) {
        errors.push('Missing policy.bundle.json (or it has no key_id). Compile one with `sag compile`, or `npm run keys:dev` for development');
    } else {
        try {
            const fp = fingerprint(readPolicyPublicKey(keyId));
            const leaked = COMPROMISED_FINGERPRINTS.get(fp);
            if (leaked) errors.push(`Policy public key for '${keyId}' belongs to a leaked key (${leaked}). Re-sign the bundle with a new key: see SECURITY-ROTATION.md`);
        } catch (e) {
            errors.push(e.message);
        }
    }

    // The vault master key (gateway only). Production must have one; elsewhere the vault falls back to a throw-away key.
    if (role === 'gateway' && isProduction()) {
        try {
            if (!readVaultMasterKey()) errors.push(`Missing vault-master: provide ${describeSource('vault-master')} (openssl rand -hex 32). Back it up with the database.`);
        } catch (e) { errors.push(e.message); }
    }

    // Own keypair consistency, when both halves are available (worker checks its own; gateway its own).
    const own = role === 'gateway' ? ['gateway-private', 'gateway-public'] : ['worker-private', 'worker-public'];
    const pub = readSecret(own[1]);
    if (loaded[own[0]] && pub) {
        try {
            if (fingerprint(pub) !== loaded[own[0]]) errors.push(`${own[0]} does not match ${own[1]}`);
        } catch { /* reported when that key is loaded */ }
    }
    return { errors, warnings };
}

/**
 * Startup guard. In production it throws on any problem. Elsewhere it only warns about leaked keys
 * (missing keys fail naturally when first used, with a message pointing at `npm run keys:dev`).
 */
function assertKeysSafe(role) {
    const { errors } = checkKeys(role);
    if (errors.length === 0) return;
    if (isProduction()) {
        const err = new KeyError(`Refusing to start in production:\n  - ${errors.join('\n  - ')}`);
        err.errors = errors;
        throw err;
    }
    for (const e of errors) {
        if (e.includes('committed to the repository') || e.includes('leaked key')) {
            console.warn(`[KEYS] ⚠️  ${e}  (refused in production)`);
        }
    }
}

module.exports = {
    secretsDir, bundlePath, isProduction, readSecret, readVaultMasterKey, requireSecret, readPolicyPublicKey, policyKeyId,
    fingerprint, compromisedMatch, checkKeys, assertKeysSafe,
    COMPROMISED_FINGERPRINTS, SECRETS, ROLE_SECRETS, KeyError,
};
