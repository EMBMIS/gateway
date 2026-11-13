#!/usr/bin/env node
/**
 * Generate Ed25519 keypairs for Gateway and Worker.
 *
 * Usage:   node scripts/generate-ed25519-keys.js
 * Output:  certs/gateway-ed25519.key, certs/gateway-ed25519.pub
 *          certs/worker-ed25519.key,  certs/worker-ed25519.pub
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CERTS_DIR = require('../src/keys').secretsDir();

function generateKeypair(name) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const privPath = path.join(CERTS_DIR, `${name}-ed25519.key`);
    const pubPath = path.join(CERTS_DIR, `${name}-ed25519.pub`);

    fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey);

    console.log(`  ✅ ${name}: ${privPath}`);
    console.log(`     public:  ${pubPath}`);
}

if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
}

console.log('\n  Generating Ed25519 Keypairs\n');
generateKeypair('gateway');
generateKeypair('worker');
console.log('\n  Done. Mount these into Docker containers:\n');
console.log('    Gateway: needs gateway-ed25519.key (sign) + worker-ed25519.pub (verify responses)');
console.log('    Worker:  needs worker-ed25519.key (sign) + gateway-ed25519.pub (verify tickets)\n');
