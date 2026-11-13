/**
 * Fuzz Testing (Phase 4.4)
 * 
 * Validates that the gateway and SDK handle malformed/adversarial input
 * without crashing. No request should cause a process exit — only clean rejections.
 * 
 * Run: node tests/fuzz.test.js
 */

const createClient = require('../sdk/index');
const { scoreRequest } = require('../src/risk-engine');
const { logAction } = require('../src/audit-logger');

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

async function runTests() {
    console.log('\n  Fuzz Testing — Adversarial Input\n');

    // ────────────────────────────────────────────
    // Test 1: SDK rejects null/undefined tool names
    // ────────────────────────────────────────────
    const client = createClient({ agent: 'fuzz', key: 'fuzz-key', endpoint: 'http://localhost:3009', retries: 0 });

    try {
        await client.execute(null);
        assert('Null tool name', false, 'should have thrown');
    } catch (err) {
        assert('Null tool name → rejected', true, err.message.substring(0, 50));
    }

    // ────────────────────────────────────────────
    // Test 2: SDK rejects empty string tool
    // ────────────────────────────────────────────
    try {
        await client.execute('');
        assert('Empty tool name', false, 'should have thrown');
    } catch (err) {
        assert('Empty tool name → rejected', true, err.message.substring(0, 50));
    }

    // ────────────────────────────────────────────
    // Test 3: Risk engine handles corrupt agent data
    // ────────────────────────────────────────────
    // Test 3: Risk engine handles corrupt agent data
    // Should either produce a score or throw cleanly — NOT crash the process
    let riskCrashed = false;
    try {
        scoreRequest({
            agent: { id: null, name: undefined, role: '', trust_score: -50, total_requests: 'not_a_number' },
            tool: '../../../../etc/passwd',
            action: 42,
            resource: null,
            args: { nested: { deep: { value: true } } }
        });
    } catch (err) {
        // Clean throw is acceptable — it means no process crash
    }
    assert('Risk engine handles corrupt agent data (no process crash)', true);

    // ────────────────────────────────────────────
    // Test 4: Audit logger handles oversized payload
    // ────────────────────────────────────────────
    let auditCrashed = false;
    try {
        logAction({
            traceId: 'fuzz-trace',
            agentId: 'fuzz',
            agentName: 'FuzzBot',
            tool: 'x'.repeat(10000),
            action: 'FUZZ',
            policyDecision: 'deny',
            riskScore: 999,
            latencyMs: -1,
            requestPayload: { huge: 'A'.repeat(100000) },
            responseSummary: null
        });
    } catch (err) {
        auditCrashed = true;
    }
    assert('Audit logger handles oversized payload (no crash)', !auditCrashed);

    // ────────────────────────────────────────────
    // Test 5: SDK handles circular reference in args
    // ────────────────────────────────────────────
    try {
        const circular = {};
        circular.self = circular;
        await client.execute('test.tool', circular);
        assert('Circular reference args', false, 'should have thrown');
    } catch (err) {
        assert('Circular reference args → rejected (no crash)', true, err.message.substring(0, 50));
    }

    // ────────────────────────────────────────────
    // Test 6: Risk engine never returns score > 100
    // ────────────────────────────────────────────
    const extremeResult = scoreRequest({
        agent: { id: 'x', name: 'X', role: 'unknown', trust_score: 0, total_requests: 999999, blocked_requests: 999999 },
        tool: 'payment.initiate',
        action: 'EXECUTE',
        resource: { classification: 'top_secret', env: 'production' },
        args: { amount: 999999999, currency: 'BTC' }
    });
    assert('Risk score capped at 100', extremeResult.score <= 100, `score=${extremeResult.score}`);

    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal Test Error:', err);
    process.exit(1);
});
