'use strict';

/**
 * SAG — gRPC Client Pool (Gateway → Enclave Workers)
 *
 * Maintains a pool of gRPC stubs, one per enclave-worker address.
 * Dispatches execution tickets via round-robin with automatic
 * failure tracking and health-based routing.
 *
 * Security properties (unchanged from single-worker version):
 *   - Canonical JSON serialization (deterministic, recursive key sorting)
 *   - Ed25519 asymmetric ticket signing (Gateway private key)
 *   - Worker response signature verification (Worker public key)
 *   - Per-ticket nonce + 2-second TTL
 */

const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');
const keys = require('./keys');

// ─── Protobuf definition (loaded once at module init) ─────────────────────────
const PROTO_PATH = path.join(__dirname, 'proto', 'intent.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const authz = grpc.loadPackageDefinition(packageDefinition).authz;

// ─── Pool state ───────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   stub:        object,
 *   address:     string,
 *   healthy:     boolean,
 *   failures:    number,
 *   lastFailure: number
 * }} PoolEntry
 */

/** @type {PoolEntry[]} */
let pool = [];
let rrIndex = 0; // round-robin cursor

let gatewayPrivateKey = null; // Ed25519 private key for signing tickets
let workerPublicKey   = null; // Ed25519 public key  for verifying responses

/** How many consecutive failures before a stub is temporarily removed from rotation */
const UNHEALTHY_THRESHOLD = 3;
/** How long (ms) an unhealthy stub sits out before being retried */
const RECOVERY_WINDOW_MS = 30_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the client pool.
 * @param {string|string[]} addresses  Single address or array of worker addresses.
 */
function init(addresses, _unused) {
    // Load mTLS material and Ed25519 keys (env vars or the secrets directory — see src/keys.js)
    keys.assertKeysSafe('gateway');
    const caCert     = keys.requireSecret('tls-ca-cert');
    const clientCert = keys.requireSecret('tls-client-cert');
    const clientKey  = keys.requireSecret('tls-client-key');

    gatewayPrivateKey = crypto.createPrivateKey(keys.requireSecret('gateway-private'));
    workerPublicKey   = crypto.createPublicKey(keys.requireSecret('worker-public'));

    const credentials = grpc.credentials.createSsl(caCert, clientKey, clientCert);
    const chanOpts = {
        'grpc.ssl_target_name_override': 'localhost',
        'grpc.default_authority': 'localhost',
    };

    const list = Array.isArray(addresses) ? addresses : [addresses];

    pool = list.map(address => ({
        stub:        new authz.EnclaveWorker(address, credentials, chanOpts),
        address,
        healthy:     true,
        failures:    0,
        lastFailure: 0,
    }));

    rrIndex = 0;

    console.log(`[GRPC-POOL] Initialized with ${pool.length} worker(s): ${list.join(', ')}`);
}

/**
 * Returns true if the client pool has been initialised.
 * @returns {boolean}
 */
function isInitialized() {
    return pool.length > 0 && !!gatewayPrivateKey;
}

/**
 * Send an execution ticket to the next healthy enclave worker.
 * Falls back through the pool on transient errors.
 */
function execute({ tool, action, args, agentId, agentRole, policy_bundle_hash, risk_score, traceId, spanId, parentSpanId }) {
    if (!isInitialized()) {
        return Promise.reject(new Error('gRPC client pool not initialised — call init() first'));
    }

    const available = _pickHealthyOrder();
    if (available.length === 0) {
        return Promise.reject(new Error('All enclave workers are currently unavailable'));
    }

    // Try workers in round-robin order; fall back to next on hard error
    return _tryInOrder(available, 0, { tool, action, args, agentId, agentRole, policy_bundle_hash, risk_score, traceId, spanId, parentSpanId });
}

/**
 * Pool status — useful for /api/workers/status endpoint.
 */
function poolStatus() {
    return pool.map(e => ({
        address: e.address,
        healthy: e.healthy,
        failures: e.failures,
        lastFailure: e.lastFailure ? new Date(e.lastFailure).toISOString() : null,
    }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build an ordered list of pool entries starting at the current round-robin
 * position, skipping entries that are unhealthy and still in their cool-down.
 */
function _pickHealthyOrder() {
    const now = Date.now();
    const result = [];

    for (let i = 0; i < pool.length; i++) {
        const entry = pool[(rrIndex + i) % pool.length];

        // Recover entries whose cool-down has expired
        if (!entry.healthy && now - entry.lastFailure >= RECOVERY_WINDOW_MS) {
            console.log(`[GRPC-POOL] Recovering worker ${entry.address} after cool-down`);
            entry.healthy  = true;
            entry.failures = 0;
        }

        if (entry.healthy) result.push(entry);
    }

    // Advance the global cursor so the next call starts at the next worker
    rrIndex = (rrIndex + 1) % Math.max(pool.length, 1);

    return result;
}

/** Attempt execution against each entry in order, moving on after a transport error. */
function _tryInOrder(entries, idx, params) {
    if (idx >= entries.length) {
        return Promise.reject(new Error('All attempted enclave workers failed'));
    }
    const entry = entries[idx];

    return _executeOnStub(entry.stub, params)
        .then(result => {
            // Success — reset failure count
            entry.failures = 0;
            entry.healthy  = true;
            return result;
        })
        .catch(err => {
            // Transport / connectivity error → penalise this worker and try the next
            entry.failures++;
            entry.lastFailure = Date.now();
            if (entry.failures >= UNHEALTHY_THRESHOLD) {
                entry.healthy = false;
                console.error(`[GRPC-POOL] Worker ${entry.address} marked unhealthy after ${entry.failures} failures`);
            }

            // Application-level denials (DENIED_BY_WORKER_POLICY etc.) are not transport errors;
            // they are legitimate responses from the worker — don't retry them.
            if (err._isAppError) return Promise.reject(err);

            console.warn(`[GRPC-POOL] Worker ${entry.address} failed (${err.message}); trying next in pool`);
            return _tryInOrder(entries, idx + 1, params);
        });
}

/**
 * Core stub call — builds, signs, and sends the execution ticket; then verifies the response.
 */
function _executeOnStub(stub, { tool, action, args, agentId, agentRole, policy_bundle_hash, risk_score, traceId, spanId, parentSpanId }) {
    return new Promise((resolve, reject) => {
        if (!stub || !gatewayPrivateKey) {
            return reject(new Error('gRPC stub or signing key not available'));
        }

        const ticketId  = crypto.randomUUID();
        const nonce     = crypto.randomBytes(16).toString('hex');
        const issuedAt  = Date.now();
        const expiresAt = issuedAt + 2000; // 2-second TTL

        const ticket = {
            ticket_id:          ticketId,
            tool,
            action:             action || 'EXECUTE',
            args_json:          JSON.stringify(args || {}),
            agent_id:           agentId,
            agent_role:         agentRole,
            policy_bundle_hash: Buffer.from(policy_bundle_hash, 'hex'),
            risk_score,
            nonce,
            issued_at:          issuedAt,
            expires_at:         expiresAt,
            trace_id:           traceId || ticketId,
            span_id:            spanId,
            parent_span_id:     parentSpanId,
        };

        // Build signable payload matching the Worker's canonical form exactly
        const signableOrigin = {
            type:               'execution_ticket',
            ticketId:           ticket.ticket_id,
            tool:               ticket.tool,
            action:             ticket.action,
            args:               JSON.parse(ticket.args_json),
            agentId:            ticket.agent_id,
            agentRole:          ticket.agent_role,
            policy_bundle_hash: Buffer.from(ticket.policy_bundle_hash).toString('hex'),
            risk_score:         ticket.risk_score,
            nonce:              ticket.nonce,
            issuedAt:           parseInt(ticket.issued_at, 10),
            expiresAt:          parseInt(ticket.expires_at, 10),
            traceId:            ticket.trace_id,
            spanId:             ticket.span_id,
            parentSpanId:       ticket.parent_span_id,
        };

        ticket.signature = signPayload(signableOrigin);

        stub.ExecuteIntent(ticket, (err, response) => {
            if (err) {
                // gRPC transport error — let the pool try another worker
                return reject(err);
            }

            // Verify the worker's Ed25519 response signature
            const responseOrigin = {
                type:         'execution_result',
                ticketId:     response.ticket_id,
                success:      Boolean(response.success),
                traceId:      response.trace_id,
                spanId:       response.span_id,
                parentSpanId: response.parent_span_id,
            };

            if (response.success) {
                responseOrigin.result  = JSON.parse(response.result_json);
                responseOrigin.enclave = {
                    sessionId:        response.enclave.session_id,
                    type:             response.enclave.type,
                    attestation:      response.enclave.attestation,
                    attestationValid: Boolean(response.enclave.attestation_valid),
                };
            } else {
                responseOrigin.error = `${response.error_code}: ${response.error_message}`;
            }

            const responseCanonical   = Buffer.from(JSON.stringify(canonicalizeObj(responseOrigin)));
            const providedSigBuffer   = Buffer.from(response.signature);
            const sigValid = crypto.verify(null, responseCanonical, workerPublicKey, providedSigBuffer);

            if (!sigValid) {
                console.error('[GRPC-POOL] Ed25519 response signature verification failed!');
                return reject(new Error('Invalid response signature from enclave worker'));
            }

            if (response.success) {
                resolve({
                    ticketId:   response.ticket_id,
                    success:    true,
                    result:     responseOrigin.result,
                    enclave:    responseOrigin.enclave,
                    workerTrace: { spanId: response.span_id, parentSpanId: response.parent_span_id },
                });
            } else {
                // Application-level denial — tag so the pool doesn't retry it
                const appErr = new Error(responseOrigin.error);
                appErr._isAppError = true;
                reject(appErr);
            }
        });
    });
}

/** Ed25519 sign with recursive canonical JSON serialization. */
function signPayload(obj) {
    const canonical = JSON.stringify(canonicalizeObj(obj));
    console.log(`[GRPC-POOL-DEBUG] Signing canonical: ${canonical}`);
    return crypto.sign(null, Buffer.from(canonical), gatewayPrivateKey);
}

/** Recursive canonical JSON — deterministic key ordering at all depths. */
function canonicalizeObj(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(canonicalizeObj);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        if (obj[key] !== undefined) sorted[key] = canonicalizeObj(obj[key]);
    }
    return sorted;
}

/**
 * Broadcast a RotateKeys request to all healthy enclave workers.
 * Each worker atomically swaps its gateway verification key.
 *
 * @param {Buffer} newPublicKeyDer  DER-encoded Ed25519 public key
 * @param {string} rotatedAt        ISO-8601 timestamp
 * @returns {Promise<{ success: boolean, rotatedAt: string, newKeyFingerprint: string, workerResults: Array }>}
 */
function rotateKeys(newPublicKeyDer, rotatedAt) {
    if (!isInitialized()) {
        return Promise.reject(new Error('gRPC client pool not initialised'));
    }

    const healthy = pool.filter(e => e.healthy);
    if (healthy.length === 0) {
        return Promise.reject(new Error('No healthy enclave workers to rotate keys on'));
    }

    const request = {
        new_gateway_public_key: newPublicKeyDer,
        rotated_at:             rotatedAt || new Date().toISOString(),
    };

    const calls = healthy.map(entry =>
        new Promise((resolve) => {
            entry.stub.RotateKeys(request, (err, response) => {
                if (err) {
                    resolve({ address: entry.address, success: false, error: err.message });
                } else {
                    resolve({
                        address:           entry.address,
                        success:           response.success,
                        newKeyFingerprint: response.new_key_fingerprint,
                        rotatedAt:         response.rotated_at,
                        error:             response.error || null,
                    });
                }
            });
        })
    );

    return Promise.all(calls).then(results => {
        const allOk       = results.every(r => r.success);
        const fingerprint = results.find(r => r.newKeyFingerprint)?.newKeyFingerprint || '';
        return {
            success:           allOk,
            rotatedAt:         rotatedAt || new Date().toISOString(),
            newKeyFingerprint: fingerprint,
            workerResults:     results,
        };
    });
}

module.exports = { init, execute, isInitialized, poolStatus, rotateKeys };
