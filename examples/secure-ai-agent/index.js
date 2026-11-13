/**
 * Secure AI Agent in 5 Minutes
 *
 * This is a simple Express server that wraps 3 "AI agent tools"
 * through the EMBMIS Gateway enforcement layer.
 *
 * Every tool call goes through sag.execute() — SAG decides
 * whether the action is allowed, escalated, or denied.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your SAG credentials
 *   2. npm install
 *   3. node index.js
 *   4. curl http://localhost:4001/lookup-customer?id=customer-9281
 */
const express = require('express');

// ─── Load env ───
const env = {
    SAG_ENDPOINT: process.env.SAG_ENDPOINT || 'http://localhost:3000',
    SAG_AGENT: process.env.SAG_AGENT || 'FinanceAgent-7',
    SAG_KEY: process.env.SAG_KEY || 'dwi_test_key_financeagent7',
};

// ─── Initialize SAG SDK ───
const sag = require('@sag/node')({
    agent: env.SAG_AGENT,
    key: env.SAG_KEY,
    endpoint: env.SAG_ENDPOINT,
    failOpen: false,
});

// ─── Simulated tool functions (replace with your real logic) ───
function lookupCustomer(id) {
    return { id, name: 'Jane Chen', email: 'jane@acmecorp.io', tier: 'enterprise' };
}

function generateReport(type, department) {
    return { reportId: `RPT-${Date.now()}`, type, department, pages: 12, generatedAt: new Date().toISOString() };
}

function sendPayment(amount, currency, recipient) {
    return { txId: `TX-${Date.now()}`, amount, currency, recipient, timestamp: new Date().toISOString() };
}

// ─── Express app ───
const app = express();
app.use(express.json());

/**
 * POST /lookup-customer
 * Safe tool — should be APPROVED.
 */
app.post('/lookup-customer', async (req, res) => {
    const { id } = req.body;
    const decision = await sag.execute('user.lookup', { userId: id });

    if (decision.blocked) {
        return res.status(403).json({
            toolResult: null,
            sag: { status: decision.status, risk: decision.riskScore, reason: decision.reason },
        });
    }

    const result = lookupCustomer(id);
    res.json({
        toolResult: result,
        sag: { status: decision.status, risk: decision.riskScore, traceId: decision.traceId },
    });
});

/**
 * POST /generate-report
 * Safe tool — should be APPROVED.
 */
app.post('/generate-report', async (req, res) => {
    const { type, department } = req.body;
    const decision = await sag.execute('report.generate', { type, department });

    if (decision.blocked) {
        return res.status(403).json({
            toolResult: null,
            sag: { status: decision.status, risk: decision.riskScore, reason: decision.reason },
        });
    }

    const result = generateReport(type || 'quarterly', department || 'finance');
    res.json({
        toolResult: result,
        sag: { status: decision.status, risk: decision.riskScore, traceId: decision.traceId },
    });
});

/**
 * POST /send-payment
 * Risk varies with amount:
 *   $500    → ESCALATED (critical tool)
 *   $50,000 → AUTO-BLOCKED (payload modifier)
 */
app.post('/send-payment', async (req, res) => {
    const { amount, currency, recipient } = req.body;
    const decision = await sag.execute('payment.initiate', {
        amount: amount || 0,
        currency: currency || 'USD',
        recipient: recipient || 'unknown',
    });

    if (decision.blocked) {
        return res.status(403).json({
            toolResult: null,
            sag: { status: decision.status, risk: decision.riskScore, reason: decision.reason },
        });
    }

    // ESCALATED — tool call is held for human approval, don't execute
    if (decision.status === 'ESCALATED') {
        return res.status(202).json({
            toolResult: null,
            sag: {
                status: 'ESCALATED',
                risk: decision.riskScore,
                reason: decision.reason,
                message: 'Payment held for human approval. It will not execute until approved.',
            },
        });
    }

    const result = sendPayment(amount, currency, recipient);
    res.json({
        toolResult: result,
        sag: { status: decision.status, risk: decision.riskScore, traceId: decision.traceId },
    });
});

/**
 * GET /explain
 * Show full decision breakdown for a tool call.
 */
app.get('/explain', async (req, res) => {
    const { tool, amount } = req.query;
    const result = await sag.explain(tool || 'payment.initiate', { amount: parseFloat(amount) || 500 });
    res.json(result);
});

// ─── Start ───
const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
    console.log(`\n  🛡️  Secure AI Agent running at http://localhost:${PORT}`);
    console.log(`  🔗 SAG Gateway: ${env.SAG_ENDPOINT}`);
    console.log(`  🤖 Agent: ${env.SAG_AGENT}`);
    console.log(`\n  Try these:`);
    console.log(`    curl -X POST http://localhost:${PORT}/generate-report -H "Content-Type: application/json" -d '{"type":"quarterly"}'`);
    console.log(`    curl -X POST http://localhost:${PORT}/send-payment -H "Content-Type: application/json" -d '{"amount":500}'`);
    console.log(`    curl -X POST http://localhost:${PORT}/send-payment -H "Content-Type: application/json" -d '{"amount":50000}'`);
    console.log(`    curl http://localhost:${PORT}/explain?tool=payment.initiate&amount=50000\n`);
});
