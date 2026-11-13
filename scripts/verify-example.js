/**
 * Full E2E verification: hit every example app endpoint, capture results, run assertions.
 */
async function verify() {
    const results = {};

    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, data: await r.json() };
    }

    // 1. Safe tool: generate-report
    results['1_generate_report'] = await post('http://localhost:4001/generate-report', { type: 'quarterly', department: 'finance' });

    // 2. Lookup customer
    results['2_lookup_customer'] = await post('http://localhost:4001/lookup-customer', { id: 'customer-9281' });

    // 3. Small payment $500
    results['3_payment_500'] = await post('http://localhost:4001/send-payment', { amount: 500, currency: 'USD', recipient: 'vendor-77' });

    // 4. Large payment $50k
    results['4_payment_50k'] = await post('http://localhost:4001/send-payment', { amount: 50000, currency: 'USD', recipient: 'vendor-acme' });

    // 5. Explain $50k
    const eRes = await fetch('http://localhost:4001/explain?tool=payment.initiate&amount=50000');
    results['5_explain'] = { status: eRes.status, data: await eRes.json() };

    // 6. Direct explain via gateway for cross-check
    results['6_gateway_explain'] = await post('http://localhost:3000/api/explain', {
        agentKey: 'dwi_test_key_financeagent7',
        tool: 'payment.initiate', action: 'EXECUTE', args: { amount: 50000 }
    });

    // Save raw responses
    require('fs').writeFileSync('verification-output.json', JSON.stringify(results, null, 2));

    // ── Run assertions ──
    let pass = 0, fail = 0;
    function assert(n, c) { if (c) { console.log('  \u2705 ' + n); pass++ } else { console.error('  \u274C ' + n); fail++ } }

    console.log('\n  Full E2E Verification\n');

    // [1] generate-report
    console.log('  [1] generate-report (safe tool):');
    assert('HTTP 200', results['1_generate_report'].status === 200);
    assert('status APPROVED', results['1_generate_report'].data.sag.status === 'APPROVED');
    assert('risk < 60', results['1_generate_report'].data.sag.risk < 60);
    assert('toolResult present', results['1_generate_report'].data.toolResult != null);
    assert('traceId present', typeof results['1_generate_report'].data.sag.traceId === 'string');

    // [2] lookup-customer
    console.log('\n  [2] lookup-customer:');
    const lc = results['2_lookup_customer'];
    assert('HTTP 200', lc.status === 200);
    assert('toolResult present', lc.data.toolResult != null);
    assert('customer name present', lc.data.toolResult.name === 'Jane Chen');
    assert('traceId present', typeof lc.data.sag.traceId === 'string');

    // [3] $500 payment
    console.log('\n  [3] payment $500 (ESCALATED):');
    assert('HTTP 202', results['3_payment_500'].status === 202);
    assert('status ESCALATED', results['3_payment_500'].data.sag.status === 'ESCALATED');
    assert('risk >= 60', results['3_payment_500'].data.sag.risk >= 60);
    assert('risk < 85', results['3_payment_500'].data.sag.risk < 85);
    assert('toolResult null (held)', results['3_payment_500'].data.toolResult === null);
    assert('reason present', typeof results['3_payment_500'].data.sag.reason === 'string');

    // [4] $50k payment
    console.log('\n  [4] payment $50k (AUTO-BLOCKED):');
    assert('HTTP 403', results['4_payment_50k'].status === 403);
    assert('status DENIED', results['4_payment_50k'].data.sag.status === 'DENIED');
    assert('risk >= 85', results['4_payment_50k'].data.sag.risk >= 85);
    assert('toolResult null', results['4_payment_50k'].data.toolResult === null);
    assert('reason present', typeof results['4_payment_50k'].data.sag.reason === 'string');

    // [5] explain via example app
    console.log('\n  [5] explain (via example app):');
    const ex = results['5_explain'].data;
    assert('HTTP 200', results['5_explain'].status === 200);
    assert('decision present', typeof ex.decision === 'string');
    assert('risk.factors array', Array.isArray(ex.risk?.factors));
    assert('thresholds present', ex.risk?.thresholds?.autoBlock === 85 && ex.risk?.thresholds?.escalation === 60);
    const fsum = (ex.risk?.factors || []).reduce((s, f) => s + f.weight, 0);
    assert('sum(factors) === risk.score', fsum === ex.risk?.score);
    assert('payload_modifier present', (ex.risk?.factors || []).some(f => f.factor === 'payload_modifier'));

    // [6] gateway explain cross-check
    console.log('\n  [6] gateway explain (direct cross-check):');
    const gx = results['6_gateway_explain'].data;
    assert('HTTP 200', results['6_gateway_explain'].status === 200);
    assert('decision matches example', gx.decision === ex.decision);
    assert('risk score matches example', gx.risk?.score === ex.risk?.score);
    assert('policy.bundleHash present', typeof gx.policy?.bundleHash === 'string');
    assert('agent.name is FinanceAgent-7', gx.agent?.name === 'FinanceAgent-7');

    console.log('\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    console.log('  Results: ' + pass + ' passed, ' + fail + ' failed');
    console.log('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');
    process.exit(fail > 0 ? 1 : 0);
}

verify().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
