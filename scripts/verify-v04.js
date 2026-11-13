/**
 * verify-v04.js
 * Comprehensive End-to-End Simulation of the Cloud-Native Sovereign Agent Architecture
 * 
 * This simulation assumes:
 * 1. Docker Compose stack is running (Gateway, Worker, Redis, Postgres, KMS)
 * 2. `enterprise_db` in Postgres has been seeded via `enterprise-db.js`
 * 3. The Enclave Worker successfully resolved the KMS-signed `policy.bundle.json`
 */

async function runScenario() {
    console.log(`\n======================================================`);
    console.log(`  v0.4 End-to-End Banking Simulation (Cloud-Native)   `);
    console.log(`======================================================\n`);

    const GATEWAY_URL = 'http://localhost:3000';

    async function sendRequest(agentId, toolPayload) {
        console.log(`\n[Agent: ${agentId}] -> Tool: ${toolPayload.tool} | Action: ${toolPayload.action}`);
        try {
            const res = await fetch(`${GATEWAY_URL}/api/gateway/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-agent-key': toolPayload.mockKey // Pass the mock seeded key in the header
                },
                body: JSON.stringify(toolPayload)
            });
            const data = await res.json();

            if (res.ok && res.status !== 202) {
                console.log(`  ✅ SUCCESS: Execution Approved & Completed`);
                if (data.result) {
                    if (data.result.changes !== undefined) {
                        console.log(`     DB Mutated. Rows affected: ${data.result.changes}`);
                    } else if (data.result.simulated) {
                        console.log(`     API Called: [${data.result.status}] ${data.result.note}`);
                    } else {
                        console.log(`     Data Returned: ${data.result.rowCount || data.result.length} rows`);
                    }
                }
                if (data.enclave) {
                    console.log(`     🔐 Enclave Session Hash: ${data.enclave.attestation?.substring(0, 16)}...`);
                    console.log(`     ⚙️  Policy Evaluation MS: ${data.policyEvaluationMs || 0}`);
                    console.log(`     📡 Gateway Latency MS: ${data.gatewayLatencyMs || 0}`);
                }
            } else if (res.status === 202) {
                console.log(`  ⏳ ESCALATED: ${data.reason}`);
            } else {
                console.log(`  ❌ BLOCKED: [${data.code}] ${data.reason}`);
            }

        } catch (err) {
            console.error(`  ⚠️ CONNECITON ERROR: Is the Gateway running? (${err.message})`);
        }
    }

    const getKey = (name) => `dwi_test_key_${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    // 1. Authorized Read
    await sendRequest('Codex-Alpha', {
        mockKey: getKey('Codex-Alpha'),
        tool: 'user.lookup',
        action: 'READ',
        args: { userId: 2 }
    });

    // 2. High-Risk Action (Within limits)
    await sendRequest('FinanceAgent-7', {
        mockKey: getKey('FinanceAgent-7'),
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 8500, currency: 'EUR', recipient: 'vendor-84' }
    });

    // 3. Destructive Action (Should be blocked by DB Policy / Gateway Route)
    await sendRequest('HRAssist-Pro', {
        mockKey: getKey('HRAssist-Pro'),
        tool: 'db.write',
        action: 'DELETE',
        args: { sql: 'DELETE FROM employees WHERE id = 1', params: [] }
    });

    // 4. Catastrophic Attack (Blocked by Sovereign Policy limit: 85 threshold on autoBlock)
    await sendRequest('FinanceAgent-7', {
        mockKey: getKey('FinanceAgent-7'),
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 250000, currency: 'EUR', recipient: 'offshore-xyz-999' }
    });

    console.log(`\n[Simulation Complete]\n`);
}

runScenario();
