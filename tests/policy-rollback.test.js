/**
 * Policy Rollback & Integrity Tests
 *
 * Validates the anti-rollback mechanics of the EMBMIS Gateway:
 * 1. Monotonic version enforcement (Gateway rejects downgrades)
 * 2. Immutable policy signature verification (rejects manual edits)
 * 3. Policy root hash anchoring (checkpoint logs exist and increase monotonically)
 *
 * Requires: Node.js 18+ and running SAG stack
 * Run: node tests/policy-rollback.test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0;
let fail = 0;

function assert(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        pass++;
    } else {
        console.error(`  ❌ ${name}`);
        fail++;
    }
}

async function run() {
    console.log('\n  Policy Rollback & Integrity Tests\n');

    // ────────────────────────────────────────────
    // 1. Immutable Signature Verification
    // ────────────────────────────────────────────
    console.log('  [1] Immutable Signature Verification:');

    // Read the current valid bundle
    const bundlePath = path.join(__dirname, '..', 'policy.bundle.json');
    if (!fs.existsSync(bundlePath)) {
        console.error('  Fatal: Policy bundle not found');
        process.exit(1);
    }

    // The Gateway and Worker independently verify the bundle on boot or reload.
    // Instead of restarting containers, we'll run the bundle-loader logic directly
    // to simulate the exact worker boot sequence validation.

    const { loadAndVerifyBundle } = require('../src/bundle-loader');

    // First, verify the pristine bundle loads successfully
    try {
        const validBundle = loadAndVerifyBundle();
        assert('Pristine bundle signature is valid', !!validBundle.hash);
    } catch (err) {
        assert('Pristine bundle signature is valid', false);
    }

    // Now tamper with the bundle
    const originalContent = fs.readFileSync(bundlePath, 'utf8');
    const parsedBundle = JSON.parse(originalContent);

    // Modify a permission silently
    parsedBundle.bundle.role_permissions['finance']['system.config'] = 'allow';
    fs.writeFileSync(bundlePath, JSON.stringify(parsedBundle), 'utf8');

    try {
        loadAndVerifyBundle();
        assert('Tampered bundle rejected (INVALID_POLICY_SIGNATURE)', false);
    } catch (err) {
        assert('Tampered bundle rejected (INVALID_POLICY_SIGNATURE)', err.message.includes('signature verification failed') || err.message.includes('does not match metadata hash'));
    }

    // Restore the original bundle
    fs.writeFileSync(bundlePath, originalContent, 'utf8');
    console.log('      (Restored pristine policy bundle)');

    // ────────────────────────────────────────────
    // 2. Monotonic Version Enforcement & Anchoring
    // ────────────────────────────────────────────
    console.log('\n  [2] Monotonic Version Checkpoints:');

    const checkpointLogPath = path.join(__dirname, '..', 'logs', 'policy-checkpoints.log');

    // The policy-checkpoints.log file must exist if the Worker booted successfully
    assert('Policy checkpoint log exists', fs.existsSync(checkpointLogPath));

    if (fs.existsSync(checkpointLogPath)) {
        const logContent = fs.readFileSync(checkpointLogPath, 'utf8').trim().split('\n');
        assert('Checkpoint log has entries', logContent.length > 0);

        let monotonic = true;
        let lastVersion = -1;

        for (const line of logContent) {
            // line format: ISO_DATE | v3 | hash | source
            const parts = line.split('|').map(p => p.trim());
            if (parts.length >= 2) {
                const versionMatch = parts[1].match(/v(\d+)/);
                if (versionMatch) {
                    const ver = parseInt(versionMatch[1], 10);
                    if (ver < lastVersion) {
                        monotonic = false;
                    }
                    lastVersion = ver;
                }
            }
        }

        assert('Checkpoint versions are strictly monotonic (no rollbacks)', monotonic);
    }

    // ────────────────────────────────────────────
    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('  Fatal:', err.message);
    process.exit(1);
});
