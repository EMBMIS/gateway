/**
 * DWI — Live Demo Script
 * Shows exactly what the gateway does with real requests.
 * Run: node demo.js
 */
const http = require('http');

function post(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: 'localhost', port: 3000,
            path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function get(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:3000${path}`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
    });
}

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  DWI — LIVE DEMO: What the Agent Gateway actually does');
    console.log('═══════════════════════════════════════════════════════\n');

    // Step 1: Register a new agent
    console.log('━━━ STEP 1: Register a new AI agent ━━━\n');
    const agent = (await post('/api/agents', {
        name: 'DemoBot-' + Date.now(),
        role: 'finance',
        department: 'Finance',
        trustScore: 75
    })).data;
    console.log(`  Agent registered: ${agent.name}`);
    console.log(`  Role: ${agent.role}`);
    console.log(`  Trust Score: ${agent.trustScore}/100`);
    console.log(`  API Key: ${agent.apiKey.slice(0, 20)}...`);
    const KEY = agent.apiKey;

    // Step 2: Agent tries to read a database (ALLOWED)
    console.log('\n━━━ STEP 2: Agent sends MCP call → db.query READ ━━━\n');
    const r1 = await post('/api/gateway/execute', {
        agentApiKey: KEY,
        tool: 'db.query',
        action: 'READ',
        args: { sql: 'SELECT name, country FROM customers LIMIT 10' },
        resource: { classification: 'INTERNAL' }
    });
    console.log(`  HTTP ${r1.status} → Decision: ${r1.data.status}`);
    console.log(`  Policy: ${r1.data.matchedPolicy?.name || 'Default role permission'}`);
    console.log(`  Risk Score: ${r1.data.riskScore}/100`);
    console.log(`  TEE Enclave: ${r1.data.enclave?.type || 'n/a'}`);
    console.log(`  TEE Attestation: ${r1.data.enclave?.attestation?.slice(0, 32)}...`);
    console.log(`  Audit Hash: ${r1.data.audit?.requestHash?.slice(0, 32)}...`);
    console.log(`  Gateway Latency: ${r1.data.gatewayLatencyMs}ms`);

    // Step 3: Agent tries to DELETE (BLOCKED by policy)
    console.log('\n━━━ STEP 3: Agent sends MCP call → db.write DELETE ━━━\n');
    const r2 = await post('/api/gateway/execute', {
        agentApiKey: KEY,
        tool: 'db.write',
        action: 'DELETE',
        args: { sql: 'DELETE FROM customers WHERE id > 0' },
        resource: { classification: 'PII' }
    });
    console.log(`  HTTP ${r2.status} → Decision: ${r2.data.status}`);
    console.log(`  Reason: ${r2.data.reason}`);
    console.log(`  Matched Policy: ${r2.data.matchedPolicy?.name || 'n/a'}`);

    // Step 4: Agent tries to initiate a payment (ESCALATED — needs human)
    console.log('\n━━━ STEP 4: Agent sends MCP call → payment.initiate ━━━\n');
    const r3 = await post('/api/gateway/execute', {
        agentApiKey: KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 50000, currency: 'EUR', recipient: 'vendor@corp.eu' },
        resource: { classification: 'FINANCIAL' }
    });
    console.log(`  HTTP ${r3.status} → Decision: ${r3.data.status}`);
    console.log(`  Reason: ${r3.data.reason}`);
    console.log(`  Risk Score: ${r3.data.riskScore}/100`);
    console.log(`  Secondary Action: ${r3.data.secondaryAction || 'n/a'}`);

    // Step 5: Agent tries to call a tool that doesn't exist (REJECTED)
    console.log('\n━━━ STEP 5: Agent calls unregistered tool → malware.exec ━━━\n');
    const r4 = await post('/api/gateway/execute', {
        agentApiKey: KEY,
        tool: 'malware.exec',
        action: 'EXECUTE',
        args: { command: 'rm -rf /' }
    });
    console.log(`  HTTP ${r4.status} → Decision: ${r4.data.status}`);
    console.log(`  Code: ${r4.data.code}`);
    console.log(`  Reason: ${r4.data.reason}`);

    // Step 6: Fake API key (REJECTED)
    console.log('\n━━━ STEP 6: Unknown agent with fake API key ━━━\n');
    const r5 = await post('/api/gateway/execute', {
        agentApiKey: 'dwi_fake_key_trying_to_hack',
        tool: 'db.query',
        action: 'READ',
        args: {}
    });
    console.log(`  HTTP ${r5.status} → Decision: ${r5.data.status}`);
    console.log(`  Code: ${r5.data.code}`);
    console.log(`  Reason: ${r5.data.reason}`);

    // Step 7: Verify audit chain
    console.log('\n━━━ STEP 7: Verify audit chain integrity ━━━\n');
    const audit = await get('/api/audit/verify');
    console.log(`  Chain valid: ${audit.valid}`);
    console.log(`  Entries checked: ${audit.entriesChecked}`);
    console.log(`  Tampered entries: ${audit.errors.length}`);

    // Step 8: View audit stats
    console.log('\n━━━ STEP 8: Audit log statistics ━━━\n');
    const stats = await get('/api/audit/stats');
    console.log(`  Total requests processed: ${stats.totalActions}`);
    console.log(`  Approved: ${stats.approved}`);
    console.log(`  Denied: ${stats.denied}`);
    console.log(`  Escalated: ${stats.escalated}`);
    console.log(`  Avg latency: ${stats.averageLatencyMs}ms`);

    // Step 9: Create a new policy
    console.log('\n━━━ STEP 9: Create new policy → block analytics role from PII ━━━\n');
    const newPolicy = (await post('/api/policies', {
        name: 'Block Analytics from PII',
        description: 'Prevent analytics agents from accessing PII data',
        priority: 4,
        conditions: [
            { field: 'agent.role', operator: '=', value: 'analytics' },
            { field: 'resource.classification', operator: '=', value: 'PII' }
        ],
        action: 'deny',
        secondaryAction: 'alert_ciso',
        createdBy: 'demo@dwi.eu'
    })).data;
    console.log(`  Policy created: "${newPolicy.name}" (id: ${newPolicy.id.slice(0, 8)}...)`);

    // Step 10: GDPR erasure
    console.log('\n━━━ STEP 10: GDPR Article 17 — Erase user data ━━━\n');
    const erasure = (await post('/api/vault/erasure', {
        userIdentifier: 'john.doe@example.eu'
    })).data;
    console.log(`  Status: ${erasure.status}`);
    console.log(`  Assets affected: ${erasure.assetsAffected}`);
    console.log(`  Proof hash: ${erasure.proofHash.slice(0, 32)}...`);
    console.log(`  Elapsed: ${erasure.elapsedMs}ms`);
    console.log(`  (Encryption keys rotated — old PII data is mathematically irrecoverable)`);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  SUMMARY: What is REAL in this system');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('  ✅ Agent registration + API key authentication');
    console.log('  ✅ MCP tool call interception (the firewall endpoint)');
    console.log('  ✅ Signed tool registry (unregistered tools rejected)');
    console.log('  ✅ RBAC/ABAC policy evaluation (real rule matching)');
    console.log('  ✅ Risk scoring (trust, tool risk, velocity, time)');
    console.log('  ✅ Policy CRUD (create/update/delete rules via API)');
    console.log('  ✅ Hash-chained audit log (tamper detection works)');
    console.log('  ✅ AES-256-GCM encrypted vault');
    console.log('  ✅ GDPR erasure via key rotation');
    console.log('');
    console.log('  ⚠️  TEE enclave is SIMULATED (needs real hardware)');
    console.log('  ⚠️  Tool execution results are MOCK (no real DB/API connected)');
    console.log('');
    console.log('  The firewall LOGIC is real. The things it protects');
    console.log('  (databases, APIs, email) are not connected yet.\n');
}

main().catch(err => { console.error('Demo failed:', err.message); process.exit(1); });
