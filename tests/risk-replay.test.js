/**
 * Risk Engine Deterministic Replay Tests
 *
 * Validates Phase 1.3: Risk scoring determinism overrides
 *
 * Assertions:
 * 1. Time override (business hours vs off-hours)
 * 2. Velocity override (simulated high request volume)
 * 3. Identical composite score when overriding time and stats
 *
 * Run: node tests/risk-replay.test.js
 */
const path = require('path');
const fs = require('fs');

// Bootstrap isolated test DB
process.env.DB_PATH = path.join(__dirname, '..', '.test-replay.db');
try { fs.unlinkSync(process.env.DB_PATH); } catch { }

const { getDb } = require('../src/database');
const db = getDb(); // initializes schema

// Seed tool registry for testing
db.prepare("INSERT OR IGNORE INTO tool_registry (id, name, risk_level) VALUES (?, ?, ?)")
    .run('report.generate', 'report.generate', 'low');

const { scoreRequest } = require('../src/risk-engine');

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

function mockAgent(overrides = {}) {
    return {
        id: 'test-agent', name: 'TestAgent', role: 'audit',
        trust_score: 90, total_requests: 0, blocked_requests: 0,
        ...overrides,
    };
}

console.log('\n  Risk Engine Deterministic Replay Tests\n');

// ────────────────────────────────────────────
// 1. Time Override (Off-hours penalty)
// ────────────────────────────────────────────
const businessHourTs = '2026-06-15T10:00:00.000Z'; // 10:00 (Business hours)
const offHourTs = '2026-06-15T03:00:00.000Z';      // 03:00 (Off-hours)

const bizScore = scoreRequest({
    agent: mockAgent(), tool: 'report.generate', action: 'READ',
    replayTimestamp: businessHourTs,
});
const offScore = scoreRequest({
    agent: mockAgent(), tool: 'report.generate', action: 'READ',
    replayTimestamp: offHourTs,
});

assert('Business hour override → 0 off-hours penalty', !bizScore.factors.some(f => f.factor === 'off_hours_access'));
assert('Off-hour override → +10 off-hours penalty', offScore.factors.find(f => f.factor === 'off_hours_access')?.weight === 10);

// ────────────────────────────────────────────
// 2. Velocity Override (Agent Stats)
// ────────────────────────────────────────────
const normalVol = scoreRequest({
    agent: mockAgent(), tool: 'report.generate', action: 'READ',
    replayAgentStats: { recentCount: 5 }
});
const highVol = scoreRequest({
    agent: mockAgent(), tool: 'report.generate', action: 'READ',
    replayAgentStats: { recentCount: 75 } // elevated
});
const extremeVol = scoreRequest({
    agent: mockAgent(), tool: 'report.generate', action: 'READ',
    replayAgentStats: { recentCount: 150 } // high
});

assert('Velocity override: normal (5) → no penalty', !normalVol.factors.some(f => f.factor.includes('velocity')));
assert('Velocity override: elevated (75) → +10 penalty', highVol.factors.find(f => f.factor === 'elevated_request_velocity')?.weight === 10);
assert('Velocity override: high (150) → +20 penalty', extremeVol.factors.find(f => f.factor === 'high_request_velocity')?.weight === 20);

// ────────────────────────────────────────────
// 3. Composite Deterministic Scoring
// ────────────────────────────────────────────
const deterministicScore1 = scoreRequest({
    agent: mockAgent({ trust_score: 55 }), // +15 medium trust
    tool: 'report.generate', action: 'EXECUTE', // +20 execute action
    replayTimestamp: offHourTs,               // +10 off hours
    replayAgentStats: { recentCount: 80 }     // +10 elevated velocity
});
// Total expected score: 15 + 20 + 10 + 10 = 55

const deterministicScore2 = scoreRequest({
    agent: mockAgent({ trust_score: 55 }),
    tool: 'report.generate', action: 'EXECUTE',
    replayTimestamp: offHourTs,
    replayAgentStats: { recentCount: 80 }
});

assert('Deterministic scoring → identical scores across calls', deterministicScore1.score === deterministicScore2.score);
assert('Deterministic scoring → exact expected score (55)', deterministicScore1.score === 55);

console.log('\n  ─────────────────────────────────────');
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log('  ─────────────────────────────────────\n');

try { fs.unlinkSync(process.env.DB_PATH); } catch { }
process.exit(fail > 0 ? 1 : 0);
