const fs = require('fs');
const path = require('path');
const { verifyChain } = require('../../src/audit-logger');

async function verifyAuditLedger(options) {
    if (!options.json) {
        console.log('Validating cryptographic integrity of the audit ledger...');
    }

    const verification = verifyChain();

    // 1. Verify internal db chain
    if (!verification.valid) {
        if (options.json) {
            console.log(JSON.stringify(verification, null, 2));
            process.exit(1);
        }
        console.error('\n❌ CHAIN_INTEGRITY_FAILURE');
        console.error(`   Processed ${verification.entriesChecked} entries.`);
        console.error(`   Found ${verification.errors.length} integrity violations!`);
        console.error('\nDetails:');
        verification.errors.forEach(err => {
            console.error(`  - Seq ${err.seq}: ${err.error} (Expected: ${err.expected}, Got: ${err.got})`);
        });
        process.exit(1);
    }

    // 2. Verify external checkpoints
    const CHECKPOINT_FILE = path.join(process.env.SAG_LOG_DIR ? path.resolve(process.env.SAG_LOG_DIR) : path.join(__dirname, '..', '..', 'logs'), 'audit-checkpoints.log');
    let checkpointsVerified = 0;
    let checkpointErrors = [];

    if (fs.existsSync(CHECKPOINT_FILE)) {
        const content = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);

        for (const line of lines) {
            const parts = line.split(' | ');
            if (parts.length >= 3) {
                const seq = parseInt(parts[1].split('=')[1], 10);
                const hash = parts[2].split('=')[1].trim();

                const expectedHash = verification.checkpointHashes[seq];
                if (expectedHash) {
                    if (expectedHash !== hash) {
                        checkpointErrors.push(`Seq ${seq}: Checkpoint mismatch (Expected: ${expectedHash}, Got: ${hash})`);
                    } else {
                        checkpointsVerified++;
                    }
                }
            }
        }
    }

    if (checkpointErrors.length > 0) {
        if (options.json) {
            verification.checkpointErrors = checkpointErrors;
            console.log(JSON.stringify(verification, null, 2));
            process.exit(1);
        }
        console.error('\n❌ EXTERNAL_CHECKPOINT_FAILURE');
        console.error(`   Found ${checkpointErrors.length} checkpoint mismatches!`);
        checkpointErrors.forEach(err => console.error(`  - ${err}`));
        process.exit(1);
    }

    if (options.json) {
        verification.checkpointsVerified = checkpointsVerified;
        console.log(JSON.stringify(verification, null, 2));
        process.exit(0);
    }

    console.log('\n✅ Ledger Integrity Verified');
    console.log(`   Processed ${verification.entriesChecked} DB entries.`);
    console.log(`   Anchored against ${checkpointsVerified} external checkpoints.`);
    console.log(`   Chain Head Hash: ${verification.lastHash}`);
    process.exit(0);
}

module.exports = verifyAuditLedger;
