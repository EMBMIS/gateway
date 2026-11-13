/**
 * @sag/node — EMBMIS Gateway SDK
 *
 * Protect any AI agent tool call in 3 lines:
 *
 *   const sag = require('@sag/node')({ agent: 'my-agent', key: 'xxx' });
 *   const result = await sag.execute('payment.initiate', { amount: 500 });
 *   if (result.blocked) console.log('Blocked:', result.reason);
 *
 * Zero dependencies. Node 18+.
 */

const { v7: uuidv7 } = require('uuid');

const DEFAULT_ENDPOINT = 'http://localhost:3000';
const MAX_PAYLOAD_SIZE = 1048576; // 1MB
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_ARG_DEPTH = 10;

function getArgDepth(obj, currentDepth = 0) {
    if (obj === null || typeof obj !== 'object') return currentDepth;
    if (currentDepth > MAX_ARG_DEPTH) return currentDepth;
    let max = currentDepth;
    for (const key in obj) {
        max = Math.max(max, getArgDepth(obj[key], currentDepth + 1));
    }
    return max;
}

/**
 * Create a SAG client.
 *
 * @param {Object} config
 * @param {string} config.agent     - Agent name (must be registered in SAG)
 * @param {string} config.key       - Agent API key
 * @param {string} [config.endpoint] - SAG Gateway URL (default: http://localhost:3000)
 * @param {number} [config.timeout]  - Request timeout in ms (default: 5000)
 * @param {boolean} [config.failOpen] - If true, allow on SAG unreachable (default: false)
 * @param {Function} [config.onDecision] - Callback fired on every decision
 * @returns {SAGClient}
 */
function createClient(config) {
    if (!config || !config.agent || !config.key) {
        throw new Error('@sag/node: "agent" and "key" are required. Get these from your SAG dashboard.');
    }

    const endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    const timeout = config.timeout || 5000;
    const failOpen = config.failOpen === true;
    const onDecision = config.onDecision || null;

    const retries = config.retries ?? 2;
    const retryBaseDelay = config.retryBaseDelay || 200;
    const circuitBreakerFailures = config.circuitBreakerFailures ?? 5;
    const circuitBreakerResetMs = config.circuitBreakerResetMs || 10000;

    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;

    /**
     * Execute a tool call through the SAG enforcement layer.
     *
     * @param {string} tool    - Tool identifier (e.g. 'payment.initiate', 'db.query')
     * @param {Object} [args]  - Tool arguments / payload
     * @param {Object} [opts]  - Override options for this call
     * @param {string} [opts.action] - Action type (default: 'EXECUTE')
     * @param {Object} [opts.resource] - Resource classification metadata
     * @returns {Promise<SAGResult>}
     */
    async function execute(tool, args, opts) {
        if (!tool || typeof tool !== 'string') {
            throw new Error('@sag/node: "tool" must be a non-empty string.');
        }

        if (tool.length > MAX_TOOL_NAME_LENGTH) {
            throw new SAGError('Tool name exceeds 128 characters', 'INVALID_TOOL_NAME', { tool });
        }

        const argsDepth = getArgDepth(args || {});
        if (argsDepth > MAX_ARG_DEPTH) {
            throw new SAGError('Payload argument depth exceeds 10', 'PAYLOAD_TOO_DEEP', { tool });
        }

        const action = opts?.action || 'EXECUTE';
        const resource = opts?.resource || {};

        const body = JSON.stringify({
            agentApiKey: config.key,
            tool,
            action,
            args: args || {},
            resource,
        });

        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_SIZE) {
            throw new SAGError('Payload exceeds 1MB', 'PAYLOAD_TOO_LARGE', { tool });
        }

        const traceId = uuidv7();
        const spanId = 'sdk-req';

        let response;
        let lastError = null;
        if (Date.now() < circuitOpenUntil) {
            lastError = new Error('Circuit breaker is OPEN');
        } else {
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), timeout);

                    response = await fetch(`${endpoint}/api/gateway/execute`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Agent-Key': config.key,
                            'X-Trace-Id': traceId,
                            'X-Span-Id': spanId
                        },
                        body,
                        signal: controller.signal,
                    });

                    clearTimeout(timer);

                    // Reset circuit breaker on success
                    consecutiveFailures = 0;
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    consecutiveFailures++;

                    if (consecutiveFailures >= circuitBreakerFailures) {
                        circuitOpenUntil = Date.now() + circuitBreakerResetMs;
                        break;
                    }

                    if (attempt < retries) {
                        const delay = retryBaseDelay * Math.pow(2, attempt);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
        }

        if (lastError) {
            // Network failure or circuit open
            if (failOpen) {
                const failResult = {
                    allowed: true,
                    blocked: false,
                    status: 'FAIL_OPEN',
                    tool,
                    action,
                    reason: 'SAG unreachable or circuit open — fail-open policy applied',
                    raw: null,
                    traceId
                };
                if (onDecision) onDecision(failResult);
                return failResult;
            }
            throw new SAGError(
                `SAG unreachable at ${endpoint}. Set failOpen:true to allow on outage.`,
                lastError.message === 'Circuit breaker is OPEN' ? 'CIRCUIT_OPEN' : 'NETWORK_ERROR',
                { tool, action, cause: lastError.message }
            );
        }

        const data = await response.json();

        const allowed = response.status === 200;
        const blocked = response.status === 403;

        const result = {
            allowed,
            blocked,
            status: data.status || (allowed ? 'APPROVED' : blocked ? 'DENIED' : 'ERROR'),
            tool,
            action,
            reason: data.reason || data.error || null,
            riskScore: data.riskScore ?? null,
            traceId: data.traceId ?? null,
            policyMatch: data.matchedPolicy ?? null,
            executionResult: data.executionResult ?? null,
            latencyMs: data.latencyMs ?? null,
            raw: data,
        };

        if (onDecision) onDecision(result);
        return result;
    }

    /**
     * Check if a tool call would be allowed without executing it.
     * Uses the /simulate endpoint for dry-run policy evaluation.
     *
     * @param {string} tool
     * @param {Object} [args]
     * @returns {Promise<{allowed: boolean, risk: number, reason: string}>}
     */
    async function check(tool, args) {
        const body = JSON.stringify({
            agentName: config.agent,
            tool,
            action: 'EXECUTE',
            resource: {},
        });

        const res = await fetch(`${endpoint}/api/gateway/simulate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        const data = await res.json();
        return {
            allowed: data.finalDecision === 'allow',
            risk: data.risk?.score ?? 0,
            reason: data.policy?.reason || data.finalDecision,
            raw: data,
        };
    }

    /**
     * Get audit trail for this agent's recent actions.
     *
     * @param {number} [limit=10]
     * @returns {Promise<Array>}
     */
    async function history(limit) {
        const res = await fetch(`${endpoint}/api/audit?limit=${limit || 10}`);
        return res.json();
    }

    /**
     * Explain a decision in full detail.
     * Returns policy result, every risk factor, threshold comparison.
     * No execution — pure inspection.
     *
     * @param {string} tool
     * @param {Object} [args]
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async function explain(tool, args, opts) {
        const res = await fetch(`${endpoint}/api/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentKey: config.key,
                tool,
                action: opts?.action || 'EXECUTE',
                args: args || {},
                resource: opts?.resource || {},
            }),
        });
        return res.json();
    }

    return { execute, check, history, explain };
}

/**
 * Custom error class for SAG failures.
 */
class SAGError extends Error {
    constructor(message, code, context) {
        super(message);
        this.name = 'SAGError';
        this.code = code;
        this.context = context;
    }
}

// Export as factory function
module.exports = createClient;
module.exports.createClient = createClient;
module.exports.SAGError = SAGError;
