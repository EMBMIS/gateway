/**
 * SAG — LLM Intent Analyzer (Production-Resilient)
 * 
 * Analyzes tool call arguments for semantic deception using LLM.
 * The LLM NEVER makes allow/deny decisions — it only produces a suspicion
 * score that feeds into the deterministic risk engine.
 * 
 * RESILIENCE FEATURES:
 *  1. Circuit Breaker — disables LLM after consecutive failures
 *  2. Smart Fallback — regex/heuristic scoring when LLM is unavailable
 *  3. Structured Output — enforces { score, flags[], reasoning } schema
 *  4. Payload Cache — SHA-256 hash dedup avoids redundant LLM calls
 */
const crypto = require('crypto');

// ─── Config ───
function getLlmConfig() {
    return {
        key: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
        model: process.env.LLM_MODEL || 'gpt-5-nano',
        endpoint: process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/responses',
        timeout: parseInt(process.env.LLM_TIMEOUT_MS || '3000')
    };
}

// ─── Circuit Breaker State ───
const circuitBreaker = {
    failures: 0,
    lastFailure: 0,
    open: false,
    THRESHOLD: 3,            // open after 3 consecutive failures
    RECOVERY_MS: 30_000,     // try again after 30s
    totalTimeouts: 0,
    totalErrors: 0,
    totalSuccess: 0,
    totalFallbacks: 0,
    totalCacheHits: 0,
};

function recordSuccess() {
    circuitBreaker.failures = 0;
    circuitBreaker.open = false;
    circuitBreaker.totalSuccess++;
}

function recordFailure(reason) {
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();
    if (reason === 'timeout') circuitBreaker.totalTimeouts++;
    else circuitBreaker.totalErrors++;
    if (circuitBreaker.failures >= circuitBreaker.THRESHOLD) {
        circuitBreaker.open = true;
        console.warn(`[INTENT-ANALYZER] ⚡ Circuit breaker OPEN — LLM disabled for ${circuitBreaker.RECOVERY_MS / 1000}s`);
    }
}

function isCircuitOpen() {
    if (!circuitBreaker.open) return false;
    if (Date.now() - circuitBreaker.lastFailure > circuitBreaker.RECOVERY_MS) {
        console.log('[INTENT-ANALYZER] Circuit breaker HALF-OPEN — testing LLM...');
        circuitBreaker.open = false;
        circuitBreaker.failures = 0;
        return false;
    }
    return true;
}

// ─── Payload Cache (in-memory, TTL 1 hour) ───
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 500;

function normalizePayload(obj) {
    if (!obj || typeof obj !== 'object') return JSON.stringify(obj);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        if (['timestamp', 'nonce', 'requestId', 'traceId'].includes(key)) continue;
        sorted[key] = obj[key];
    }
    return JSON.stringify(sorted);
}

function getCacheKey(tool, action, args) {
    const normalized = `${tool}:${action}:${normalizePayload(args)}`;
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    circuitBreaker.totalCacheHits++;
    return entry.result;
}

function setCache(key, result) {
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { result, ts: Date.now() });
}

// ─── Smart Heuristic Fallback ───
// When LLM is unavailable, use regex/pattern matching for baseline scoring

const HIGH_RISK_PATTERNS = [
    { pattern: /offshore|cayman|panama|shell.?company/i, flag: 'offshore_entity', weight: 12 },
    { pattern: /\b\d{6,}\b/, flag: 'high_numeric_value', weight: 5 },
    { pattern: /ignore.*previous|disregard.*instruction|you are now/i, flag: 'prompt_injection', weight: 20 },
    { pattern: /base64|eval\(|exec\(|system\(/i, flag: 'code_execution', weight: 18 },
    { pattern: /\/etc\/passwd|\.\.\/|\.\.\\|cmd\.exe|powershell/i, flag: 'path_traversal', weight: 15 },
    { pattern: /drop\s+table|union\s+select|;\s*delete/i, flag: 'sql_injection', weight: 18 },
    { pattern: /\broot\b.*\bpassword\b|\bpassword\b.*\broot\b/i, flag: 'credential_access', weight: 10 },
    { pattern: /transfer|wire|payment/i, flag: 'financial_action', weight: 3 },
    { pattern: /external.*domain|@(?!company|internal)/i, flag: 'external_target', weight: 5 },
];

function heuristicFallback(tool, action, args) {
    const text = `${tool} ${action} ${JSON.stringify(args)}`;
    let score = 0;
    const flags = [];

    for (const { pattern, flag, weight } of HIGH_RISK_PATTERNS) {
        if (pattern.test(text)) {
            score += weight;
            flags.push(flag);
        }
    }

    score = Math.min(100, score);
    circuitBreaker.totalFallbacks++;

    return {
        score,
        flags,
        reasoning: score > 0 ? `Heuristic fallback: ${flags.join(', ')}` : 'Heuristic fallback: no suspicious patterns',
        skipped: true,
        source: 'heuristic'
    };
}

// ─── System Prompt ───
const SYSTEM_PROMPT = `You are a security intent analyzer for an AI agent gateway.
You receive a tool call (tool name, action, arguments, agent role) and must assess whether the arguments look deceptive or suspicious.

Respond ONLY with valid JSON:
{"score": <0-100>, "flags": ["flag1"], "reasoning": "one sentence"}

Score guide:
0-20: Normal, benign arguments
21-50: Slightly unusual but likely legitimate
51-80: Suspicious patterns, possible deception
81-100: Highly likely malicious or deceptive

Examples of deception:
- Payment description says "office supplies" but amount is $500k to an offshore account
- User lookup args contain encoded shell commands
- Email "to" field targets an external domain while marked as "internal report"
- Database query args smuggle commands inside innocent-looking field names

Be concise. JSON only.`;

/**
 * Analyze a tool call's intent.
 * 
 * Pipeline: Cache → Circuit Breaker → LLM → Heuristic Fallback
 */
async function analyzeIntent({ tool, action, args, agentRole }) {
    const config = getLlmConfig();

    // 1. Check cache first (0ms if hit)
    const cacheKey = getCacheKey(tool, action, args);
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`[INTENT-ANALYZER] Cache HIT (${cacheKey.substring(0, 8)}…)`);
        return { ...cached, source: 'cache' };
    }

    // 2. Check if LLM is configured
    if (!config.key && config.key !== 'ollama') {
        return heuristicFallback(tool, action, args);
    }

    // 3. Check circuit breaker
    if (isCircuitOpen()) {
        console.warn('[INTENT-ANALYZER] Circuit OPEN — using heuristic fallback');
        const fallback = heuristicFallback(tool, action, args);
        setCache(cacheKey, fallback);
        return fallback;
    }

    // 4. Call LLM with strict timeout
    const effectiveTimeout = Math.min(config.timeout, 5000); // cap at 5s
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (config.key && config.key !== 'ollama') {
            headers['Authorization'] = `Bearer ${config.key}`;
        }

        const userPrompt = `Tool: ${tool}
Action: ${action}
Agent Role: ${agentRole || 'unknown'}
Arguments: ${JSON.stringify(args, null, 2)}

Assess suspicion level.`;

        const payload = { model: config.model, max_output_tokens: 150 };

        if (config.endpoint.includes('openai.com') || config.endpoint.includes('responses')) {
            payload.input = [
                { role: 'developer', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ];
            payload.reasoning = { effort: 'minimal' };
            payload.text = { verbosity: 'low' };
        } else {
            payload.messages = [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ];
        }

        const res = await fetch(config.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            const errBody = await res.text();
            console.warn(`[INTENT-ANALYZER] LLM HTTP ${res.status}: ${errBody.substring(0, 100)}`);
            recordFailure('http_error');
            const fallback = heuristicFallback(tool, action, args);
            setCache(cacheKey, fallback);
            return fallback;
        }

        const data = await res.json();

        // Extract text from various API response formats
        let text = '';
        if (data.output_text) {
            text = data.output_text;
        } else if (data.output && Array.isArray(data.output)) {
            for (const item of data.output) {
                if (item.content && Array.isArray(item.content)) {
                    for (const c of item.content) {
                        if (c.text) text += c.text;
                    }
                }
            }
        } else if (data.choices && data.choices[0]?.message?.content) {
            text = data.choices[0].message.content;
        }

        if (!text) text = JSON.stringify(data);

        // 5. Enforce structured output — must be valid JSON with our schema
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('[INTENT-ANALYZER] LLM returned non-JSON. Falling back to heuristic.');
            recordFailure('parse_error');
            const fallback = heuristicFallback(tool, action, args);
            setCache(cacheKey, fallback);
            return fallback;
        }

        const parsed = JSON.parse(jsonMatch[0]);

        // Validate schema strictly
        const score = Math.min(100, Math.max(0, parseInt(parsed.score) || 0));
        const flags = Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string') : [];
        const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

        if (typeof parsed.score === 'undefined') {
            console.warn('[INTENT-ANALYZER] LLM response missing "score". Using heuristic.');
            recordFailure('schema_violation');
            const fallback = heuristicFallback(tool, action, args);
            setCache(cacheKey, fallback);
            return fallback;
        }

        recordSuccess();

        const result = { score, flags, reasoning, skipped: false, source: 'llm' };
        setCache(cacheKey, result);

        console.log(`[INTENT-ANALYZER] LLM score=${score} flags=[${flags.join(',')}] (${cacheKey.substring(0, 8)}…)`);
        return result;

    } catch (err) {
        clearTimeout(timer);

        if (err.name === 'AbortError') {
            console.warn(`[INTENT-ANALYZER] ⏱️ LLM timeout (>${effectiveTimeout}ms) — using heuristic`);
            recordFailure('timeout');
        } else {
            console.warn(`[INTENT-ANALYZER] LLM error: ${err.message} — using heuristic`);
            recordFailure('network_error');
        }

        const fallback = heuristicFallback(tool, action, args);
        setCache(cacheKey, fallback);
        return fallback;
    }
}

/**
 * Get observability metrics for the intent analyzer.
 */
function getAnalyzerMetrics() {
    return {
        circuitOpen: circuitBreaker.open,
        consecutiveFailures: circuitBreaker.failures,
        totalSuccess: circuitBreaker.totalSuccess,
        totalTimeouts: circuitBreaker.totalTimeouts,
        totalErrors: circuitBreaker.totalErrors,
        totalFallbacks: circuitBreaker.totalFallbacks,
        totalCacheHits: circuitBreaker.totalCacheHits,
        cacheSize: cache.size,
    };
}

module.exports = { analyzeIntent, getLlmConfig, getAnalyzerMetrics, heuristicFallback };
