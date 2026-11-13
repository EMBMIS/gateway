/**
 * SDK Reliability & Failure Modes Tests
 * Validates Phase 2.2 and 2.3
 */
const http = require('http');
const createClient = require('../sdk/index');

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
    console.log('\n  SDK Reliability & Failure Modes\n');

    // ────────────────────────────────────────────
    // Test 1 & 2: Gateway Down (Connection Refused)
    // ────────────────────────────────────────────
    const clientDownOpen = createClient({ agent: 'QA', key: 'TEST', endpoint: 'http://localhost:3009', failOpen: true, retries: 0 });
    const res1 = await clientDownOpen.execute('db.query');
    assert('Gateway Down + failOpen:true → FAIL_OPEN', res1.status === 'FAIL_OPEN' && res1.allowed === true);

    const clientDownClosed = createClient({ agent: 'QA', key: 'TEST', endpoint: 'http://localhost:3009', failOpen: false, retries: 0 });
    try {
        await clientDownClosed.execute('db.query');
        assert('Gateway Down + failOpen:false → NETWORK_ERROR (Should have thrown, but did not)', false);
    } catch (err) {
        assert('Gateway Down + failOpen:false → NETWORK_ERROR', err.code === 'NETWORK_ERROR');
    }

    // ────────────────────────────────────────────
    // Test 3: Retries + Slow Gateway
    // ────────────────────────────────────────────
    let attemptCount = 0;
    const slowServer = http.createServer((req, res) => {
        attemptCount++;
        // Do not respond immediately to simulate timeout
    });

    await new Promise(resolve => slowServer.listen(3015, resolve));

    // timeout=10ms, retries=2 => 3 attempts total. We want fast retries for tests
    const clientSlow = createClient({ agent: 'QA', key: 'TEST', endpoint: 'http://localhost:3015', timeout: 50, retries: 2, retryBaseDelay: 10, failOpen: false });

    try {
        await clientSlow.execute('db.query');
        assert('Slow Gateway → Rejects gracefully (Did not throw)', false);
    } catch (err) {
        assert('Slow Gateway → Retries exhausted to exactly configured retries + 1', attemptCount === 3);
    }

    slowServer.close();

    // ────────────────────────────────────────────
    // Test 5, 6, 7: Input Validation (Phase 2.3)
    // ────────────────────────────────────────────
    const clientValid = createClient({ agent: 'QA', key: 'TEST', endpoint: 'http://localhost:3000' });

    // Test 7: INVALID_TOOL_NAME
    const longName = 't'.repeat(129);
    try {
        await clientValid.execute(longName);
        assert('Tool name > 128 chars → INVALID_TOOL_NAME (Failed to throw)', false);
    } catch (err) {
        assert('Tool name > 128 chars → INVALID_TOOL_NAME', err.code === 'INVALID_TOOL_NAME');
    }

    // Test 6: PAYLOAD_TOO_DEEP
    const deepObj = { level1: { level2: { level3: { level4: { level5: { level6: { level7: { level8: { level9: { level10: { level11: "too deep!" } } } } } } } } } } };
    try {
        await clientValid.execute('db.query', deepObj);
        assert('Nested arg depth > 10 → PAYLOAD_TOO_DEEP (Failed to throw)', false);
    } catch (err) {
        assert('Nested arg depth > 10 → PAYLOAD_TOO_DEEP', err.code === 'PAYLOAD_TOO_DEEP');
    }

    // Test 5: PAYLOAD_TOO_LARGE
    const largeObj = { data: 'A'.repeat(1048576) };
    try {
        await clientValid.execute('db.query', largeObj);
        assert('Payload > 1MB → PAYLOAD_TOO_LARGE (Failed to throw)', false);
    } catch (err) {
        assert('Payload > 1MB → PAYLOAD_TOO_LARGE', err.code === 'PAYLOAD_TOO_LARGE');
    }

    // Test 8: Circuit Breaker Validation
    const clientCB = createClient({ agent: 'QA', key: 'TEST', endpoint: 'http://localhost:3009', circuitBreakerFailures: 2, retries: 0 });
    try { await clientCB.execute('db.query'); } catch (e) { } // 1 failure
    try { await clientCB.execute('db.query'); } catch (e) { } // 2 failures -> Circuit breaks

    let circuitCaught = false;
    try {
        await clientCB.execute('db.query'); // Should fail instantly with CIRCUIT_OPEN
    } catch (err) {
        if (err.code === 'CIRCUIT_OPEN') circuitCaught = true;
    }
    assert('Circuit Breaker triggers after N failures', circuitCaught);

    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal Test Error:', err);
    process.exit(1);
});
