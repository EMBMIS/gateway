/**
 * Risk Engine v1.0 — Unit Tests
 *
 * Run: node tests/risk-engine.test.js
 *
 * Tests are pure assertions — no test framework required.
 * Exit code 0 = all pass. Exit code 1 = failure.
 */
const path = require('path');

// Bootstrap: need getDb() to work
process.env.DB_PATH = path.join(__dirname, '..', '.test-risk.db');
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); } catch { }

const { getDb } = require('../src/database');
const db = getDb(); // initializes schema

// Seed a minimal tool registry
const tools = [
    { name: 'user.lookup', risk_level: 'high' },
    { name: 'report.generate', risk_level: 'low' },
    { name: 'payment.initiate', risk_level: 'critical' },
    { name: 'db.write', risk_level: 'critical' },
    { name: 'db.query', risk_level: 'high' },
    { name: 'system.config', risk_level: 'high' },
];
for (const t of tools) {
    db.prepare("INSERT OR IGNORE INTO tool_registry (id, name, description, category, risk_level, requires_tee, signature, schema_json) VALUES (?, ?, '', 'test', ?, 0, 'test-sig', '{}')")
        .run(t.name, t.name, t.risk_level);
}

const { scoreRequest, AUTO_BLOCK_THRESHOLD, ESCALATION_THRESHOLD, PAYLOAD_RULES } = require('../src/risk-engine');

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

// Off-hours bonus: +10 if run outside 06:00-22:00
const hour = new Date().getHours();
const OFF_HOURS_BONUS = (hour < 6 || hour > 22) ? 10 : 0;

function mockAgent(overrides = {}) {
    return {
        id: 'test-agent-1', name: 'TestAgent', role: 'finance',
        trust_score: 74, total_requests: 0, blocked_requests: 0,
        ...overrides,
    };
}

console.log('\n  Risk Engine v1.0 — Unit Tests\n');

// ── Thresholds ──
console.log('  Thresholds:');
assert('Escalation threshold is 60', ESCALATION_THRESHOLD === 60);
assert('Auto-block threshold is 85', AUTO_BLOCK_THRESHOLD === 85);

// ── Trust Penalties ──
console.log('\n  Trust Penalties:');
const highTrust = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'report.generate', action: 'READ', resource: {}, args: {} });
assert('High trust (90) → no trust penalty', !highTrust.factors.some(f => f.factor.includes('trust')));

const medTrust = scoreRequest({ agent: mockAgent({ trust_score: 55 }), tool: 'report.generate', action: 'READ', resource: {}, args: {} });
assert('Medium trust (55) → +15', medTrust.factors.find(f => f.factor === 'medium_trust_score')?.weight === 15);

const lowTrust = scoreRequest({ agent: mockAgent({ trust_score: 30 }), tool: 'report.generate', action: 'READ', resource: {}, args: {} });
assert('Low trust (30) → +35', lowTrust.factors.find(f => f.factor === 'low_trust_score')?.weight === 35);

// ── Tool Risk Levels ──
console.log('\n  Tool Risk Levels:');
const lowTool = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'report.generate', action: 'READ', resource: {}, args: {} });
assert('Low risk tool (report.generate) → weight 0', lowTool.score === 0 + OFF_HOURS_BONUS);

const highTool = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'user.lookup', action: 'READ', resource: {}, args: {} });
assert('High risk tool (user.lookup) → weight 15', highTool.factors.find(f => f.factor === 'tool_risk_level')?.weight === 15);

const critTool = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'payment.initiate', action: 'READ', resource: {}, args: {} });
assert('Critical risk tool (payment.initiate) → weight 25', critTool.factors.find(f => f.factor === 'tool_risk_level')?.weight === 25);

// ── Action Severity ──
console.log('\n  Action Severity:');
const readAction = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'report.generate', action: 'READ', resource: {}, args: {} });
assert('READ action → weight 0', readAction.score === 0 + OFF_HOURS_BONUS);

const execAction = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'report.generate', action: 'EXECUTE', resource: {}, args: {} });
assert('EXECUTE action → weight 20', execAction.factors.find(f => f.factor === 'action_severity')?.weight === 20);

const deleteAction = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'report.generate', action: 'DELETE', resource: {}, args: {} });
assert('DELETE action → weight 30', deleteAction.factors.find(f => f.factor === 'action_severity')?.weight === 30);

// ── Payload Modifiers ──
console.log('\n  Payload Modifiers (payment.initiate):');
const pay500 = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 500 } });
assert('$500 payment → no payload modifier', !pay500.factors.some(f => f.factor === 'payload_modifier'));

const pay15k = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 15000 } });
assert('$15k payment → +15 modifier', pay15k.factors.find(f => f.factor === 'payload_modifier')?.weight === 15);

const pay50k = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 50000 } });
assert('$50k payment → +25 modifier', pay50k.factors.find(f => f.factor === 'payload_modifier')?.weight === 25);

const pay250k = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 250000 } });
assert('$250k payment → +40 modifier', pay250k.factors.find(f => f.factor === 'payload_modifier')?.weight === 40);

console.log('\n  Payload Modifiers (db.write):');
const dropStmt = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'db.write', action: 'EXECUTE', resource: {}, args: { sql: 'DROP TABLE users' } });
assert('DROP TABLE → +40 modifier', dropStmt.factors.find(f => f.factor === 'payload_modifier')?.weight === 40);

const delNoWhere = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'db.write', action: 'EXECUTE', resource: {}, args: { sql: 'DELETE FROM users' } });
assert('DELETE without WHERE → +30 modifier', delNoWhere.factors.find(f => f.factor === 'payload_modifier')?.weight === 30);

const delWithWhere = scoreRequest({ agent: mockAgent({ trust_score: 90 }), tool: 'db.write', action: 'EXECUTE', resource: {}, args: { sql: 'DELETE FROM users WHERE id = 5' } });
assert('DELETE with WHERE → +15 modifier', delWithWhere.factors.find(f => f.factor === 'payload_modifier')?.weight === 15);

// ── Composite Scenarios ──
console.log('\n  Composite Scenarios:');
const finAgent = mockAgent(); // trust 74

const safeLookup = scoreRequest({ agent: finAgent, tool: 'user.lookup', action: 'EXECUTE', resource: {}, args: {} });
assert('FinanceAgent user.lookup EXECUTE → below escalation', safeLookup.score < ESCALATION_THRESHOLD);
assert('FinanceAgent user.lookup EXECUTE → score matches factors', safeLookup.score === safeLookup.factors.reduce((s, f) => s + f.weight, 0));

const smallPayment = scoreRequest({ agent: finAgent, tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 500 } });
assert('FinanceAgent $500 payment → below escalation', smallPayment.score < ESCALATION_THRESHOLD);

const bigPayment = scoreRequest({ agent: finAgent, tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 50000 } });
assert('FinanceAgent $50k payment → at or above escalation', bigPayment.score >= ESCALATION_THRESHOLD);

const hugePayment = scoreRequest({ agent: finAgent, tool: 'payment.initiate', action: 'EXECUTE', resource: {}, args: { amount: 250000 } });
assert('FinanceAgent $250k payment → at or above auto-block', hugePayment.score >= AUTO_BLOCK_THRESHOLD);

// ── Cap ──
console.log('\n  Score Cap:');
const extreme = scoreRequest({ agent: mockAgent({ trust_score: 20 }), tool: 'payment.initiate', action: 'DELETE', resource: { classification: 'CREDENTIAL' }, args: { amount: 500000 } });
assert('Extreme scenario → capped at 100', extreme.score === 100);

// ── Result ──
console.log(`\n  ─────────────────────────────────────`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`  ─────────────────────────────────────\n`);

// Cleanup
try { fs.unlinkSync(process.env.DB_PATH); } catch { }

process.exit(failed > 0 ? 1 : 0);
