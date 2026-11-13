/**
 * Demo: Protect an AI agent with SAG in 30 seconds
 *
 * Run:   node sdk/demo.js
 * Needs: docker-compose up (SAG running on localhost:3000)
 */
const sag = require('./')({
    agent: 'FinanceAgent-7',
    key: 'dwi_test_key_financeagent7',
    onDecision: (r) => {
        const icon = r.allowed ? '✅' : r.status === 'ESCALATED' ? '⚠️' : '🚫';
        const riskBar = r.riskScore != null
            ? `${'█'.repeat(Math.round(r.riskScore / 5))}${'░'.repeat(20 - Math.round(r.riskScore / 5))} ${r.riskScore}/100`
            : '';
        console.log(`    ${icon}  ${r.status.padEnd(10)} ${riskBar}`);
        if (r.reason && !r.allowed) console.log(`       Reason: ${r.reason}`);
    },
});

async function main() {
    console.log('\n  ╔═══════════════════════════════════════════╗');
    console.log('  ║   SAG SDK Demo — AI Agent Guardrails       ║');
    console.log('  ║   Agent: FinanceAgent-7                    ║');
    console.log('  ╚═══════════════════════════════════════════╝\n');

    // ── 1. Safe: generate a report — low risk, always approved ──
    console.log('  [1] report.generate — Creating quarterly summary');
    await sag.execute('report.generate', { type: 'quarterly', department: 'finance' });

    // ── 2. Medium: $500 payment — escalated (critical tool + EXECUTE) ──
    console.log('\n  [2] payment.initiate — Wire transfer $500');
    await sag.execute('payment.initiate', { amount: 500, currency: 'USD', recipient: 'vendor-77' });

    // ── 3. Dangerous: $50k payment — auto-blocked (payload modifier) ──
    console.log('\n  [3] payment.initiate — Wire transfer $50,000');
    await sag.execute('payment.initiate', { amount: 50000, currency: 'USD', recipient: 'vendor-acme' });

    // ── 4. Denied: db.write — role lacks permission ──
    console.log('\n  [4] db.write — DELETE FROM employee_records');
    await sag.execute('db.write', { sql: 'DELETE FROM employee_records' });

    // ── 5. Explain: why was $50k blocked? ──
    console.log('\n  ─────────────────────────────────────────────');
    console.log('  [EXPLAIN] Why was the $50,000 payment blocked?\n');
    const explanation = await sag.explain('payment.initiate', { amount: 50000 });
    console.log(`    Decision:  ${explanation.decision}`);
    console.log(`    Risk:      ${explanation.risk.score}/100`);
    console.log(`    Policy:    ${explanation.policy.allowed ? 'ALLOWED' : 'DENIED'} (${explanation.policy.reason})`);
    console.log(`    Factors:`);
    for (const f of explanation.risk.factors) {
        console.log(`      +${String(f.weight).padStart(2)}  ${f.detail}`);
    }
    console.log(`    Thresholds: escalate ≥ ${explanation.risk.thresholds.escalation}, auto-block ≥ ${explanation.risk.thresholds.autoBlock}`);

    console.log('\n  ─────────────────────────────────────────────');
    console.log('  Dashboard: http://localhost:3000');
    console.log('  ─────────────────────────────────────────────\n');
}

main().catch(err => {
    console.error('\n  ✖ Error:', err.message);
    if (err.code === 'NETWORK_ERROR') {
        console.error('  Is SAG running? Try: docker-compose up\n');
    }
    process.exit(1);
});
