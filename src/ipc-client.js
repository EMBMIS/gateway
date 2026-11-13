/**
 * DWI — IPC Client (Gateway → Enclave Worker)
 * 
 * Sends HMAC-signed execution tickets to the enclave worker process.
 * All communication is via Node IPC (child_process message channel).
 * 
 * Security properties:
 *   - Canonical JSON serialization (deterministic signing)
 *   - HMAC-SHA256 signature per ticket
 *   - 2-second TTL 
 *   - Nonce to prevent replay
 *   - Response signature verification
 */
const crypto = require('crypto');

let workerProcess = null;
let ipcSecret = null;
const pendingRequests = new Map(); // ticketId -> { resolve, reject, timer }
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Initialize the IPC client with the worker process and shared secret.
 */
function init(worker, secret) {
    workerProcess = worker;
    ipcSecret = Buffer.from(secret, 'hex');

    workerProcess.on('message', (msg) => {
        if (msg.type !== 'execution_result') return;
        const pending = pendingRequests.get(msg.ticketId);
        if (!pending) return;

        clearTimeout(pending.timer);
        pendingRequests.delete(msg.ticketId);

        // Verify response signature
        const { signature, ...payload } = msg;
        const expectedSig = signPayload(payload);
        if (!timingSafeCompare(signature, expectedSig)) {
            pending.reject(new Error('Invalid response signature from enclave worker'));
            return;
        }

        if (msg.success) {
            pending.resolve(msg);
        } else {
            pending.reject(new Error(msg.error || 'Enclave execution failed'));
        }
    });
}

/**
 * Send an execution ticket to the enclave worker.
 * Only called AFTER the gateway has approved the request via policy + risk engine.
 */
function execute({ tool, action, args, agentId, agentRole, policy_bundle_hash, risk_score }) {
    return new Promise((resolve, reject) => {
        if (!workerProcess || !ipcSecret) {
            return reject(new Error('Enclave worker not initialized'));
        }

        if (!workerProcess.connected) {
            return reject(new Error('Enclave worker disconnected'));
        }

        const ticketId = crypto.randomUUID();
        const nonce = crypto.randomBytes(16).toString('hex');
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 2000; // 2-second TTL

        const ticket = {
            type: 'execution_ticket',
            ticketId,
            tool,
            action: action || 'EXECUTE',
            args: args || {},
            agentId,
            agentRole,
            policy_bundle_hash,
            risk_score,
            nonce,
            issuedAt,
            expiresAt,
        };

        // Sign with canonical serialization
        ticket.signature = signPayload(ticket);

        // Set timeout
        const timer = setTimeout(() => {
            pendingRequests.delete(ticketId);
            reject(new Error(`Enclave execution timeout (${DEFAULT_TIMEOUT_MS}ms)`));
        }, DEFAULT_TIMEOUT_MS);

        pendingRequests.set(ticketId, { resolve, reject, timer });

        // Send to worker via IPC
        workerProcess.send(ticket);
    });
}

/**
 * Sign a payload using HMAC-SHA256 with canonical JSON serialization.
 * Canonical = sorted keys, no whitespace, deterministic.
 */
function signPayload(obj) {
    const canonical = canonicalize(obj);
    return crypto.createHmac('sha256', ipcSecret).update(canonical).digest('hex');
}

/**
 * Canonical JSON serialization — deterministic key ordering.
 */
function canonicalize(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Get count of pending requests (for monitoring).
 */
function getPendingCount() {
    return pendingRequests.size;
}

module.exports = { init, execute, getPendingCount };
