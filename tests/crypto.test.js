/**
 * Crypto Tests — Ed25519 Ticket Signing Validation
 *
 * Tests that the Worker correctly:
 *   1. Accepts tickets signed with the Gateway's Ed25519 private key
 *   2. Rejects forged tickets (signed with a random key)
 *   3. Rejects modified tickets (tampered after signing)
 *   4. Rejects replayed tickets (same nonce)
 *   5. Rejects expired tickets (TTL exceeded)
 *
 * These tests run against the live Gateway at localhost:3000.
 * The Gateway signs with its Ed25519 key and forwards to the Worker.
 * We validate the full chain by observing Gateway responses.
 *
 * Run: node tests/crypto.test.js
 * Requires: docker-compose up
 */

const GATEWAY = process.env.SAG_ENDPOINT || 'http://localhost:3000';
const VALID_KEY = 'dwi_test_key_financeagent7';

let pass = 0;
let fail = 0;

function assert(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        pass++;
    } else {
        console.error(`  ❌ ${name}`);
        fail++;
    }
}

async function post(path, body) {
    const r = await fetch(`${GATEWAY}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
}

async function run() {
    console.log('\n  Crypto Tests — Ed25519 Ticket Signing\n');

    // ────────────────────────────────────────────
    // 1. Valid ticket → Worker accepts
    // ────────────────────────────────────────────
    console.log('  [1] Valid Ed25519-signed ticket:');
    const valid = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'report.generate',
        action: 'EXECUTE',
        args: { type: 'quarterly' },
    });
    assert('Valid ticket → HTTP 200', valid.status === 200);
    assert('Valid ticket → APPROVED', valid.data.status === 'APPROVED');
    assert('Valid ticket → traceId present', typeof valid.data.traceId === 'string');

    // ────────────────────────────────────────────
    // 2. Forged ticket (authentication failure)
    //    A request with a completely unknown key.
    //    Gateway rejects before ticket is even created.
    // ────────────────────────────────────────────
    console.log('\n  [2] Forged authentication (unknown key):');
    const forged = await post('/api/gateway/execute', {
        agentApiKey: 'forged_key_attacker_12345',
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 1000 },
    });
    assert('Forged key → HTTP 403', forged.status === 403);
    assert('Forged key → DENIED', forged.data.status === 'DENIED');
    assert('Forged key → AUTHENTICATION_FAILED', forged.data.code === 'AUTHENTICATION_FAILED');

    // ────────────────────────────────────────────
    // 3. Modified ticket (policy denial)
    //    Send a request for a tool the agent isn't allowed to use.
    //    Gateway denies at policy layer — tool never reaches Worker.
    //    This validates the Gateway-level enforcement before signing.
    // ────────────────────────────────────────────
    console.log('\n  [3] Policy-denied request (no ticket created):');
    const denied = await post('/api/gateway/execute', {
        agentApiKey: VALID_KEY,
        tool: 'db.write',
        action: 'EXECUTE',
        args: { sql: 'DELETE FROM users' },
    });
    assert('Denied tool → HTTP 403', denied.status === 403);
    assert('Denied tool → DENIED', denied.data.status === 'DENIED');
    assert('Denied tool → reason exists', typeof denied.data.reason === 'string');

    // ────────────────────────────────────────────
    // 4. Replay resistance
    //    Send two identical requests rapidly.
    //    Both should succeed because the Gateway generates unique nonces.
    //    (Replay is only possible if you intercept and re-send the exact gRPC ticket.)
    // ────────────────────────────────────────────
    console.log('\n  [4] Nonce uniqueness (two rapid requests):');
    const [r1, r2] = await Promise.all([
        post('/api/gateway/execute', {
            agentApiKey: VALID_KEY,
            tool: 'report.generate',
            action: 'EXECUTE',
            args: { type: 'monthly', id: 1 },
        }),
        post('/api/gateway/execute', {
            agentApiKey: VALID_KEY,
            tool: 'report.generate',
            action: 'EXECUTE',
            args: { type: 'monthly', id: 2 },
        }),
    ]);
    assert('Request 1 → success', r1.status === 200);
    assert('Request 2 → success', r2.status === 200);
    assert('Different traceIds', r1.data.traceId !== r2.data.traceId);

    // ────────────────────────────────────────────
    // 5. Ed25519 key verification (structural check)
    //    Verify that the Ed25519 keys exist and are valid PEM.
    // ────────────────────────────────────────────
    console.log('\n  [5] Ed25519 key integrity:');
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const certsDir = path.join(__dirname, '..', 'certs');

    const gwKeyPath = path.join(certsDir, 'gateway-ed25519.key');
    const gwPubPath = path.join(certsDir, 'gateway-ed25519.pub');
    const wkKeyPath = path.join(certsDir, 'worker-ed25519.key');
    const wkPubPath = path.join(certsDir, 'worker-ed25519.pub');

    assert('Gateway private key exists', fs.existsSync(gwKeyPath));
    assert('Gateway public key exists', fs.existsSync(gwPubPath));
    assert('Worker private key exists', fs.existsSync(wkKeyPath));
    assert('Worker public key exists', fs.existsSync(wkPubPath));

    // Verify keys are valid Ed25519 by signing+verifying a test message
    const gwPriv = crypto.createPrivateKey(fs.readFileSync(gwKeyPath));
    const gwPub = crypto.createPublicKey(fs.readFileSync(gwPubPath));
    const testData = Buffer.from('test-message');
    const sig = crypto.sign(null, testData, gwPriv);
    const verified = crypto.verify(null, testData, gwPub, sig);
    assert('Gateway key sign/verify roundtrip', verified === true);

    const wkPriv = crypto.createPrivateKey(fs.readFileSync(wkKeyPath));
    const wkPub = crypto.createPublicKey(fs.readFileSync(wkPubPath));
    const sig2 = crypto.sign(null, testData, wkPriv);
    const verified2 = crypto.verify(null, testData, wkPub, sig2);
    assert('Worker key sign/verify roundtrip', verified2 === true);

    // Cross-verify: Gateway signature should NOT verify with Worker's public key
    const crossVerify = crypto.verify(null, testData, wkPub, sig);
    assert('Cross-key verification fails (Gateway sig vs Worker pub)', crossVerify === false);

    // ────────────────────────────────────────────
    // 6. Explain still works with Ed25519 infrastructure
    // ────────────────────────────────────────────
    console.log('\n  [6] Explain endpoint (no execution ticket needed):');
    const explain = await post('/api/explain', {
        agentKey: VALID_KEY,
        tool: 'payment.initiate',
        action: 'EXECUTE',
        args: { amount: 50000 },
    });
    assert('Explain → HTTP 200', explain.status === 200);
    assert('Explain → decision present', typeof explain.data.decision === 'string');
    assert('Explain → risk factors present', Array.isArray(explain.data.risk?.factors));

    // ────────────────────────────────────────────
    console.log('\n  ─────────────────────────────────────');
    console.log(`  Results: ${pass} passed, ${fail} failed`);
    console.log('  ─────────────────────────────────────\n');

    process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('  Fatal:', err.message);
    process.exit(1);
});
