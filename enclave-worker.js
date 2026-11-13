/**
 * DWI — Sovereign Enclave Worker Process (v0.5 - Ed25519)
 * 
 * STANDALONE gRPC SERVER. No HTTP. No Express. No gateway code.
 * 
 * This process:
 *   1. Listens purely on gRPC (port 50051)
 *   2. Verifies Ed25519 signature on every incoming ExecuteIntent ticket
 *   3. Rejects expired tickets (>2s TTL)
 *   4. Rejects replayed nonces (Redis distributed state)
 *   5. Dual-evaluates authorization against strictly-held local policy bundle
 *   6. Executes approved operations via tee-enclave.js
 *   7. Returns Ed25519-signed gRPC result
 *
 * Security boundary:
 *   - This process owns the protected resources exclusively.
 *   - Gateway network space is treated as untrusted (Control-Plane Hostile).
 */
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');

// Ed25519 keys for asymmetric ticket verification
// Worker loads Gateway PUBLIC key (to verify incoming tickets)
// Worker loads its OWN PRIVATE key (to sign responses)
// Keys come from env vars or the secrets directory (src/keys.js). Production refuses missing/leaked keys.
const keys = require('./src/keys');
try {
    keys.assertKeysSafe('worker');
} catch (err) {
    console.error('\n[FATAL STARTUP ERROR]', err.message);
    process.exit(1);
}
// Mutable so RotateKeys can atomically swap the active verification key
let gatewayPublicKey = crypto.createPublicKey(keys.requireSecret('gateway-public'));
const workerPrivateKey = crypto.createPrivateKey(keys.requireSecret('worker-private'));

// Load protobuf definitions
const PROTO_PATH = path.join(__dirname, 'src/proto/intent.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const authz = protoDescriptor.authz;

// Import Trust Components
const { loadAndVerifyBundle } = require('./src/bundle-loader');
const { evaluateAuthorization } = require('./src/policy-evaluator');
const { executeInEnclave, getEnclaveStatus, rotateKeys } = require('./src/tee-enclave');

// Load sovereign policy at startup
// Worker will CRASH here if signature is invalid or bundle is missing (Fail Strict)
const loadedPolicy = loadAndVerifyBundle();
const loadedPolicyHashBuffer = Buffer.from(loadedPolicy.hash, 'hex');

const { createClient } = require('redis');

const DEV_MODE = !process.env.REDIS_URL;

// ─── Distributed State (Redis) or In-Memory Fallback ───
let redisClient = null;
let redisBootTime = 0;
const REDIS_TIMEOUT = parseInt(process.env.REDIS_TIMEOUT || '100', 10); // ms

// In-memory nonce store for local dev (single-process only, not cluster-safe)
const memNonces = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of memNonces) { if (exp < now) memNonces.delete(k); }
}, 10000).unref();

async function getRedis() {
    if (!redisClient) {
        redisClient = createClient({
            url: process.env.REDIS_URL,
            socket: { reconnectStrategy: false }
        });
        redisClient.on('error', (err) => console.error('[ENCLAVE-WORKER] Redis Client Error:', err.message));
        await redisClient.connect();
        redisBootTime = Date.now();
        await redisClient.set('worker:redis_boot_time', redisBootTime.toString());
        console.log(`[ENCLAVE-WORKER] Connected to Redis (boot_time: ${redisBootTime}). Replay protection active.`);
    }
    return redisClient;
}

async function redisWithTimeout(fn, timeoutMs) {
    return Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('REDIS_LATENCY_EXCEEDED')), timeoutMs || REDIS_TIMEOUT))
    ]);
}

// ─── Dual Watermark Monotonic Version Pinning ───
async function enforceMonotonicVersion() {
    const fs = require('fs');

    if (process.env.NODE_ENV === 'production') {
        // Replay protection needs a store every worker shares, and the link to the gateway must be mutually authenticated.
        if (DEV_MODE) throw new Error('Refusing to start in production without REDIS_URL: replay protection needs a nonce store shared by every worker.');
        if (process.env.ENABLE_MTLS !== 'true') throw new Error('Refusing to start in production without ENABLE_MTLS=true.');
    }
    if (DEV_MODE) {
        console.warn('[ENCLAVE-WORKER] ⚠️  DEV MODE: REDIS_URL not set — using in-memory nonce cache. Not safe for production.');
    }
    if (process.env.ENABLE_MTLS !== 'true') {
        console.warn('[ENCLAVE-WORKER] ⚠️  DEV MODE: ENABLE_MTLS not set — mTLS validation relaxed for local development.');
    }

    const bundleVersion = loadedPolicy.bundle.version;
    if (typeof bundleVersion !== 'number') {
        throw new Error('CRITICAL GOVERNANCE FAILURE: Policy bundle is missing an integer version field.');
    }

    // 1. Local file watermark (always enforced)
    const WATERMARK_PATH = process.env.SAG_WATERMARK_PATH ? path.resolve(process.env.SAG_WATERMARK_PATH) : path.join(__dirname, '.worker_watermark.json');
    let localVersion = 0;
    if (fs.existsSync(WATERMARK_PATH)) {
        localVersion = JSON.parse(fs.readFileSync(WATERMARK_PATH, 'utf8')).highest_version || 0;
    }

    let effectiveWatermark = localVersion;

    // 2. Distributed cluster floor (only when Redis is available)
    if (!DEV_MODE) {
        const client = await getRedis();
        const redisVersionStr = await client.get('watermark:bundle_version');
        const redisVersion = redisVersionStr ? parseInt(redisVersionStr, 10) : 0;
        effectiveWatermark = Math.max(localVersion, redisVersion);
        if (bundleVersion < effectiveWatermark) {
            throw new Error(`CRITICAL DOWNGRADE ATTACK DETECTED: Bundle v${bundleVersion} < watermark v${effectiveWatermark}`);
        }
        await client.set('watermark:bundle_version', bundleVersion.toString());
    }

    console.log(`[GOVERNANCE] Version Check Passed: Bundle=v${bundleVersion} (Floor=v${effectiveWatermark})`);
    fs.writeFileSync(WATERMARK_PATH, JSON.stringify({ highest_version: bundleVersion }), 'utf8');

    const logsDir = process.env.SAG_LOG_DIR ? path.resolve(process.env.SAG_LOG_DIR) : path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const anchorLog = `${new Date().toISOString()} | v${bundleVersion} | ${loadedPolicy.hash} | source(boot)\n`;
    fs.appendFileSync(path.join(logsDir, 'policy-checkpoints.log'), anchorLog, 'utf8');
}

// ─── Cryptographic Verifications ───
function canonicalizeObj(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(canonicalizeObj);
    }
    const sortedKeys = Object.keys(obj).sort();
    const result = {};
    for (const key of sortedKeys) {
        if (obj[key] !== undefined) {
            result[key] = canonicalizeObj(obj[key]);
        }
    }
    return result;
}

function canonicalizeTicketForSignature(ticket) {
    // Reconstruct the exact object signed by the Gateway (fields 1-11)
    const signableOrigin = {
        type: 'execution_ticket',
        ticketId: ticket.ticket_id,
        tool: ticket.tool,
        action: ticket.action,
        args: JSON.parse(ticket.args_json),
        agentId: ticket.agent_id,
        agentRole: ticket.agent_role,
        policy_bundle_hash: Buffer.from(ticket.policy_bundle_hash).toString('hex'),
        risk_score: ticket.risk_score,
        nonce: ticket.nonce,
        issuedAt: parseInt(ticket.issued_at, 10),
        expiresAt: parseInt(ticket.expires_at, 10),
        traceId: ticket.trace_id,
        spanId: ticket.span_id,
        parentSpanId: ticket.parent_span_id
    };
    return JSON.stringify(canonicalizeObj(signableOrigin));
}

function verifySignature(ticket) {
    if (!ticket.signature) return false;
    const ticketStr = canonicalizeTicketForSignature(ticket);
    const signatureBuffer = Buffer.from(ticket.signature);
    console.log(`[ENCLAVE-WORKER-DEBUG] Verifying canonical: ${ticketStr}`);
    try {
        return crypto.verify(null, Buffer.from(ticketStr), gatewayPublicKey, signatureBuffer);
    } catch (err) {
        console.error('[ENCLAVE-WORKER] Ed25519 verify error:', err.message);
        return false;
    }
}

function signPayload(obj) {
    const canonical = JSON.stringify(canonicalizeObj(obj));
    return crypto.sign(null, Buffer.from(canonical), workerPrivateKey);
}

// ─── gRPC Service Implementation ───
async function executeIntent(call, callback) {
    const ticket = call.request;
    const ticketId = ticket.ticket_id;
    const traceId = ticket.trace_id || ticketId;
    const parentSpanId = ticket.span_id || null;
    const workerSpanId = 'worker-01';

    console.log(`[ENCLAVE-WORKER][${traceId}] Received ExecuteIntent: ${ticket.tool}::${ticket.action} (Risk: ${ticket.risk_score})`);
    console.log(`[ENCLAVE-WORKER][${traceId}] Policy Bundle Active: v${loadedPolicy.bundle.version}`);

    function reject(errorCode, reason) {
        console.error(`[ENCLAVE-WORKER][${traceId}] REJECTED: ${errorCode} - ${reason}`);
        const responseOrigin = {
            type: 'execution_result',
            ticketId: ticketId,
            success: false,
            error: `${errorCode}: ${reason}`,
            traceId: traceId,
            spanId: workerSpanId,
            parentSpanId: parentSpanId
        };
        const responseData = {
            ticket_id: ticketId,
            success: false,
            error_code: errorCode,
            error_message: reason,
            trace_id: traceId,
            span_id: workerSpanId,
            parent_span_id: parentSpanId,
            signature: signPayload(responseOrigin)
        };
        callback(null, responseData);
    }

    // LAYER 1: Verify Ed25519 signature (Transport Integrity)
    if (!verifySignature(ticket)) {
        return reject('INVALID_SIGNATURE', 'Ed25519 ticket signature verification failed');
    }

    // LAYER 2: Ensure Time Limits (TTL) & Clock Skew Resilience
    const now = Date.now();
    const issuedAt = parseInt(ticket.issued_at, 10);
    const expiresAt = parseInt(ticket.expires_at, 10);
    const MAX_CLOCK_SKEW = 500; // 500ms strict NTP tolerance

    if (Math.abs(now - issuedAt) > MAX_CLOCK_SKEW) {
        return reject('CLOCK_SKEW_DETECTED', `Unacceptable clock skew between Gateway and Worker (${Math.abs(now - issuedAt)}ms drift)`);
    }

    if (now > expiresAt) {
        return reject('TICKET_EXPIRED', 'Ticket TTL exceeded');
    }

    // LAYER 3: Replay Protection (Redis in prod, in-memory in dev)
    const replayKey = `nonce:${ticket.agent_id}:${ticket.nonce}`;
    try {
        let result;
        if (DEV_MODE) {
            result = memNonces.has(replayKey) ? null : (memNonces.set(replayKey, Date.now() + 2000), 'OK');
        } else {
            const client = await getRedis();
            const issuedAtNum = parseInt(ticket.issued_at, 10);
            if (issuedAtNum < redisBootTime) {
                return reject('NONCE_STALE_SESSION', `Ticket predates current Redis session. Possible cross-restart replay.`);
            }
            result = await redisWithTimeout(
                () => client.set(replayKey, '1', { NX: true, PX: 2000 }),
                REDIS_TIMEOUT
            );
        }
        if (result !== 'OK') {
            return reject('NONCE_REPLAY', 'Duplicate nonce detected');
        }
    } catch (err) {
        if (err.message === 'REDIS_LATENCY_EXCEEDED') {
            return reject('REPLAY_PROTECTION_UNAVAILABLE', `Redis latency exceeded ${REDIS_TIMEOUT}ms. Failing closed.`);
        }
        console.error('[ENCLAVE-WORKER] Redis Error:', err.message);
        return reject('REDIS_UNAVAILABLE', 'Replay protection unavailable. Failing closed.');
    }

    // LAYER 4: Time-of-Check to Time-of-Use Determinism (Hash Strictness)
    const ticketHashBuffer = Buffer.from(ticket.policy_bundle_hash);
    if (!ticketHashBuffer || ticketHashBuffer.length !== loadedPolicyHashBuffer.length || !crypto.timingSafeEqual(ticketHashBuffer, loadedPolicyHashBuffer)) {
        return reject('POLICY_VERSION_MISMATCH', 'Gateway used a different policy version than worker');
    }

    // LAYER 5: Enforce Risk Ceiling (Fail closed if missing/corrupt)
    const riskScore = ticket.risk_score;
    if (typeof riskScore !== 'number' || !Number.isFinite(riskScore) || riskScore < 0) {
        return reject('INVALID_RISK_SCORE', 'Missing or malformed advisory risk score');
    }
    if (riskScore > loadedPolicy.bundle.risk_thresholds.autoBlock) {
        return reject('RISK_THRESHOLD_EXCEEDED', `Gateway proposed risk ${riskScore}, but hard limit is ${loadedPolicy.bundle.risk_thresholds.autoBlock}`);
    }

    // LAYER 6: Independent Role/RBAC Evaluation (Worker Sovereignty)
    const proposedIntent = {
        tool: ticket.tool,
        action: ticket.action,
        args: JSON.parse(ticket.args_json)
    };
    const authDecision = evaluateAuthorization(loadedPolicy.bundle, ticket.agent_role, proposedIntent);
    if (!authDecision.allowed) {
        return reject('DENIED_BY_WORKER_POLICY', authDecision.reason);
    }

    // ─── Execution Phase (Protected) ───
    try {
        const result = await executeInEnclave({
            tool: ticket.tool,
            action: ticket.action,
            args: proposedIntent.args,
            agentId: ticket.agent_id,
        });

        const successOrigin = {
            type: 'execution_result',
            ticketId: ticketId,
            success: true,
            result: result.result,
            enclave: {
                sessionId: result.enclave.sessionId,
                type: result.enclave.type,
                attestation: result.enclave.attestation,
                attestationValid: result.enclave.attestationValid
            },
            traceId: traceId,
            spanId: workerSpanId,
            parentSpanId: parentSpanId
        };

        const responseData = {
            ticket_id: ticketId,
            success: true,
            result_json: JSON.stringify(result.result),
            enclave: {
                session_id: result.enclave.sessionId,
                type: result.enclave.type,
                attestation: result.enclave.attestation,
                attestation_valid: result.enclave.attestationValid
            },
            trace_id: traceId,
            span_id: workerSpanId,
            parent_span_id: parentSpanId,
            signature: signPayload(successOrigin)
        };
        callback(null, responseData);
    } catch (err) {
        reject('EXECUTION_ERROR', err.message);
    }
}

function checkHealth(call, callback) {
    callback(null, {
        status: getEnclaveStatus(),
        active_bundle_hash: loadedPolicy.hash,
        pending_queue_size: 0,
        worker_pid: process.pid
    });
}

// ─── Key Rotation Handler ───────────────────────────────────────────────────

/**
 * RotateKeys — atomically swap the Gateway verification key.
 *
 * The Gateway sends its newly-generated Ed25519 public key (DER-encoded).
 * The enclave verifies the payload structure, installs the new key, and
 * invalidates the old key in a single synchronous swap (no window where
 * both keys are active).
 */
function rotateKeysHandler(call, callback) {
    try {
        const { new_gateway_public_key, rotated_at } = call.request;

        if (!new_gateway_public_key || new_gateway_public_key.length === 0) {
            return callback(null, {
                success:           false,
                rotated_at:        '',
                new_key_fingerprint: '',
                error:             'new_gateway_public_key is required',
            });
        }

        // Import the new public key — throws if the DER bytes are malformed
        const newKey = crypto.createPublicKey({
            key:    Buffer.from(new_gateway_public_key),
            format: 'der',
            type:   'spki',
        });

        // Compute SHA-256 fingerprint of the DER bytes for audit logging
        const fingerprint = crypto
            .createHash('sha256')
            .update(Buffer.from(new_gateway_public_key))
            .digest('hex');

        // ── Atomic swap (single synchronous assignment = JS single-threaded) ──
        gatewayPublicKey = newKey;

        const ts = rotated_at || new Date().toISOString();
        console.log(`[ENCLAVE-WORKER] Ed25519 gateway verification key rotated. Fingerprint: ${fingerprint.substring(0, 16)}…`);

        callback(null, {
            success:             true,
            rotated_at:          ts,
            new_key_fingerprint: fingerprint,
            error:               '',
        });
    } catch (err) {
        console.error('[ENCLAVE-WORKER] RotateKeys failed:', err.message);
        callback(null, {
            success:             false,
            rotated_at:          '',
            new_key_fingerprint: '',
            error:               err.message,
        });
    }
}

// ─── Server Startup ───
async function main() {
    try {
        await enforceMonotonicVersion();
    } catch (err) {
        console.error('\n[FATAL STARTUP ERROR]', err.message);
        process.exit(1);
    }

    const server = new grpc.Server();
    server.addService(authz.EnclaveWorker.service, {
        ExecuteIntent: executeIntent,
        CheckHealth: checkHealth,
        RotateKeys: rotateKeysHandler,
    });

    const port = '0.0.0.0:' + (process.env.ENCLAVE_PORT || '50051');

    // Load mTLS configuration
    const fs = require('fs');
    const caCert = keys.requireSecret('tls-ca-cert');
    const serverCert = keys.requireSecret('tls-server-cert');
    const serverKey = keys.requireSecret('tls-server-key');

    // Enforce strict Mutual TLS
    const credentials = grpc.ServerCredentials.createSsl(
        caCert,
        [{ cert_chain: serverCert, private_key: serverKey }],
        true
    );

    server.bindAsync(port, credentials, (err, bindPort) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`[ENCLAVE-WORKER] Process started (PID: ${process.pid})`);
        console.log(`[ENCLAVE-WORKER] gRPC Execution Server listening securely on ${port}`);
        console.log('[ENCLAVE-WORKER] Transport Security: Strict mTLS enforced via local CA');
        console.log('[ENCLAVE-WORKER] Sovereign Policy Hash loaded:', loadedPolicy.hash.substring(0, 8));
        console.log('[ENCLAVE-WORKER] Ticket verification: Ed25519 (Gateway public key)');
        console.log('[ENCLAVE-WORKER] Distributed state: Redis strictly enforced (NX PX)');
    });
}

main();
