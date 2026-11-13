/**
 * SAG CLI — `sag revoke <key_id>`
 * 
 * Safely appends a key_id to the local CRL (revocation_list.json).
 * Requires confirmation unless --force is passed.
 */
const fs = require('fs');
const readline = require('readline');
const config = require('../lib/config');

async function revokeCommand(keyId, options) {
    // Validate key_id format (must start with alias/ or be a reasonable identifier)
    if (!keyId || keyId.length < 3) {
        console.error('\n  Error: Invalid key_id. Provide a valid KMS key identifier.\n');
        process.exit(1);
    }

    // Load current CRL
    let crl = { revoked_keys: [] };
    try {
        crl = JSON.parse(fs.readFileSync(config.crlPath, 'utf8'));
    } catch {
        console.log('  No existing CRL found. Creating new revocation list.');
    }

    // Check for duplicate
    if (crl.revoked_keys.includes(keyId)) {
        console.log(`\n  Key '${keyId}' is already in the revocation list.\n`);
        process.exit(0);
    }

    // Confirmation gate
    if (!options.force) {
        console.log(`\n  ⚠  WARNING: You are about to revoke signing key '${keyId}'.`);
        console.log(`  Any Enclave Worker loading a bundle signed by this key will CRASH on boot.`);
        console.log(`  This action is immediate and cannot be undone without editing the CRL manually.\n`);

        const confirmed = await askConfirmation('  Are you sure? (yes/no): ');
        if (!confirmed) {
            console.log('  Revocation cancelled.\n');
            process.exit(0);
        }
    }

    // Append and write
    crl.revoked_keys.push(keyId);
    fs.writeFileSync(config.crlPath, JSON.stringify(crl, null, 2), 'utf8');

    console.log(`\n  ✔ Key '${keyId}' added to revocation list.`);
    console.log(`  CRL now contains ${crl.revoked_keys.length} revoked key(s).`);
    console.log(`  Path: ${config.crlPath}`);
    console.log(`\n  ⚠  Restart the Enclave Worker to enforce this revocation.\n`);
}

function askConfirmation(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        });
    });
}

module.exports = revokeCommand;
