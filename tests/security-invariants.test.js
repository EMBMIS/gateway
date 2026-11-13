/**
 * Security Invariants Test (Phase 4.5)
 * 
 * Structural assertions that verify the architecture hasn't been weakened.
 * These read source code to confirm critical security checks exist in the right order.
 * 
 * Run: node tests/security-invariants.test.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function assert(name, condition, detail) {
    if (condition) {
        console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
        pass++;
    } else {
        console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
        fail++;
    }
}

function readSource(file) {
    return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

async function runTests() {
    console.log('\n  Security Invariants — Structural Verification\n');

    const worker = readSource('enclave-worker.js');
    const riskEngine = readSource('src/risk-engine.js');
    const auditLogger = readSource('src/audit-logger.js');
    const gateway = readSource('src/gateway.js');
    const bundleLoader = readSource('src/bundle-loader.js');
    const teeEnclave = readSource('src/tee-enclave.js');

    // ────────────────────────────────────────────
    // Invariant 1: Worker MUST verify signature before executing
    // ────────────────────────────────────────────
    const sigCheckIdx = worker.indexOf('verifySignature(ticket)');
    const executeIdx = worker.indexOf('executeInEnclave(');
    assert('Invariant 1: verifySignature called BEFORE executeInEnclave',
        sigCheckIdx > 0 && executeIdx > 0 && sigCheckIdx < executeIdx,
        `sig@${sigCheckIdx} < exec@${executeIdx}`);

    // ────────────────────────────────────────────
    // Invariant 2: Worker MUST check TTL before executing
    // ────────────────────────────────────────────
    const ttlCheckIdx = worker.indexOf('TICKET_EXPIRED');
    assert('Invariant 2: TTL check exists before execution',
        ttlCheckIdx > 0 && ttlCheckIdx < executeIdx,
        `ttl@${ttlCheckIdx} < exec@${executeIdx}`);

    // ────────────────────────────────────────────
    // Invariant 3: Policy bundle signature verified before evaluation
    // ────────────────────────────────────────────
    assert('Invariant 3: Bundle loader verifies Ed25519 signature',
        bundleLoader.includes('crypto.verify') || bundleLoader.includes('verifySignature'),
        'crypto.verify found in bundle-loader.js');

    // ────────────────────────────────────────────
    // Invariant 4: Risk score capped at 100 in risk engine
    // ────────────────────────────────────────────
    assert('Invariant 4: Risk score capped at 100',
        riskEngine.includes('Math.min') && riskEngine.includes('100'),
        'Math.min(100, ...) found in risk-engine.js');

    // ────────────────────────────────────────────
    // Invariant 5: Ledger entry always includes prev_hash
    // ────────────────────────────────────────────
    assert('Invariant 5: Audit logger computes and stores prev_hash',
        auditLogger.includes('prevHash') && auditLogger.includes('last_audit_hash'),
        'prev_hash chain found in audit-logger.js');

    // ────────────────────────────────────────────
    // Invariant 6: Nonce checked before execution in Worker
    // ────────────────────────────────────────────
    const nonceCheckIdx = worker.indexOf('NONCE_REPLAY');
    assert('Invariant 6: Nonce replay protection before execution',
        nonceCheckIdx > 0 && nonceCheckIdx < executeIdx,
        `nonce@${nonceCheckIdx} < exec@${executeIdx}`);

    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal Test Error:', err);
    process.exit(1);
});
