const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const KMS_PORT = 4000;
// DEV ONLY. Private key lives in KMS_VAULT_DIR (default .kms-vault, gitignored); never commit it.
const KEYS_DIR = process.env.KMS_VAULT_DIR || path.join(__dirname, '..', '.kms-vault');
const PUBLIC_CERTS_DIR = require('../src/keys').secretsDir();

if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
}
if (!fs.existsSync(PUBLIC_CERTS_DIR)) {
    fs.mkdirSync(PUBLIC_CERTS_DIR, { recursive: true });
}

// In a real KMS, keys are named by ID (uuid). For dev, we use a static ID
const KEY_ID = process.env.SAG_POLICY_KEY_ID || 'alias/policy-authority-dev';
const privPath = path.join(KEYS_DIR, `${KEY_ID.replace('/', '_')}_private.pem`);
const pubPath = path.join(PUBLIC_CERTS_DIR, `${KEY_ID.replace('/', '_')}_public.pem`);

let privateKey, publicKey;

// Auto-generate or load the KMS key
if (fs.existsSync(privPath)) {
    console.log(`[Mock KMS] Loading existing keypair for ${KEY_ID}`);
    privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
    publicKey = crypto.createPublicKey(fs.readFileSync(pubPath));
} else {
    console.log(`[Mock KMS] Generating new Ed25519 keypair for ${KEY_ID}`);
    const keypair = crypto.generateKeyPairSync('ed25519');
    privateKey = keypair.privateKey;
    publicKey = keypair.publicKey;

    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
}

console.log(`[Mock KMS] Public key published to ${pubPath}`);

// ─── KMS API ───

// AWS KMS Sign API mock
app.post('/kms/sign', (req, res) => {
    try {
        const { KeyId, Message, MessageType } = req.body;

        if (KeyId !== KEY_ID) {
            return res.status(400).json({ __type: "NotFoundException", message: "Key not found" });
        }

        // AWS KMS takes base64 encoded payload
        const messageBuffer = Buffer.from(Message, 'base64');

        // Sign using Ed25519
        const signature = crypto.sign(null, messageBuffer, privateKey);

        res.json({
            KeyId: KEY_ID,
            Signature: signature.toString('base64'),
            SigningAlgorithm: 'Ed25519'
        });

    } catch (err) {
        console.error('[Mock KMS] Signing error:', err);
        res.status(500).json({ error: err.message });
    }
});

// For public key verification retrieval
app.get('/kms/public-keys', (req, res) => {
    res.json({
        keys: [
            { id: KEY_ID, public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
        ]
    });
});

app.listen(KMS_PORT, () => {
    console.log(`\n===========================================`);
    console.log(`  [Mock AWS KMS] Service running on :${KMS_PORT}`);
    console.log(`  Private keys securely stored in .kms-vault/`);
    console.log(`===========================================\n`);
});
