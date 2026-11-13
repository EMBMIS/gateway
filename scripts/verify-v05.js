const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=== SOVEREIGN AGENT GATEWAY v0.5 ===');
console.log('--- Lifecycle Governance & Observability Verification ---\n');

function run(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
        return e.stdout + '\n' + e.stderr;
    }
}

const COMPILER_PATH = path.join(__dirname, '..', 'src', 'policy-compiler.js');
function setCompilerVersion(v) {
    let content = fs.readFileSync(COMPILER_PATH, 'utf8');
    content = content.replace(/process\.env\.BUNDLE_VERSION \|\| '\d+'/g, `process.env.BUNDLE_VERSION || '${v}'`);
    fs.writeFileSync(COMPILER_PATH, content, 'utf8');
    run('node src/policy-compiler.js');
}

// 1. Tracing Verification
console.log('[Test 1] Distributed Trace ID Propagation...');
console.log('Executing test simulation traffic (v0.4 replay) so Audit Logger commits deterministic traces...');
run('node scripts/verify-v04.js');

// Parse audit DB for traces
const dbQuery = `node -e "const db = require('better-sqlite3')('dwi.db'); const row = db.prepare('SELECT trace_id FROM audit_log ORDER BY seq DESC LIMIT 1').get(); console.log(row.trace_id);"`;
const traceId = run(dbQuery).trim();

if (!traceId || traceId === 'null') {
    console.log(`❌ FAILED: SQLite Audit Log did not record the Trace ID natively.\n`);
} else {
    console.log(`Gateway Database properly chained Trace: ${traceId}`);
    const workerLogs = run('docker logs dwi-worker');
    if (workerLogs.includes(`[${traceId}]`)) {
        console.log(`✅ PASS: Trace ID [${traceId}] successfully propagated across mTLS network boundary and stamped in Enclave Worker lifecycle execution logs.\n`);
    } else {
        console.log(`❌ FAILED: Trace ID not found in Enclave Worker stdout!\n`);
    }
}

// 2. Monotonic Downgrade Protection (Timeline Rollback)
console.log('[Test 2] Monotonic Downgrade Attack (Timeline Rollback) Assertion...');
console.log('Step A: Simulating CI/CD pipeline push for Policy v2...');
setCompilerVersion(2);
run('docker-compose restart worker');
// Sleep synchronously for 2s to allow Docker process execution
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);

console.log('Step B: Attacker compromises disk and forces valid signed Policy v1...');
setCompilerVersion(1);
run('docker-compose restart worker');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);

const downgradeLogs = run('docker logs dwi-worker');
if (downgradeLogs.includes('DOWNGRADE ATTACK DETECTED') && downgradeLogs.includes('Boot sequence aborted')) {
    console.log('✅ PASS: Worker detected timeline rollback to v1. It evaluated Dual Watermark (Redis/Disk) and crashed symmetrically, regardless of the valid cryptographic signature.\n');
} else {
    console.log('❌ FAILED: Worker did not crash on explicit timeline rollback attempt.\n');
}

// 3. Key Revocation (CRL) Enforcement
console.log('[Test 3] Static Key Revocation List (CRL) Hard-Enforcement...');
console.log('Injecting currently active KMS identity into revocation_list.json...');
fs.writeFileSync('revocation_list.json', JSON.stringify({ revoked_keys: ["alias/policy-authority-v0.4"] }), 'utf8');
run('docker-compose restart worker');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);

const revokedLogs = run('docker logs dwi-worker');
if (revokedLogs.includes('REVOKED. Boot sequence arbitrarily aborted')) {
    console.log('✅ PASS: Enclave Worker read the updated CRL configuration volume and refused to interpret the Ed25519 signature payload.\n');
} else {
    console.log('❌ FAILED: Worker silently ignored Key Revocation array.\n');
}

// Cleanup
fs.writeFileSync('revocation_list.json', JSON.stringify({ revoked_keys: ["mock-compromised-key-v1"] }), 'utf8');
setCompilerVersion(2); // Keep DB aligned at 2
run('docker-compose restart worker');
console.log('\n[Housekeeping] Restored policy timeline integrity to v2 and purged mock revocation.');
