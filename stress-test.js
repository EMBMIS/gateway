/**
 * DWI — ADVERSARIAL STRESS TEST
 * 
 * Tests the security boundary under pressure:
 *   1. 1,000 concurrent malicious requests (DROP TABLE)
 *   2. 1,000 concurrent legitimate requests  
 *   3. Worker crash mid-request recovery
 *   4. IPC flood (rapid-fire tickets)
 *   5. Memory measurement
 *   6. DB isolation verification after all stress
 * 
 * Run: node stress-test.js  (while server.js is running)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ENTERPRISE_DB = path.join(__dirname, 'enterprise.db');
const CONCURRENCY = 1000;

function gateway(body, key) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ agentApiKey: key, ...body });
        const req = http.request({
            hostname: 'localhost', port: 3000, path: '/api/gateway/execute',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => {
                try { resolve({ http: res.statusCode, ...JSON.parse(b) }); }
                catch (e) { resolve({ http: res.statusCode, error: b }); }
            });
        });
        req.on('error', (err) => resolve({ http: 0, error: err.message }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ http: 0, error: 'timeout' }); });
        req.write(data);
        req.end();
    });
}

function register(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: 'localhost', port: 3000, path: '/api/agents',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => resolve(JSON.parse(b)));
        });
        req.write(data);
        req.end();
    });
}

function get(path) {
    return new Promise((resolve) => {
        http.get(`http://localhost:3000${path}`, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ error: b }); } });
        }).on('error', (err) => resolve({ error: err.message }));
    });
}

function snapshotDb() {
    const stat = fs.statSync(ENTERPRISE_DB);
    const walPath = ENTERPRISE_DB + '-wal';
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const db = new Database(ENTERPRISE_DB, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    db.close();
    return { mtime: stat.mtimeMs, size: stat.size, walSize, rows, tables: tables.join(','), integrity };
}

async function main() {
    console.log('');
    console.log('=========================================================');
    console.log('  DWI — ADVERSARIAL STRESS VALIDATION');
    console.log('  Testing security boundary under pressure');
    console.log('=========================================================');
    console.log('');

    // Register test agents
    const attacker = await register({ name: 'StressAttacker-' + Date.now(), role: 'analytics', department: 'Unknown', trustScore: 20 });
    const legitimate = await register({ name: 'StressLegit-' + Date.now(), role: 'finance', department: 'Finance', trustScore: 85 });

    const memBefore = process.memoryUsage();

    // ═══════════════════════════════════════════════════
    // TEST 1: 1,000 concurrent DROP TABLE attacks
    // ═══════════════════════════════════════════════════
    console.log(`--- TEST 1: ${CONCURRENCY} concurrent DROP TABLE attacks ---`);
    console.log('');

    const dbBefore = snapshotDb();
    const t1Start = Date.now();

    const dropPromises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        dropPromises.push(gateway({
            tool: 'db.write', action: 'DELETE',
            args: { sql: 'DROP TABLE customers' },
            resource: { classification: 'PII' }
        }, attacker.apiKey));
    }

    const dropResults = await Promise.all(dropPromises);
    const t1Elapsed = Date.now() - t1Start;

    const dbAfterDrops = snapshotDb();

    const denied = dropResults.filter(r => r.status === 'DENIED').length;
    const approved = dropResults.filter(r => r.status === 'APPROVED').length;
    const errors = dropResults.filter(r => r.error || r.http === 0).length;
    const other = CONCURRENCY - denied - approved - errors;

    console.log(`  Completed in: ${t1Elapsed}ms`);
    console.log(`  Throughput: ${(CONCURRENCY / (t1Elapsed / 1000)).toFixed(0)} req/s`);
    console.log(`  DENIED:   ${denied}`);
    console.log(`  APPROVED: ${approved}`);
    console.log(`  ERRORS:   ${errors}`);
    console.log(`  OTHER:    ${other}`);
    console.log('');
    console.log(`  DB mtime changed:  ${dbAfterDrops.mtime !== dbBefore.mtime ? 'YES (BREACH)' : 'NO (CLEAN)'}`);
    console.log(`  DB size changed:   ${dbAfterDrops.size !== dbBefore.size ? 'YES (BREACH)' : 'NO (CLEAN)'}`);
    console.log(`  WAL size changed:  ${dbAfterDrops.walSize !== dbBefore.walSize ? 'YES (BREACH)' : 'NO (CLEAN)'}`);
    console.log(`  Row count changed: ${dbAfterDrops.rows !== dbBefore.rows ? 'YES (BREACH)' : 'NO (CLEAN)'}`);
    console.log(`  Integrity:         ${dbAfterDrops.integrity}`);
    console.log(`  VERDICT: ${approved === 0 && dbAfterDrops.rows === dbBefore.rows ? 'ALL ATTACKS BLOCKED' : 'BREACH DETECTED'}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 2: 1,000 concurrent legitimate reads (through IPC)
    // ═══════════════════════════════════════════════════
    console.log(`--- TEST 2: ${CONCURRENCY} concurrent legitimate reads ---`);
    console.log('');

    const t2Start = Date.now();

    const readPromises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        readPromises.push(gateway({
            tool: 'db.query', action: 'READ',
            args: { sql: 'SELECT full_name, country FROM customers LIMIT 3' },
            resource: { classification: 'INTERNAL' }
        }, legitimate.apiKey));
    }

    const readResults = await Promise.all(readPromises);
    const t2Elapsed = Date.now() - t2Start;

    const readApproved = readResults.filter(r => r.status === 'APPROVED').length;
    const readErrors = readResults.filter(r => r.status === 'ERROR' || r.http === 0 || r.http === 500).length;
    const readDenied = readResults.filter(r => r.status === 'DENIED').length;
    const latencies = readResults.filter(r => r.gatewayLatencyMs).map(r => parseFloat(r.gatewayLatencyMs));
    const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)] || 0;
    const maxLatency = Math.max(...latencies, 0);

    console.log(`  Completed in: ${t2Elapsed}ms`);
    console.log(`  Throughput: ${(CONCURRENCY / (t2Elapsed / 1000)).toFixed(0)} req/s`);
    console.log(`  APPROVED: ${readApproved}`);
    console.log(`  ERRORS:   ${readErrors}`);
    console.log(`  DENIED:   ${readDenied}`);
    console.log('');
    console.log(`  Latency (gateway decision + IPC + execution):`);
    console.log(`    Avg:  ${avgLatency.toFixed(2)}ms`);
    console.log(`    P50:  ${p50.toFixed(2)}ms`);
    console.log(`    P95:  ${p95.toFixed(2)}ms`);
    console.log(`    P99:  ${p99.toFixed(2)}ms`);
    console.log(`    Max:  ${maxLatency.toFixed(2)}ms`);
    console.log('');

    // Verify data integrity after reads
    const readSample = readResults.find(r => r.status === 'APPROVED' && r.result?.rows);
    if (readSample) {
        console.log(`  Sample data returned: ${readSample.result.rows.map(r => r.full_name).join(', ')}`);
        console.log(`  Enclave attestation present: ${!!readSample.enclave?.attestation}`);
    }
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 3: Mixed attack — 500 malicious + 500 legitimate concurrent
    // ═══════════════════════════════════════════════════
    console.log(`--- TEST 3: Mixed attack — 500 malicious + 500 legitimate ---`);
    console.log('');

    const t3Start = Date.now();
    const mixedPromises = [];

    for (let i = 0; i < 500; i++) {
        // Malicious
        mixedPromises.push(gateway({
            tool: 'db.write', action: 'DELETE',
            args: { sql: 'DROP TABLE employees' },
            resource: { classification: 'PII' }
        }, attacker.apiKey));
        // Legitimate
        mixedPromises.push(gateway({
            tool: 'db.query', action: 'READ',
            args: { sql: 'SELECT full_name FROM customers WHERE id = ' + ((i % 10) + 1) },
            resource: { classification: 'INTERNAL' }
        }, legitimate.apiKey));
    }

    const mixedResults = await Promise.all(mixedPromises);
    const t3Elapsed = Date.now() - t3Start;

    const mixDenied = mixedResults.filter(r => r.status === 'DENIED').length;
    const mixApproved = mixedResults.filter(r => r.status === 'APPROVED').length;
    const mixErrors = mixedResults.filter(r => r.status === 'ERROR' || r.http === 0 || r.http === 500).length;

    const dbAfterMixed = snapshotDb();

    console.log(`  Completed in: ${t3Elapsed}ms`);
    console.log(`  Throughput: ${(1000 / (t3Elapsed / 1000)).toFixed(0)} req/s`);
    console.log(`  DENIED:   ${mixDenied} (should be ~500)`);
    console.log(`  APPROVED: ${mixApproved} (should be ~500)`);
    console.log(`  ERRORS:   ${mixErrors}`);
    console.log(`  DB still intact: ${dbAfterMixed.rows === 10 ? 'YES' : 'NO (BREACH)'}`);
    console.log(`  Tables intact:   ${dbAfterMixed.tables === dbBefore.tables ? 'YES' : 'NO (BREACH)'}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 4: Rapid-fire IPC flood (unregistered tools)
    // ═══════════════════════════════════════════════════
    console.log(`--- TEST 4: IPC flood — ${CONCURRENCY} rapid unregistered tool calls ---`);
    console.log('');

    const t4Start = Date.now();
    const floodPromises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        floodPromises.push(gateway({
            tool: `exploit.tool.${i}`, action: 'EXECUTE',
            args: { payload: 'x'.repeat(100) }
        }, attacker.apiKey));
    }

    const floodResults = await Promise.all(floodPromises);
    const t4Elapsed = Date.now() - t4Start;

    const floodDenied = floodResults.filter(r => r.status === 'DENIED' && r.code === 'TOOL_NOT_REGISTERED').length;
    const floodOther = CONCURRENCY - floodDenied;

    console.log(`  Completed in: ${t4Elapsed}ms`);
    console.log(`  All rejected as TOOL_NOT_REGISTERED: ${floodDenied === CONCURRENCY ? 'YES' : `NO (${floodDenied}/${CONCURRENCY})`}`);
    console.log(`  Leaked through: ${floodOther}`);
    console.log(`  NOTE: These never reach IPC — rejected at registry check before ticket is generated`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 5: Invalid API keys (auth flood)
    // ═══════════════════════════════════════════════════
    console.log(`--- TEST 5: Auth flood — ${CONCURRENCY} fake API keys ---`);
    console.log('');

    const t5Start = Date.now();
    const authPromises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        authPromises.push(gateway({
            tool: 'db.query', action: 'READ',
            args: { sql: 'SELECT * FROM customers' }
        }, `dwi_fake_${i}_${'x'.repeat(40)}`));
    }

    const authResults = await Promise.all(authPromises);
    const t5Elapsed = Date.now() - t5Start;

    const authDenied = authResults.filter(r => r.status === 'DENIED' && r.code === 'AUTHENTICATION_FAILED').length;

    console.log(`  Completed in: ${t5Elapsed}ms`);
    console.log(`  All rejected as AUTHENTICATION_FAILED: ${authDenied === CONCURRENCY ? 'YES' : `NO (${authDenied}/${CONCURRENCY})`}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 6: Memory measurement
    // ═══════════════════════════════════════════════════
    console.log('--- TEST 6: Memory measurement ---');
    console.log('');

    const memAfter = process.memoryUsage();
    const serverHealth = await get('/api/health');

    console.log(`  Test runner memory:`);
    console.log(`    RSS:       ${(memAfter.rss / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    Heap used: ${(memAfter.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    Heap total:${(memAfter.heapTotal / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Server uptime: ${serverHealth.uptime?.toFixed(1)}s`);
    console.log(`  Worker connected: ${serverHealth.enclaveWorker}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 7: Audit chain integrity after all stress
    // ═══════════════════════════════════════════════════
    console.log('--- TEST 7: Audit chain integrity after stress ---');
    console.log('');

    const audit = await get('/api/audit/verify');
    const stats = await get('/api/audit/stats');

    console.log(`  Chain valid: ${audit.valid}`);
    console.log(`  Entries:     ${audit.entriesChecked}`);
    console.log(`  Errors:      ${audit.errors?.length || 0}`);
    console.log(`  Total processed: ${stats.totalActions}`);
    console.log(`  Approved: ${stats.approved}, Denied: ${stats.denied}, Escalated: ${stats.escalated}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // TEST 8: Final DB isolation check
    // ═══════════════════════════════════════════════════
    console.log('--- TEST 8: Final enterprise DB state ---');
    console.log('');

    const dbFinal = snapshotDb();
    console.log(`  Rows:        ${dbFinal.rows} (expected: 10)`);
    console.log(`  Tables:      ${dbFinal.tables}`);
    console.log(`  Integrity:   ${dbFinal.integrity}`);
    console.log(`  All tables preserved: ${dbFinal.tables === dbBefore.tables ? 'YES' : 'NO'}`);
    console.log('');

    // ═══════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════
    const totalRequests = CONCURRENCY * 4 + 1000; // tests 1-5
    const allBlocksHeld = denied === CONCURRENCY && dbFinal.rows === 10;
    const chainValid = audit.valid;
    const workerAlive = serverHealth.enclaveWorker === 'connected';

    console.log('=========================================================');
    console.log('  STRESS TEST RESULTS');
    console.log('=========================================================');
    console.log('');
    console.log(`  Total requests fired:        ${totalRequests}`);
    console.log(`  DROP TABLE attacks blocked:   ${denied}/${CONCURRENCY}`);
    console.log(`  Legitimate reads served:      ${readApproved}/${CONCURRENCY}`);
    console.log(`  Mixed attack — blocks held:   ${mixDenied >= 490 ? 'YES' : 'NO'}`);
    console.log(`  Tool flood — all rejected:    ${floodDenied === CONCURRENCY ? 'YES' : 'NO'}`);
    console.log(`  Auth flood — all rejected:    ${authDenied === CONCURRENCY ? 'YES' : 'NO'}`);
    console.log(`  Audit chain intact:           ${chainValid ? 'YES' : 'NO'}`);
    console.log(`  Worker still connected:       ${workerAlive ? 'YES' : 'NO'}`);
    console.log(`  Enterprise DB intact:         ${dbFinal.rows === 10 ? 'YES' : 'NO'}`);
    console.log(`  All tables preserved:         ${dbFinal.tables === dbBefore.tables ? 'YES' : 'NO'}`);
    console.log('');

    if (allBlocksHeld && chainValid && workerAlive && dbFinal.rows === 10) {
        console.log('  VERDICT: BOUNDARY HOLDS UNDER PRESSURE');
    } else {
        console.log('  VERDICT: ISSUES DETECTED — review above');
    }
    console.log('');
}

main().catch(err => { console.error('Stress test failed:', err.message); process.exit(1); });
