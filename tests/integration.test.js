/**
 * Gateway Integration Tests v1.0
 *
 * Run:    node tests/integration.test.js
 * Requires: docker-compose up (Gateway running on localhost:3000)
 *
 * Tests the full enforcement surface via HTTP endpoints.
 * Zero dependencies. Real endpoints. No mocks.
 * Exit code 0 = all pass. Exit code 1 = failure.
 */

// ─── Constants (imported from risk engine, not magic numbers) ───
const { AUTO_BLOCK_THRESHOLD, ESCALATION_THRESHOLD } = require('../src/risk-engine');

const GATEWAY = 'http://localhost:3000';
const VALID_KEY = 'dwi_test_key_financeagent7';   // FinanceAgent-7 (trust: 74, role: finance)
const INVALID_KEY = 'this-key-does-not-exist';

let passed = 0;
let failed = 0;

function assert(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ ${name}`);
        failed++;
    }
}

async function post(path, body, headers = {}) {
    const res = await fetch(`${GATEWAY}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

async function get(path) {
    const res = await fetch(`${GATEWAY}${path}`);
    const data = await res.json();
    return { status: res.status, data };
}

async function run() {
    console.log('\n  Gateway Integration Tests v1.0');
    console.log(`  Target: ${GATEWAY}`);
    console.log(`  Thresholds: escalate ≥ ${ESCALATION_THRESHOLD}, auto-block ≥ ${AUTO_BLOCK_THRESHOLD}\n`);

    // ── 1. Health endpoint ──
    console.log('  Health:');
    const health = await get('/api/health');
    assert('GET /api/health → 200', health.status === 200);
    assert('Health version is 1.0.0', health.data.version === '1.0.0');
    assert('Health status is operational', health.data.status === 'operational');

    // ── 2. Authentication rejects unknown key ──
    console.log('\n  Authentication:');
    const authFail = await post('/api/gateway/execute', {
        agentApiKey: INVALID_KEY,
        tool: 'user.lookup',
        action: 'EXECUTE',
    });
    assert('Unknown key → HTTP 403', authFail.status === 403);
    assert('Unknown key → body.status DENIED', authFail.data.status === 'DENIED');
    assert('Unknown key → code AUTHENTICATION_FAILED', authFail.data.code === 'AUTHENTICATION_FAILED');

    // ── 3. Safe tool within scope → APPROVED ──
    // report.generate: trust(15) + tool_low(0) + EXECUTE(20) = 35 base, +10 off-hours = 45 max. Always < 60.
    console.log('\n  Policy — Allowed:');
    const safeReport = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'report.generate',
        action: 'EXECUTE',
        args: { type: 'quarterly', department: 'finance' },
    });
    assert('report.generate → HTTP 200', safeReport.status === 200);
    assert('report.generate → body.status APPROVED', safeReport.data.status === 'APPROVED');
    assert(`report.generate → risk < ${ESCALATION_THRESHOLD}`, safeReport.data.riskScore < ESCALATION_THRESHOLD);

    // ── 4. Out-of-scope tool → DENIED by policy ──
    console.log('\n  Policy — Denied:');
    const dbWrite = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'db.write',
        action: 'EXECUTE',
        args: { sql: 'DELETE FROM users' },
    });
    assert('db.write (finance) → HTTP 403', dbWrite.status === 403);
    assert('db.write → body.status DENIED', dbWrite.data.status === 'DENIED');
    assert('db.write → reason contains "lacks permission"', dbWrite.data.reason?.includes('lacks permission'));

    // ── 5. Small payment — decision depends on time-of-day (off-hours adds +10) ──
    // FinanceAgent-7: trust(15) + tool_critical(25) + EXECUTE(20) = 60 base
    // At off-hours: +10 = 70, so ESCALATED. During business hours: exactly 60, also ESCALATED.
    // payment.initiate is always at or above threshold for this agent.
    console.log('\n  Payload — Small Amount:');
    const smallPay = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 500, currency: 'USD', recipient: 'vendor-77' },
    });
    // Small payment from medium-trust agent on critical tool = escalated
    assert('$500 payment → HTTP 202 (escalated)', smallPay.status === 202);
    assert('$500 payment → body.status ESCALATED', smallPay.data.status === 'ESCALATED');
    assert(`$500 payment → risk ≥ ${ESCALATION_THRESHOLD}`, smallPay.data.riskScore >= ESCALATION_THRESHOLD);
    assert(`$500 payment → risk < ${AUTO_BLOCK_THRESHOLD}`, smallPay.data.riskScore < AUTO_BLOCK_THRESHOLD);

    // ── 6. Large payment → higher band (payload modifier +25 pushes toward auto-block) ──
    console.log('\n  Payload — Large Amount:');
    const bigPay = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 50000, currency: 'USD', recipient: 'vendor-acme' },
    });
    // $50k adds +25 payload modifier. Base 60 + 25 = 85. Off-hours: 95.
    // During business hours: exactly 85 = auto-block. Off-hours: 95 = auto-block.
    assert('$50k payment → HTTP 403', bigPay.status === 403);
    assert('$50k payment → body.status DENIED', bigPay.data.status === 'DENIED');
    assert('$50k payment → code RISK_AUTO_BLOCK', bigPay.data.code === 'RISK_AUTO_BLOCK');
    assert(`$50k payment → risk ≥ ${AUTO_BLOCK_THRESHOLD}`, bigPay.data.riskScore >= AUTO_BLOCK_THRESHOLD);

    // ── 7. Auto-block: $250k payment from low-trust agent with FINANCIAL classification ──
    // FinanceAgent-7 trust 74 → +15. payment.initiate critical → +25. EXECUTE → +20. $250k → +40. Total ≥ 85
    console.log('\n  Risk — Auto-Block:');
    const autoBlock = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 250000, currency: 'USD', recipient: 'hostile-vendor' },
        resource: {},
    });
    assert('$250k payment → HTTP 403', autoBlock.status === 403);
    assert('$250k payment → body.status DENIED', autoBlock.data.status === 'DENIED');
    assert('$250k payment → code RISK_AUTO_BLOCK', autoBlock.data.code === 'RISK_AUTO_BLOCK');
    assert(`$250k payment → risk ≥ ${AUTO_BLOCK_THRESHOLD}`, autoBlock.data.riskScore >= AUTO_BLOCK_THRESHOLD);

    // ── 8. Explain endpoint — structure and integrity ──
    console.log('\n  Explain:');
    const explain = await post('/api/explain', {
        agentKey: VALID_KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 50000 },
    });
    assert('Explain → HTTP 200', explain.status === 200);
    assert('Explain → has decision field', typeof explain.data.decision === 'string');
    assert('Explain → has risk.factors array', Array.isArray(explain.data.risk?.factors));
    assert('Explain → has risk.thresholds', explain.data.risk?.thresholds != null);
    assert('Explain → thresholds match constants',
        explain.data.risk.thresholds.autoBlock === AUTO_BLOCK_THRESHOLD &&
        explain.data.risk.thresholds.escalation === ESCALATION_THRESHOLD
    );

    // Factor sum integrity
    const factorSum = explain.data.risk.factors.reduce((s, f) => s + f.weight, 0);
    assert('Explain → sum(factor weights) === risk.score', factorSum === explain.data.risk.score);

    // Payload modifier present
    const hasPayloadFactor = explain.data.risk.factors.some(f => f.factor === 'payload_modifier');
    assert('Explain → payload_modifier factor present for $50k', hasPayloadFactor);

    // Policy fields
    assert('Explain → policy.allowed is true (finance can initiate payments)', explain.data.policy?.allowed === true);
    assert('Explain → policy.bundleHash exists', typeof explain.data.policy?.bundleHash === 'string');

    // ── 9. Trace ID consistency ──
    console.log('\n  Trace:');
    assert('APPROVED response has traceId', typeof safeReport.data.traceId === 'string');
    assert('ESCALATED response has traceId', typeof smallPay.data.traceId === 'string');
    assert('DENIED (policy) response has traceId', typeof dbWrite.data.traceId === 'string');
    assert('DENIED (auto-block) response has traceId', typeof autoBlock.data.traceId === 'string');

    // ── Results ──
    console.log(`\n  ─────────────────────────────────────`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`  ─────────────────────────────────────\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('\n  ✖ Fatal:', err.message);
    console.error('  Is the gateway running? Try: docker-compose up\n');
    process.exit(1);
});
