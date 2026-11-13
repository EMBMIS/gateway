/**
 * Clock Skew & TTL Protection Tests
 *
 * Validates Phase 1.4: Strict NTP drift tolerance
 * The enclave worker must explicitly reject tickets if the issuer's clock
 * is off by more than MAX_CLOCK_SKEW (500ms), in either direction.
 *
 * Run: node tests/clock-skew.test.js
 * Requires: docker-compose up
 */

const crypto = require('crypto');
const path = require('path');
const grpcClient = require('../src/grpc-client');
const { loadAndVerifyBundle } = require('../src/bundle-loader');

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

async function run() {
    console.log('\n  Clock Skew & TTL Protection Tests\n');

    // Initialize the gRPC client to talk directly to the worker
    const WORKER_ADDRESS = process.env.ENCLAVE_ADDRESS || 'localhost:50051';
    grpcClient.init(WORKER_ADDRESS);

    // Give it a moment to connect
    await new Promise(r => setTimeout(r, 500));

    // Store the real Date.now
    const realDateNow = Date.now.bind(Date);

    // Base ticket details
    const ticketArgs = {
        agentId: 'QA_AGENT',
        agentRole: 'finance',
        tool: 'user.lookup',
        action: 'EXECUTE',
        args: { userId: '123' },
        policy_bundle_hash: loadAndVerifyBundle().hash,
        risk_score: 10,
        traceId: 'test-trace',
        spanId: 'gateway-01',
        parentSpanId: 'sdk-req'
    };

    // ────────────────────────────────────────────
    // 1. Synchronized Clocks (Baseline)
    // ────────────────────────────────────────────
    try {
        const res = await grpcClient.execute(ticketArgs);
        assert('Baseline execution (clocks in sync) succeeds', res.success === true);
    } catch (err) {
        assert('Baseline execution (clocks in sync) succeeds', false);
        console.error('      Failed with:', err.message);
    }

    // ────────────────────────────────────────────
    // 2. Gateway Clock in the PAST (>500ms)
    // ────────────────────────────────────────────
    Date.now = () => realDateNow() - 5000; // Fake gateway clock 5s behind worker
    try {
        await grpcClient.execute({ ...ticketArgs, traceId: 'test-past' });
        assert('Rejects ticket if Gateway clock is in the past (>500ms)', false);
    } catch (err) {
        assert('Rejects ticket if Gateway clock is in the past (>500ms)', err.message.includes('CLOCK_SKEW_DETECTED'));
    }

    // ────────────────────────────────────────────
    // 3. Gateway Clock in the FUTURE (>500ms)
    // ────────────────────────────────────────────
    Date.now = () => realDateNow() + 5000; // Fake gateway clock 5s ahead of worker
    try {
        await grpcClient.execute({ ...ticketArgs, traceId: 'test-future' });
        assert('Rejects ticket if Gateway clock is in the future (>500ms)', false);
    } catch (err) {
        assert('Rejects ticket if Gateway clock is in the future (>500ms)', err.message.includes('CLOCK_SKEW_DETECTED'));
    }

    // Restore real Date.now
    Date.now = realDateNow;

    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('  Fatal:', err.message);
    process.exit(1);
});
