/**
 * DWI — Agent Gateway (Core Orchestrator)
 * The execution firewall. This is the central module that:
 *   1. Receives MCP tool calls
 *   2. Validates tool signature (registry)
 *   3. Evaluates policy (policy engine)
 *   4. Scores risk (risk engine)
 *   5. Executes inside TEE (if approved)
 *   6. Logs everything (audit logger)
 *   7. Generates threat alerts (if needed)
 *   8. Returns result or denial
 */
const crypto = require('crypto');
const { getDb, uuidv4 } = require('./database');
const { scoreRequest } = require('./risk-engine');
const { analyzeIntent } = require('./intent-analyzer');
const { recordAndAnalyze } = require('./behavioral-engine');
const { trackUsage } = require('./usage-tracker');
const grpcClient = require('./grpc-client');
const { logAction } = require('./audit-logger');
const { notify: escalationNotify } = require('./escalation');

// Import Trust Components
const { loadAndVerifyBundle } = require('./bundle-loader');
const { evaluateAuthorization } = require('./policy-evaluator');

// Load sovereign policy at startup
// Gateway will CRASH here if signature is invalid or bundle is missing (Fail Strict)
const loadedPolicy = loadAndVerifyBundle();

// NOTE: tee-enclave.js and enterprise-db.js are NOT imported here.
// They live in the enclave worker process. This is the security boundary.

// WebSocket broadcast function — injected by server.js
let broadcastFn = null;
function setBroadcast(fn) { broadcastFn = fn; }

const { evaluateTenantPolicies } = require('./tenant-policy');

/**
 * Process an MCP tool call through the full gateway pipeline and EXECUTE it if allowed.
 * This is the original entry point — every agent request flows through here.
 *
 * @param {Object} request - MCP tool call request
 * @param {string} request.agentApiKey - Agent's API key
 * @param {string} request.tool - MCP tool name
 * @param {string} request.action - Action type (READ, WRITE, DELETE, CREATE, EXECUTE)
 * @param {Object} request.args - Tool arguments
 * @param {Object} request.resource - Resource context { classification, env, residency }
 * @returns {Object} Gateway response
 */
async function processRequest(request) {
    const traceId = request.traceId || crypto.randomUUID();

    // ─── Step 1: Authenticate the agent ───
    const agent = authenticateAgent(request.agentApiKey, request.agentName);
    if (!agent) {
        return gatewayDeny('AUTHENTICATION_FAILED', 'Invalid or revoked API key', null, request, traceId);
    }

    // Steps 1b–6 are shared with the decide-only path (see runPipeline).
    const verdict = await runPipeline(request, agent, { mode: 'execute', traceId });
    if (verdict.outcome !== 'allow') return legacyResponse(verdict);

    // ─── Step 7: APPROVED — Execute via gRPC to enclave worker (SEPARATE CONTAINER) ───
    const { riskResult, policyResult, proposedIntent, spanId, parentSpanId, totalStart } = verdict;
    let enclaveResult;
    try {
        const ticketArgs = {
            agentId: agent.id,
            agentRole: agent.role,
            tool: request.tool,
            action: proposedIntent.action,
            args: request.args || {},
            policy_bundle_hash: loadedPolicy.hash,
            risk_score: riskResult.score,
            traceId,
            spanId,
            parentSpanId
        };
        enclaveResult = await grpcClient.execute(ticketArgs);
    } catch (err) {
        const totalMs = Number(process.hrtime.bigint() - totalStart) / 1e6;
        incrementAgentCounters(agent.id, 'approved');
        logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: agent.project_id,
            tool: request.tool, action: request.action || 'EXECUTE',
            policyDecision: 'allow',
            riskScore: riskResult.score, latencyMs: totalMs,
            requestPayload: { ...request.args, _trace: { spanId, parentSpanId } },
            responseSummary: { executionError: err.message },
        });

        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'allow', risk: riskResult.score, projectId: agent.project_id, traceId });

        return {
            status: 'APPROVED',
            code: 'EXECUTION_DEGRADED',
            reason: 'Policy allowed — execution plane unavailable',
            executionError: err.message,
            traceId,
            riskScore: riskResult.score,
            gatewayLatencyMs: totalMs.toFixed(2),
        };
    }

    const totalMs = Number(process.hrtime.bigint() - totalStart) / 1e6;
    incrementAgentCounters(agent.id, 'approved');

    // Log the successful execution
    const auditEntry = logAction({
        traceId, agentId: agent.id, agentName: agent.name, projectId: agent.project_id,
        tool: request.tool, action: request.action || 'EXECUTE',
        resourceClassification: request.resource?.classification,
        policyDecision: 'allow',
        matchedPolicyId: policyResult.matchedPolicy?.id,
        matchedPolicyName: policyResult.matchedPolicy?.name || 'DEFAULT_ALLOW',
        riskScore: riskResult.score, latencyMs: totalMs,
        enclaveAttestation: enclaveResult.enclave?.attestation,
        requestPayload: { ...request.args, _trace: { spanId, parentSpanId } },
        responseSummary: enclaveResult.result,
    });

    broadcast('request', { agent: agent.name, tool: request.tool, decision: 'allow', risk: riskResult.score, projectId: agent.project_id, traceId });

    return {
        status: 'APPROVED',
        code: 'EXECUTED',
        result: enclaveResult.result,
        enclave: {
            sessionId: enclaveResult.enclave?.sessionId,
            type: enclaveResult.enclave?.type,
            attestation: enclaveResult.enclave?.attestation,
            attestationValid: enclaveResult.enclave?.attestationValid,
            dataExposedToHost: false,
            dataExposedToLLMProvider: false,
        },
        audit: {
            id: auditEntry.id,
            seq: auditEntry.seq,
            requestHash: auditEntry.requestHash,
            resultHash: auditEntry.resultHash,
            chainHash: auditEntry.entryHash,
        },
        riskScore: riskResult.score,
        matchedPolicy: policyResult.matchedPolicy,
        policyEvaluationMs: policyResult.evaluationMs,
        gatewayLatencyMs: totalMs.toFixed(2),
    };
}

/**
 * Decide-only entry point for platforms that execute their own tools (POST /api/v1/decide).
 * Runs the same pipeline as processRequest but never executes anything.
 *
 * @param {Object} agent   authenticated agent row
 * @param {Object} request { tool, action: READ|WRITE|PAYMENT, args, resource, context, actor }
 * @returns {Promise<Object>} { decision, code, reason, traceId, riskScore, riskFactors, matchedPolicy, auditId, auditHash, latencyMs, ... }
 */
async function decide(agent, request) {
    const verdict = await runPipeline(request, agent, { mode: 'decide', traceId: crypto.randomUUID() });
    return {
        decision: verdict.outcome,
        code: verdict.code,
        reason: verdict.reason,
        traceId: verdict.traceId,
        riskScore: verdict.riskResult ? verdict.riskResult.score : 0,
        riskFactors: verdict.riskResult ? verdict.riskResult.factors : [],
        matchedPolicy: verdict.matchedPolicy || null,
        auditId: verdict.audit ? verdict.audit.id : null,
        auditHash: verdict.audit ? verdict.audit.entryHash : null,
        auditSeq: verdict.audit ? verdict.audit.seq : null,
        policyBundleHash: loadedPolicy.hash,
        intent: verdict.intentResult ? summarizeIntent(verdict.intentResult) : null,
        latencyMs: Number(verdict.totalMs.toFixed(2)),
    };
}

function summarizeIntent(i) {
    return {
        score: i.score || 0,
        flags: i.flags || [],
        reasoning: i.reasoning || null,
        source: i.source || null,
        skipped: !!i.skipped,
    };
}

/**
 * The shared pipeline: plan limit → financial guard → signed policy (+ tenant policies in decide mode)
 * → intent analysis → risk scoring → behavioural analysis → verdict.
 *
 * It never executes a tool. Every non-allow outcome, and every allow outcome in decide mode, is
 * written to the hash-chained audit log here. In execute mode the caller logs the allow after
 * it has executed (so the audit entry can carry the enclave attestation).
 */
async function runPipeline(request, agent, { mode, traceId }) {
    const totalStart = process.hrtime.bigint();
    const db = getDb();
    const pid = agent.project_id || 'default_project';
    const spanId = 'gateway-01';
    const parentSpanId = request.parentSpanId || null;
    const action = request.action || 'EXECUTE';
    const ctx = request.context || {};
    const elapsed = () => Number(process.hrtime.bigint() - totalStart) / 1e6;
    const base = { traceId, agent, mode, totalStart, spanId, parentSpanId };

    // Update last seen
    db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?").run(agent.id);

    // The audit payload. Decide mode adds who asked and on whose behalf.
    const payload = () => {
        const p = { ...request.args, _trace: { spanId, parentSpanId } };
        if (mode === 'decide') p._context = { ...ctx, actor: request.actor || null, resource: request.resource || null };
        return p;
    };
    const explain = (v) => mode !== 'decide' ? null : {
        decision: v.outcome, code: v.code, reason: v.reason,
        matchedPolicy: v.matchedPolicy || null,
        policyBundleHash: loadedPolicy.hash,
        riskScore: v.riskResult ? v.riskResult.score : 0,
        riskFactors: v.riskResult ? v.riskResult.factors : [],
        intent: v.intentResult ? summarizeIntent(v.intentResult) : null,
        behavioral: v.behavioral ? { rollingAverage: v.behavioral.rollingAverage, isAnomaly: !!v.behavioral.isAnomaly, isProbing: !!v.behavioral.isProbing } : null,
    };

    // ─── Step 1b: Plan Limit Enforcement ───
    try {
        const { enforcePlanLimit } = require('./billing');
        const limitResult = enforcePlanLimit(pid);
        if (limitResult?.blocked) {
            trackUsage(pid, 'blocked_requests');
            const v = { ...base, outcome: 'deny', kind: 'plan_limit', code: 'PLAN_LIMIT_EXCEEDED', reason: limitResult.reason };
            v.totalMs = elapsed();
            incrementAgentCounters(agent.id, 'blocked');
            v.audit = logAction({
                traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
                tool: request.tool, action,
                resourceClassification: request.resource?.classification,
                policyDecision: 'deny', riskScore: 0, latencyMs: 0,
                requestPayload: mode === 'decide' ? payload() : request.args,
                responseSummary: { blocked: true, reason: v.reason, ...(mode === 'decide' ? { explanation: explain(v) } : {}) }
            });
            broadcast('request', { agent: agent.name, tool: request.tool, decision: 'deny', risk: 0, reason: v.code, projectId: pid, traceId });
            return v;
        }
    } catch (_) { /* plans module optional */ }

    // ─── Step 1c: Financial Threshold Guard ───
    const { checkThreshold } = require('./financial-guard');
    const amount = ctx.amount !== undefined && ctx.amount !== null ? Number(ctx.amount) : null;
    const guardArgs = mode === 'decide' && amount !== null && !Number.isNaN(amount) ? { ...request.args, amount } : (request.args || {});
    const financialCheck = checkThreshold({ projectId: pid, tool: request.tool, args: guardArgs });
    if (financialCheck.blocked) {
        trackUsage(pid, 'blocked_requests');
        createThreatAlert('high', 'FINANCIAL_THRESHOLD_EXCEEDED',
            `Financial Block: ${agent.name} → ${request.tool}`,
            financialCheck.reason,
            agent
        );
        escalationNotify({
            eventType: 'deny',
            projectId: pid,
            agentName: agent.name,
            tool: request.tool,
            action,
            riskScore: 100,
            reason: financialCheck.reason,
            traceId,
        }).catch(() => {});
        const v = { ...base, outcome: 'deny', kind: 'financial', code: financialCheck.code || 'FINANCIAL_THRESHOLD_EXCEEDED', reason: financialCheck.reason };
        v.totalMs = elapsed();
        incrementAgentCounters(agent.id, 'blocked');
        v.audit = logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
            tool: request.tool, action,
            resourceClassification: request.resource?.classification,
            policyDecision: 'deny', riskScore: 0, latencyMs: 0,
            requestPayload: mode === 'decide' ? payload() : request.args,
            responseSummary: { blocked: true, reason: v.reason, ...(mode === 'decide' ? { explanation: explain(v) } : {}) }
        });
        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'deny', risk: 0, reason: v.code, projectId: pid, traceId });
        return v;
    }

    // ─── Step 2: Evaluate Policy ───
    // Execute mode: signed bundle (tool registry + role matrix + rules).
    // Decide mode: the signed bundle's global rules, then this tenant's policies.
    const proposedIntent = { tool: request.tool, action, args: request.args || {} };
    if (process.env.SAG_INTENT_LOG) {
        try { require('fs').appendFileSync(process.env.SAG_INTENT_LOG, JSON.stringify(proposedIntent) + '\n'); } catch (e) { }
    }
    let policyResult;
    if (mode === 'decide') {
        policyResult = evaluateDecidePolicy(loadedPolicy.bundle, agent, proposedIntent, request, pid);
    } else {
        policyResult = evaluateAuthorization(loadedPolicy.bundle, agent.role, proposedIntent);
    }

    // ─── Step 3: LLM Intent Analysis (Semantic Gap) ───
    const intentResult = await analyzeIntent({
        tool: request.tool,
        action,
        args: request.args || {},
        agentRole: agent.role
    });

    // ─── Step 4: Score risk (Gateway computes heuristics) ───
    const riskResult = scoreRequest({
        agent,
        tool: request.tool,
        action,
        resource: request.resource || {},
        args: request.args || {},
        amount: mode === 'decide' ? amount : null,
        semanticSuspicion: intentResult
    });

    // ─── Step 5: Behavioral Analysis (cross-request patterns) ───
    const behavioral = recordAndAnalyze({
        agentId: agent.id,
        agentName: agent.name,
        tool: request.tool,
        riskScore: riskResult.score,
        semanticScore: intentResult.score || 0,
        projectId: pid,
        // A platform agent (an ERP assistant, say) legitimately uses many different tools in one turn.
        probeThreshold: agent.department === 'platform' ? 15 : undefined,
    });

    // ─── Step 6: Usage Tracking (monetization) ───
    trackUsage(pid, 'api_requests');
    if (!intentResult.skipped && intentResult.source !== 'cache') trackUsage(pid, 'llm_calls');
    if (intentResult.source === 'cache') trackUsage(pid, 'cache_hits');

    const common = { ...base, riskResult, intentResult, policyResult, behavioral, proposedIntent, matchedPolicy: policyResult.matchedPolicy || null };
    const policyEscalates = policyResult.allowed && policyResult.decision === 'escalate';

    // Risk override: log if auto-block
    if (riskResult.autoBlock && policyResult.allowed) {
        createThreatAlert('critical', 'risk_auto_block',
            `Risk Auto-Block: ${agent.name} → ${request.tool}`,
            `Risk score ${riskResult.score}/100 exceeded auto-block threshold. Factors: ${riskResult.factors.map(f => f.factor).join(', ')}`,
            agent);

        const v = {
            ...common, outcome: 'deny', kind: 'risk_block', code: 'RISK_AUTO_BLOCK',
            reason: `Risk score ${riskResult.score}/100 exceeded auto-block threshold (${riskResult.threshold.autoBlock})`,
        };
        v.totalMs = elapsed();
        incrementAgentCounters(agent.id, 'blocked');

        escalationNotify({
            eventType: 'deny',
            projectId: pid,
            agentName: agent.name,
            tool: request.tool,
            action,
            riskScore: riskResult.score,
            reason: `Risk score ${riskResult.score}/100 exceeded auto-block threshold`,
            traceId,
        }).catch(() => {});

        v.audit = logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
            tool: request.tool, action,
            resourceClassification: request.resource?.classification,
            policyDecision: 'deny', matchedPolicyId: null, matchedPolicyName: 'RISK_AUTO_BLOCK',
            riskScore: riskResult.score, latencyMs: v.totalMs,
            requestPayload: payload(),
            responseSummary: { blocked: true, reason: 'risk_auto_block', ...(mode === 'decide' ? { explanation: explain(v) } : {}) }
        });

        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'deny', risk: riskResult.score, reason: 'risk_auto_block', projectId: pid, traceId });
        return v;
    }

    // ─── Policy deny ───
    if (!policyResult.allowed) {
        const v = {
            ...common, outcome: 'deny', kind: 'policy_deny',
            code: mode === 'decide' ? (policyResult.code || 'POLICY_DENY') : 'POLICY_DENY',
            reason: policyResult.reason,
        };
        v.totalMs = elapsed();
        incrementAgentCounters(agent.id, 'blocked');

        v.audit = logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
            tool: request.tool, action,
            resourceClassification: request.resource?.classification,
            policyDecision: 'deny',
            matchedPolicyId: mode === 'decide' ? (policyResult.matchedPolicy?.id || null) : null,
            matchedPolicyName: mode === 'decide' ? (policyResult.matchedPolicy?.name || 'BUNDLE_POLICY_DENY') : 'BUNDLE_POLICY_DENY',
            riskScore: riskResult.score, latencyMs: v.totalMs,
            requestPayload: payload(),
            responseSummary: { blocked: true, reason: policyResult.reason, ...(mode === 'decide' ? { explanation: explain(v) } : {}) }
        });

        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'deny', risk: riskResult.score, policy: policyResult.reason, projectId: pid, traceId });
        return v;
    }

    // ─── Escalation: tenant policy or risk score requires a person ───
    if (policyEscalates || riskResult.needsHumanApproval) {
        const reason = policyEscalates ? policyResult.reason : `Risk score ${riskResult.score}/100 requires human approval`;
        const v = {
            ...common, outcome: 'escalate', kind: 'escalate',
            code: policyEscalates && mode === 'decide' ? 'POLICY_ESCALATE' : (mode === 'decide' ? 'RISK_ESCALATION' : 'REQUIRES_HUMAN_APPROVAL'),
            reason, secondaryAction: policyResult.secondaryAction,
        };
        v.totalMs = elapsed();
        incrementAgentCounters(agent.id, 'escalated');

        v.audit = logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
            tool: request.tool, action,
            resourceClassification: request.resource?.classification,
            policyDecision: 'escalate',
            matchedPolicyId: policyResult.matchedPolicy?.id,
            matchedPolicyName: policyResult.matchedPolicy?.name || 'RISK_ESCALATION',
            riskScore: riskResult.score, latencyMs: v.totalMs,
            requestPayload: payload(),
            responseSummary: { escalated: true, ...(mode === 'decide' ? { reason, explanation: explain(v) } : {}) }
        });

        escalationNotify({
            eventType: 'escalate',
            projectId: pid,
            agentName: agent.name,
            tool: request.tool,
            action,
            riskScore: riskResult.score,
            reason,
            traceId,
        }).catch(() => {});

        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'escalate', risk: riskResult.score, projectId: pid, traceId });
        return v;
    }

    // ─── Allow ───
    const v = {
        ...common, outcome: 'allow', kind: 'allow', code: 'ALLOWED',
        reason: policyResult.matchedPolicy ? `Allowed by policy '${policyResult.matchedPolicy.name}'` : 'Policy allows and risk is below the escalation threshold',
    };
    v.totalMs = elapsed();
    if (mode === 'decide') {
        incrementAgentCounters(agent.id, 'approved');
        v.audit = logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: pid,
            tool: request.tool, action,
            resourceClassification: request.resource?.classification,
            policyDecision: 'allow',
            matchedPolicyId: policyResult.matchedPolicy?.id,
            matchedPolicyName: policyResult.matchedPolicy?.name || 'DEFAULT_ALLOW',
            riskScore: riskResult.score, latencyMs: v.totalMs,
            requestPayload: payload(),
            responseSummary: { allowed: true, explanation: explain(v) }
        });
        broadcast('request', { agent: agent.name, tool: request.tool, decision: 'allow', risk: riskResult.score, projectId: pid, traceId });
    }
    return v;
}

/** Decide-mode policy: signed bundle's global rules first, then the tenant's policies. */
function evaluateDecidePolicy(bundle, agent, intent, request, projectId) {
    // Global guardrails from the signed bundle (e.g. DROP_TABLE) apply to every tenant.
    for (const policy of bundle.policies || []) {
        if (policy.effect === 'deny' && bundleRuleMatches(policy.conditions, intent)) {
            return { allowed: false, code: 'BUNDLE_POLICY_DENY', reason: `Blocked by signed policy '${policy.name}'`, matchedPolicy: { id: policy.id, name: policy.name } };
        }
    }
    const r = evaluateTenantPolicies({ projectId, agent, tool: request.tool, action: intent.action, resource: request.resource || {}, args: request.args || {}, context: request.context || {} });
    if (r.decision === 'deny') {
        return { allowed: false, code: 'POLICY_DENY', reason: r.reason, matchedPolicy: r.matchedPolicy, evaluationMs: r.evaluationMs };
    }
    return { allowed: true, decision: r.decision, reason: r.reason, matchedPolicy: r.matchedPolicy, secondaryAction: r.secondaryAction, evaluationMs: r.evaluationMs };
}

function bundleRuleMatches(conditions, intent) {
    if (!conditions || !conditions.action) return false;
    const target = intent.action || '';
    return typeof target === 'string' && target.toUpperCase().includes(String(conditions.action).toUpperCase());
}

/** Maps a pipeline verdict onto the original /api/gateway/execute response shapes. */
function legacyResponse(v) {
    const status = v.outcome === 'escalate' ? 'ESCALATED' : 'DENIED';
    if (v.kind === 'plan_limit' || v.kind === 'financial') {
        return { status, code: v.code, reason: v.reason, traceId: v.traceId };
    }
    if (v.kind === 'risk_block') {
        return {
            status, code: v.code, reason: v.reason, traceId: v.traceId,
            riskScore: v.riskResult.score, riskFactors: v.riskResult.factors,
            gatewayLatencyMs: v.totalMs.toFixed(2),
        };
    }
    if (v.kind === 'policy_deny') {
        return {
            status, code: v.code, reason: v.reason, traceId: v.traceId,
            riskScore: v.riskResult.score, gatewayLatencyMs: v.totalMs.toFixed(2),
        };
    }
    return {
        status, code: v.code, reason: v.reason, traceId: v.traceId,
        matchedPolicy: v.policyResult.matchedPolicy,
        riskScore: v.riskResult.score, riskFactors: v.riskResult.factors,
        secondaryAction: v.policyResult.secondaryAction,
        gatewayLatencyMs: v.totalMs.toFixed(2),
    };
}

// ─── Helper functions ───

function authenticateAgent(apiKey, agentName) {
    if (!apiKey) return null;
    const db = getDb();
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');

    // 1. Legacy / Standalone Node: Key belongs directly to an agent
    let agent = db.prepare("SELECT * FROM agents WHERE api_key_hash = ? AND status = 'active'").get(hash);
    if (agent) return agent;

    // 2. SaaS Cloud Mode: Key belongs to a Project (Workspace)
    const project = db.prepare("SELECT * FROM projects WHERE api_key_hash = ?").get(hash);
    if (project) {
        if (!agentName) return null; // SaaS routing requires knowing the agent name
        
        // Find agent in this specific workspace
        agent = db.prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND status = 'active'").get(project.id, agentName);
        if (agent) return agent;

        // Auto-Register the agent into this workspace immediately (Zero-Friction Boarding)
        const agentId = 'ag_' + uuidv4().replace(/-/g, '').substring(0, 16);
        const dummyKeyHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
        
        db.prepare(`
            INSERT INTO agents (id, project_id, name, role, department, api_key_hash) 
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(agentId, project.id, agentName, 'dynamic-agent', 'api', dummyKeyHash);

        console.log(`[GATEWAY] Auto-registered new agent '${agentName}' under project '${project.id}'`);
        return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    }

    return null;
}

function gatewayDeny(code, reason, agent, request, traceId = undefined) {
    if (agent) {
        incrementAgentCounters(agent.id, 'blocked');
        logAction({
            traceId, agentId: agent.id, agentName: agent.name, projectId: agent.project_id,
            tool: request.tool, action: request.action || 'EXECUTE',
            policyDecision: 'deny', riskScore: 0, latencyMs: 0,
            requestPayload: request.args,
            responseSummary: { blocked: true, reason }
        });
    }
    return { status: 'DENIED', code, reason, traceId };
}

function incrementAgentCounters(agentId, type) {
    const db = getDb();
    db.prepare('UPDATE agents SET total_requests = total_requests + 1 WHERE id = ?').run(agentId);
    if (type === 'blocked') {
        db.prepare('UPDATE agents SET blocked_requests = blocked_requests + 1 WHERE id = ?').run(agentId);
    }
}

function createThreatAlert(severity, type, title, description, agent) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
    INSERT INTO threat_alerts (id, project_id, severity, type, title, description, agent_id, agent_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, agent?.project_id || 'default_project', severity, type, title, description, agent?.id || null, agent?.name || null);

    broadcast('alert', { id, severity, type, title, agentName: agent?.name, projectId: agent?.project_id });
    return id;
}

function broadcast(type, data) {
    if (broadcastFn) broadcastFn({ type, data, timestamp: new Date().toISOString() });
}

// ─── Agent management ───

function registerAgent({ name, role, department, trustScore, staticKey, projectId }) {
    const db = getDb();
    const id = uuidv4();
    const apiKey = staticKey || `dwi_${crypto.randomBytes(24).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    db.prepare(`
    INSERT INTO agents (id, project_id, name, role, department, trust_score, api_key_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId || 'default_project', name, role, department, trustScore || 50, apiKeyHash);

    return { id, name, apiKey, role, department, trustScore: trustScore || 50 };
}

function listAgents(projectId) {
    const db = getDb();
    if (projectId) {
        return db.prepare('SELECT id, name, role, department, trust_score, status, created_at, last_seen, total_requests, blocked_requests FROM agents WHERE project_id = ? ORDER BY name').all(projectId);
    }
    return db.prepare('SELECT id, name, role, department, trust_score, status, created_at, last_seen, total_requests, blocked_requests FROM agents ORDER BY name').all();
}

function getAgent(id) {
    const db = getDb();
    return db.prepare('SELECT id, name, role, department, trust_score, status, created_at, last_seen, total_requests, blocked_requests FROM agents WHERE id = ?').get(id);
}

function updateAgentTrust(id, newScore) {
    const db = getDb();
    db.prepare('UPDATE agents SET trust_score = ? WHERE id = ?').run(Math.max(0, Math.min(100, newScore)), id);
}

function suspendAgent(id) {
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?").run(id);
}

function killAgent(id) {
    const db = getDb();
    const info = db.prepare("UPDATE agents SET status = 'revoked', trust_score = 0 WHERE id = ? AND status != 'revoked'").run(id);
    if (info.changes === 0) return { alreadyRevoked: true };
    const agent = db.prepare('SELECT name, project_id FROM agents WHERE id = ?').get(id);
    if (agent) {
        db.prepare(`INSERT INTO threat_alerts (id, project_id, severity, type, title, description, agent_id, agent_name)
                    VALUES (?, ?, 'critical', 'KILL_SWITCH', 'Agent Kill-Switch Activated',
                    'Agent was permanently revoked via kill-switch.', ?, ?)`)
          .run(require('crypto').randomUUID(), agent.project_id, id, agent.name);
        escalationNotify({
            eventType: 'kill',
            projectId: agent.project_id || 'default_project',
            agentName: agent.name,
            tool: 'kill-switch',
            action: 'REVOKE',
            riskScore: 100,
            reason: 'Agent permanently revoked via kill-switch',
            traceId: null,
        }).catch(() => {});
    }
    return { revoked: true };
}

function reactivateAgent(id) {
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'active', trust_score = 50 WHERE id = ?").run(id);
}

function getThreatAlerts(limit = 20, projectId = null) {
    const db = getDb();
    if (projectId) {
        return db.prepare('SELECT * FROM threat_alerts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit);
    }
    return db.prepare('SELECT * FROM threat_alerts ORDER BY created_at DESC LIMIT ?').all(limit);
}

function seedAgents() {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM agents').get().c;
    if (count > 0) return;

    const agents = [
        { name: 'Codex-Alpha', role: 'engineering', department: 'Engineering', trust: 96 },
        { name: 'FinanceAgent-7', role: 'finance', department: 'Finance', trust: 74 },
        { name: 'DataMiner-3', role: 'analytics', department: 'Analytics', trust: 38 },
        { name: 'SupplyBot-EU', role: 'operations', department: 'Operations', trust: 91 },
        { name: 'HRAssist-Pro', role: 'hr', department: 'HR', trust: 88 },
        { name: 'ComplianceBot', role: 'compliance', department: 'Legal', trust: 99 },
        { name: 'SalesOracle', role: 'sales', department: 'Sales', trust: 82 },
        { name: 'SecOps-Guard', role: 'security', department: 'Security', trust: 97 },
    ];

    const keys = [];
    let countIdx = 1;
    for (const a of agents) {
        const staticKey = `dwi_test_key_${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const result = registerAgent({ name: a.name, role: a.role, department: a.department, trustScore: a.trust, staticKey });
        keys.push({ name: a.name, apiKey: result.apiKey });
    }

    console.log('[GATEWAY] Seeded', agents.length, 'agents');
    console.log('[GATEWAY] Agent API Keys (for testing):');
    keys.forEach(k => console.log(`  ${k.name}: ${k.apiKey}`));

    return keys;
}

module.exports = {
    processRequest, decide, setBroadcast, authenticateAgent,
    registerAgent, listAgents, getAgent, updateAgentTrust, suspendAgent, killAgent, reactivateAgent,
    getThreatAlerts, seedAgents,
};
