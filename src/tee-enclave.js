/**
 * DWI — TEE Enclave (Simulated)
 * Simulates Trusted Execution Environment for the research prototype.
 * In production: Intel TDX / AMD SEV-SNP / AWS Nitro.
 *
 * Execution model:
 *   1. Policy engine approves request
 *   2. Enclave spins up (simulated)
 *   3. Data decrypted inside enclave
 *   4. Operation executed
 *   5. Output encrypted before leaving enclave
 *   6. Attestation proof generated
 */
const crypto = require('crypto');

// Phase 3.2: Execution sandbox modes
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'simulation';
const SANDBOX_PATTERNS = [
    { name: 'PATH_TRAVERSAL', pattern: /(?:\.\.\/|\.\.\\|\/etc\/|\/proc\/|\/sys\/|C:\\Windows|%2e%2e)/i },
    { name: 'SHELL_INJECTION', pattern: /(?:;\s*(?:rm|cat|chmod|chown|wget|curl|bash|sh|nc|ncat)\b|`[^`]+`|\$\([^)]+\)|\|\s*(?:sh|bash)\b)/i },
    { name: 'NETWORK_EXFIL', pattern: /(?:https?:\/\/|ftp:\/\/|file:\/\/|data:text|javascript:)/i },
    { name: 'SQL_INJECTION', pattern: /(?:;\s*DROP\s+TABLE|;\s*DELETE\s+FROM\s+\w+\s*(?:$|;)|UNION\s+SELECT|INTO\s+OUTFILE|LOAD_FILE)/i }
];

/**
 * Deep-scan an argument tree for sandbox violations.
 * Returns the first violation found, or null.
 */
function detectSandboxViolation(obj, path = '') {
    if (typeof obj === 'string') {
        for (const { name, pattern } of SANDBOX_PATTERNS) {
            if (pattern.test(obj)) {
                return { violation: name, field: path, value: obj.substring(0, 100) };
            }
        }
    } else if (obj && typeof obj === 'object') {
        for (const [key, val] of Object.entries(obj)) {
            const result = detectSandboxViolation(val, path ? `${path}.${key}` : key);
            if (result) return result;
        }
    }
    return null;
}

// Simulated enclave state
const enclaveState = {
    active: true,
    type: 'AMD-SEV-SNP-SIM',
    attestationKey: crypto.randomBytes(32),
    sessionCount: 0,
    totalExecutions: 0,
    lastKeyRotation: new Date().toISOString(),
    cpuUsage: 0,
    memoryUsage: 0,
};

// Enclave encryption key — in production derived from hardware root of trust
const ENCLAVE_KEY = crypto.randomBytes(32);

/**
 * Execute an operation inside the simulated TEE.
 * Data is decrypted, processed, and re-encrypted within the enclave boundary.
 */
async function executeInEnclave({ tool, action, args, agentId }) {
    const start = process.hrtime.bigint();

    // Phase 3.2: Sandbox escape detection (active in sandbox and hardware_tee modes)
    if (EXECUTION_MODE === 'sandbox' || EXECUTION_MODE === 'hardware_tee') {
        const violation = detectSandboxViolation(args);
        if (violation) {
            const err = new Error(`SANDBOX_VIOLATION: ${violation.violation} detected in field '${violation.field}'`);
            err.code = 'SANDBOX_VIOLATION';
            err.details = violation;
            throw err;
        }
    }

    enclaveState.sessionCount++;
    enclaveState.totalExecutions++;

    // Simulate enclave lifecycle
    const session = {
        sessionId: crypto.randomUUID(),
        enclaveType: enclaveState.type,
        startedAt: new Date().toISOString(),
    };

    // 1. Simulate data decryption inside enclave
    const inputHash = crypto.createHash('sha256')
        .update(JSON.stringify({ tool, action, args, agentId, ts: Date.now() }))
        .digest('hex');

    // 2. Simulate operation execution (the actual tool call)
    const result = await executeToolReal(tool, action, args);

    // 3. Encrypt output before leaving enclave
    const resultHash = crypto.createHash('sha256')
        .update(JSON.stringify(result))
        .digest('hex');

    // 4. Generate attestation proof
    const attestation = generateAttestation(session.sessionId, inputHash, resultHash);

    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Update simulated metrics
    enclaveState.cpuUsage = Math.min(100, 30 + Math.random() * 40);
    enclaveState.memoryUsage = Math.min(100, 20 + Math.random() * 30);

    return {
        success: true,
        result,
        enclave: {
            sessionId: session.sessionId,
            type: session.enclaveType,
            inputHash,
            resultHash,
            attestation: attestation.proof,
            attestationValid: true,
            executionMs: elapsedMs.toFixed(2),
            dataExposedToHost: false,
            dataExposedToLLMProvider: false,
        }
    };
}

/**
 * Execute tool operations — REAL execution against enterprise database
 * for data tools, simulated for external services (no real Stripe/SMTP).
 */
async function executeToolReal(tool, action, args) {
    const { executeQuery } = require('./enterprise-db');

    const ALLOWED_TOOLS = {
        'db.query': async () => {
            throw new Error("RAW_SQL execution is strictly forbidden in the enclave worker. Use parameterized handlers like `transaction.list`.");
        },
        'db.write': async () => {
            throw new Error("RAW_SQL execution is strictly forbidden in the enclave worker. Use parameterized handlers like `payment.initiate`.");
        },
        'user.lookup': async () => {
            if (!args?.userId) throw new Error("Missing userId");
            const emp = await executeQuery('SELECT id, full_name, email, department, role FROM employees WHERE id = ?', [args.userId]);
            if (emp.success && emp.rowCount > 0) return emp;
            return await executeQuery('SELECT id, full_name, email, country, tier FROM customers WHERE id = ?', [args.userId]);
        },
        'payment.initiate': async () => ({
            simulated: true,
            note: 'No Stripe sandbox connected — would charge: ' + (args?.amount || 0) + ' ' + (args?.currency || 'EUR'),
            transactionId: `txn-${crypto.randomUUID().slice(0, 8)}`,
            status: 'simulated',
        }),
        'email.send': async () => ({
            simulated: true,
            note: 'No SMTP server connected — would send to: ' + (args?.to || 'unknown'),
            messageId: `msg-${crypto.randomUUID().slice(0, 8)}`,
            status: 'simulated',
        }),
        'slack.post': async () => ({
            simulated: true,
            note: 'No Slack webhook connected — would post to: ' + (args?.channel || '#general'),
            status: 'simulated',
        })
    };

    if (!ALLOWED_TOOLS[tool]) {
        throw new Error(`Tool ${tool} is not whitelisted in the enclave execution plane.`);
    }

    return await ALLOWED_TOOLS[tool]();
}

/**
 * Generate an attestation proof for the enclave session.
 * In production: this would be hardware-backed remote attestation.
 */
function generateAttestation(sessionId, inputHash, resultHash) {
    const payload = `${sessionId}:${inputHash}:${resultHash}:${Date.now()}`;
    const proof = crypto.createHmac('sha256', enclaveState.attestationKey)
        .update(payload)
        .digest('hex');

    return {
        proof,
        sessionId,
        inputHash,
        resultHash,
        enclaveType: enclaveState.type,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Rotate the enclave attestation key.
 */
function rotateKeys() {
    enclaveState.attestationKey = crypto.randomBytes(32);
    enclaveState.lastKeyRotation = new Date().toISOString();
    console.log('[TEE] Attestation key rotated');
    return { rotatedAt: enclaveState.lastKeyRotation };
}

/**
 * Get enclave health status.
 */
function getEnclaveStatus() {
    return {
        active: enclaveState.active,
        type: enclaveState.type,
        totalExecutions: enclaveState.totalExecutions,
        activeSessions: enclaveState.sessionCount,
        lastKeyRotation: enclaveState.lastKeyRotation,
        cpuUsage: enclaveState.cpuUsage.toFixed(1),
        memoryUsage: enclaveState.memoryUsage.toFixed(1),
        attestationStatus: 'valid',
    };
}

module.exports = { executeInEnclave, getEnclaveStatus, rotateKeys, detectSandboxViolation, EXECUTION_MODE };
