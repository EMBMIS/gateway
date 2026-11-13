/**
 * DWI — EMBMIS Gateway Server
 * 
 * TWO-PROCESS ARCHITECTURE:
 *   Process A (this file): HTTP API + control plane + policy engine
 *   Process B (enclave-worker.js): Execution plane + enterprise DB
 * 
 * Communication: IPC message channel with HMAC-signed execution tickets.
 * Security boundary: OS-level process isolation.
 */
// ─── Key guard: runs before anything else loads key material ───
// Production refuses missing keys and any key that was ever committed to the repository.
try {
    require('./src/keys').assertKeysSafe('gateway');
} catch (e) {
    console.error('\n╔══════════════════════════════════════════════════╗');
    console.error('║  KEY GUARD FAILED — REFUSING TO START            ║');
    console.error('╚══════════════════════════════════════════════════╝');
    (e.errors || [e.message]).forEach(m => console.error(`  ✗ ${m}`));
    console.error('\n  See SECURITY-ROTATION.md. For local development run: npm run keys:dev\n');
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const http = require('http');
const { fork } = require('child_process');
const crypto = require('crypto');
const path = require('path');

// ─── Control Plane Modules (THIS process only) ───
const { getDb } = require('./src/database');
const { seedTools, listTools, registerTool, getTool } = require('./src/tool-registry');
const { seedPolicies, listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy, evaluateRequest } = require('./src/policy-engine');
const { processRequest, setBroadcast, registerAgent, listAgents, getAgent, updateAgentTrust, suspendAgent, killAgent, reactivateAgent, getThreatAlerts, seedAgents } = require('./src/gateway');
const { scoreRequest } = require('./src/risk-engine');
const { queryLog, verifyChain, getStats, exportAuditLog } = require('./src/audit-logger');
const { listAssets, getAccessLog, processErasure, listErasureRequests, seedVault, storeAsset } = require('./src/vault');
const grpcClient = require('./src/grpc-client');
const access = require('./src/access');
const decisions = require('./src/decisions');
const v1 = require('./src/v1-api');
const { registerUser, loginUser, destroySession, requireAuth, getSessionCookieOptions, isRateLimited, validateSession } = require('./src/auth');

// NOTE: tee-enclave.js and enterprise-db.js are NOT imported here.
// They live exclusively in the enclave worker process.
// This is the OS-level security boundary.

const app = express();

// Served under a path of a shared host (https://embmis.com/gateway): the proxy forwards /gateway/... untouched and the
// gateway drops the prefix itself, so it behaves exactly as at the root, and works the same without a proxy in tests.
const BASE_PATH = (process.env.SAG_BASE_PATH || '').replace(/\/+$/, '');
if (BASE_PATH) {
    app.use((req, res, next) => {
        if (req.url === BASE_PATH) return res.redirect(301, `${BASE_PATH}/`);
        if (req.url.startsWith(`${BASE_PATH}/`) || req.url.startsWith(`${BASE_PATH}?`)) req.url = req.url.slice(BASE_PATH.length) || '/';
        next();
    });
}
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(cors({ origin: true, credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());
app.use(access.guard);

// ─── WebSocket Setup ───
const wss = new WebSocketServer({ server, path: `${BASE_PATH}/ws` });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
    // With access control on, a console session is required and the stream is limited to the user's workspace.
    if (access.enabled()) {
        const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('sag_session='));
        const user = cookie ? validateSession(decodeURIComponent(cookie.slice('sag_session='.length))) : null;
        if (!user) return ws.close(4401, 'Authentication required');
        ws.projectId = user.projectId;
        ws.isOperator = access.operators().includes(String(user.email).toLowerCase());
    }
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
});

// Live decisions: gateway.js calls this for every request, alert and so on.
setBroadcast((message) => {
    const text = JSON.stringify(message);
    const pid = message && message.data && message.data.projectId;
    for (const ws of wsClients) {
        if (ws.readyState !== 1) continue;
        if (ws.projectId && !ws.isOperator && pid !== ws.projectId) continue;
        ws.send(text);
    }
});

// ─── Initialize gRPC Client Pool ───
// Single address: set ENCLAVE_ADDRESS (legacy)
// Multi-worker pool: set ENCLAVE_POOL_SIZE (e.g. 4) — workers are auto-spawned on ENCLAVE_BASE_PORT..+N
const workerPool = require('./src/worker-pool');

let enclaveAddresses;
if (process.env.ENCLAVE_ADDRESSES) {
    // Explicit comma-separated list: ENCLAVE_ADDRESSES=localhost:50051,localhost:50052
    enclaveAddresses = process.env.ENCLAVE_ADDRESSES.split(',').map(s => s.trim());
    console.log('[GATEWAY] Using externally managed enclave workers:', enclaveAddresses.join(', '));
} else if (parseInt(process.env.ENCLAVE_POOL_SIZE || '1', 10) > 0 && !process.env.SKIP_WORKER_SPAWN) {
    // Managed pool: spawn worker processes from this process
    workerPool.spawn();
    enclaveAddresses = workerPool.getAddresses();
} else {
    // Legacy single-address fallback
    enclaveAddresses = [process.env.ENCLAVE_ADDRESS || 'localhost:50051'];
}

grpcClient.init(enclaveAddresses);

// ─── Phase 3.3: Configuration Validation at Boot ───
(function validateBootConfig() {
    const fs = require('fs');
    const errors = [];

    // Validate policy bundle loads
    try {
        const { loadAndVerifyBundle } = require('./src/bundle-loader');
        const loaded = loadAndVerifyBundle();
        if (!loaded || !loaded.hash) errors.push('Policy bundle loaded but missing hash');
    } catch (e) {
        errors.push(`Policy bundle validation failed: ${e.message}`);
    }

    // Validate database is writable
    try {
        const db = getDb();
        db.prepare('SELECT 1').get();
    } catch (e) {
        errors.push(`Database validation failed: ${e.message}`);
    }

    if (errors.length > 0) {
        console.error('\n╔══════════════════════════════════════════════════╗');
        console.error('║  BOOT VALIDATION FAILED — REFUSING TO START      ║');
        console.error('╚══════════════════════════════════════════════════╝');
        errors.forEach(e => console.error(`  ✗ ${e}`));
        process.exit(1);
    }
    console.log('[BOOT] Configuration validation passed ✓');
})();

console.log('\n=====================================================');
console.log('  EMBMIS Gateway v1.0 — Command Center');
console.log('  Lifecycle-Governed Enforcement Fabric');
console.log('=====================================================\n');

getDb();
seedTools();
seedPolicies();
// Demo agents have well-known API keys: never seed them in production unless explicitly asked.
const agentKeys = (process.env.NODE_ENV !== 'production' || process.env.SAG_SEED_DEMO === '1') ? seedAgents() : null;
seedVault();

console.log(`\n[SERVER] Control plane initialized. Ed25519 ticket signing active.\n`);

// ══════════════════════════════════════════
//  API ROUTES (all async now)
// ══════════════════════════════════════════

// ─── v1 API (platforms that execute their own tools) ───
app.use('/api/v1', v1.router);

// ─── Auth: Registration ───
app.post('/api/auth/register', async (req, res) => {
    if (isRateLimited(req.ip)) {
        return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
    }
    try {
        const { email, password } = req.body;
        // A gateway you run for yourself can close sign-up once the operators exist. Operators can always register.
        if (process.env.SAG_ALLOW_REGISTRATION === 'false' && !access.operators().includes(String(email || '').toLowerCase())) {
            return res.status(403).json({ error: 'Registration is closed on this gateway. Ask an operator for an account.', code: 'REGISTRATION_CLOSED' });
        }
        const result = await registerUser(email, password);
        if (result.error) return res.status(result.code).json({ error: result.error });

        // Set session cookie on registration (auto-login)
        const loginResult = await loginUser(email, password);
        if (loginResult.success) {
            res.cookie('sag_session', loginResult.sessionId, getSessionCookieOptions());
        }
        res.json({ success: true, user: result.user, apiKey: result.apiKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Auth: Login ───
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await loginUser(email, password);
        if (result.error) return res.status(result.code).json({ error: result.error });

        res.cookie('sag_session', result.sessionId, getSessionCookieOptions());
        res.json({ success: true, user: result.user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Auth: Logout ───
app.post('/api/auth/logout', (req, res) => {
    const sessionId = req.cookies?.sag_session;
    destroySession(sessionId);
    res.clearCookie('sag_session', { path: BASE_PATH || '/' });
    res.json({ success: true });
});

// ─── Auth: Current User ───
app.get('/api/auth/me', (req, res) => {
    const sessionId = req.cookies?.sag_session;
    const user = validateSession(sessionId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user });
});


// ─── Console API: escalation queue, entry inspection, policy tester, billing status ───
function sessionOf(req) {
    return req.user || validateSession(req.cookies && req.cookies.sag_session) || null;
}
function projectOf(req) {
    const u = sessionOf(req);
    return (u && u.projectId) || req.query.projectId || (req.body && req.body.projectId) || 'default_project';
}

app.get('/api/escalations', (req, res) => {
    try {
        const projectId = projectOf(req);
        res.json({
            open: decisions.listOpenEscalations(projectId, parseInt(req.query.limit, 10) || 100),
            resolved: decisions.listResolvedEscalations(projectId, 30),
        });
    } catch (err) { res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' }); }
});

app.post('/api/escalations/:traceId/resolve', (req, res) => {
    try {
        const { outcome, reason } = req.body || {};
        if (outcome !== 'approved' && outcome !== 'rejected') return res.status(400).json({ error: "outcome must be 'approved' or 'rejected'", code: 'INVALID_REQUEST' });
        if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 2000)) return res.status(400).json({ error: 'reason must be a string of at most 2000 characters', code: 'INVALID_REQUEST' });
        const u = sessionOf(req);
        const by = u ? `console:${u.email}` : 'console';
        res.json(decisions.resolveDecision({ projectId: projectOf(req), traceId: req.params.traceId, outcome, by, reason: reason || null }));
    } catch (err) {
        if (err instanceof decisions.DecisionError) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error('[escalations/resolve]', err);
        res.status(500).json({ error: 'Could not record the answer.', code: 'INTERNAL_ERROR' });
    }
});

app.get('/api/audit/entry/:id', (req, res) => {
    try {
        const out = decisions.inspectEntry(req.params.id, projectOf(req));
        if (!out) return res.status(404).json({ error: 'No such audit entry in this workspace', code: 'NOT_FOUND' });
        res.json(out);
    } catch (err) { res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' }); }
});

// One click for a workspace that registered itself in the console: the same starter set a platform tenant gets.
app.post('/api/policies/starter-erp', (req, res) => {
    try {
        const projectId = projectOf(req);
        const n = getDb().prepare('SELECT COUNT(*) AS n FROM policies WHERE project_id = ?').get(projectId).n;
        if (n > 0) return res.status(409).json({ error: 'This workspace already has policies. Edit them instead.', code: 'POLICIES_EXIST' });
        const { seedDefaultErpPolicies } = require('./src/tenant-policy');
        res.status(201).json({ created: seedDefaultErpPolicies(projectId) });
    } catch (err) { res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' }); }
});

// What would the gateway say? Evaluates this workspace's policies and the risk score. Writes nothing.
app.post('/api/policies/test', (req, res) => {
    try {
        const out = require('./src/policy-test').testRequest(projectOf(req), req.body || {});
        res.status(out.status).json(out.body);
    } catch (err) { res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' }); }
});

// What this gateway is running with. Read-only, no secrets: the console's Compliance and Settings pages show it.
app.get('/api/system/status', (req, res) => {
    let bundle = null;
    try {
        const { loadAndVerifyBundle } = require('./src/bundle-loader');
        const loaded = loadAndVerifyBundle();
        const artifact = JSON.parse(require('fs').readFileSync(require('./src/keys').bundlePath(), 'utf8'));
        bundle = { version: loaded.bundle.version, hash: loaded.hash, keyId: artifact.key_id, createdAt: artifact.metadata && artifact.metadata.created_at, signatureVerified: true };
    } catch (e) { bundle = { signatureVerified: false, error: e.message }; }
    const { platformKeyHashes } = require('./src/v1-api');
    res.json({
        version: require('./package.json').version,
        mode: process.env.SAG_MODE || 'enforce',
        environment: process.env.NODE_ENV || 'development',
        accessControl: access.enabled(),
        platformKeys: platformKeyHashes().length,
        bundle,
        database: process.env.DB_ADAPTER || 'sqlite',
        llm: { provider: llmConfig.provider, model: llmConfig.model, configured: !!llmConfig.apiKey },
        billing: { free: true },
        auditCheckpoints: 'logs/audit-checkpoints.log',
    });
});

// ─── Gateway: Process MCP Tool Call (THE FIREWALL) ───
app.post('/api/gateway/execute', async (req, res) => {
    try {
        // SaaS Auth (Bearer Token) or Legacy Auth (Headers)
        const authHeader = req.headers.authorization || '';
        const apiKey = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') 
            : req.headers['x-api-key'] || req.headers['x-agent-key'] || req.body.agentApiKey;
            
        const { agentName, tool, action, args, resource } = req.body;
        if (!tool) return res.status(400).json({ error: 'Missing required field: tool' });

        const traceId = req.headers['x-trace-id'] || null;
        const parentSpanId = req.headers['x-span-id'] || null;

        const result = await processRequest({
            agentApiKey: apiKey,
            agentName,
            tool,
            action: action || 'EXECUTE',
            args: args || {},
            resource: resource || {},
            traceId,
            parentSpanId
        });

        const httpStatus = result.status === 'APPROVED' ? 200
            : result.status === 'ESCALATED' ? 202
                : result.status === 'ERROR' ? 500
                    : 403;
        res.status(httpStatus).json(result);
    } catch (err) {
        console.error('[GATEWAY ERROR]', err);
        res.status(500).json({ error: 'Internal gateway error', detail: err.message });
    }
});

app.post('/api/projects/:id/keys', (req, res) => {
    try {
        const projectId = req.params.id;
        const db = getDb();
        
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        
        const crypto = require('crypto');
        const rawKey = 'sag_live_' + crypto.randomBytes(24).toString('hex');
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        
        db.prepare('UPDATE projects SET api_key_hash = ? WHERE id = ?').run(hash, projectId);
        res.json({ success: true, newKey: rawKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Gateway: Simulate a request (policy testing) ───
app.post('/api/gateway/simulate', (req, res) => {
    try {
        const { agentName, tool, action, resource } = req.body;
        const db = getDb();
        const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName);
        if (!agent) return res.status(404).json({ error: `Agent "${agentName}" not found` });

        const policyResult = evaluateRequest({ agent, tool: tool || '', action: action || 'READ', resource: resource || {}, args: {} });
        const riskResult = scoreRequest({ agent, tool: tool || '', action: action || 'READ', resource: resource || {}, args: {} });

        res.json({
            agent: { name: agent.name, role: agent.role, trustScore: agent.trust_score },
            policy: policyResult,
            risk: riskResult,
            finalDecision: riskResult.autoBlock ? 'deny' : policyResult.decision,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── SaaS: Workspace & Project Management API ───
app.get('/api/projects', (req, res) => {
    try {
        const db = getDb();
        const mine = access.enabled() && req.user && !access.operators().includes(String(req.user.email).toLowerCase());
        const projects = mine
            ? db.prepare('SELECT id, name, created_at FROM projects WHERE id = ? ORDER BY created_at ASC').all(req.user.projectId)
            : db.prepare('SELECT id, name, created_at FROM projects ORDER BY created_at ASC').all();
        res.json(projects);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        
        const db = getDb();
        const { v4: uuidv4 } = require('uuid');
        const crypto = require('crypto');
        
        const id = 'proj_' + uuidv4().replace(/-/g, '').substring(0, 16);
        const rawKey = 'sag_live_' + crypto.randomBytes(24).toString('hex');
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        
        db.prepare('INSERT INTO projects (id, name, api_key_hash) VALUES (?, ?, ?)')
          .run(id, name, hash);
          
        res.json({ id, name, apiKey: rawKey });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Simulate Agent (Converts raw prompt to tool call for Live Demo) ───
app.post('/api/simulate-agent', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        const systemPrompt = `You are a strict JSON converter. Analyze the user request and translate it into a JSON tool call. 
You have three tools available: 
1. "stripe.payment.create" (args: amount [number], currency, destination, description)
2. "database.user.query" (args: userId, fields [array])
3. "system.file.read" (args: path).
Guess what tool the agent would call and its arguments based on the text. 
Return ONLY raw JSON in this exact format: {"tool": "tool_name", "action": "EXECUTE", "args": {}}`;

        let toolPayload;
        try {
            const ollamaRes = await fetch('http://localhost:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: process.env.LLM_MODEL || 'llama3',
                    stream: false,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt }
                    ]
                })
            });
            
            if (!ollamaRes.ok) throw new Error('Ollama failed to respond');
            const ollamaData = await ollamaRes.json();
            const textResponse = ollamaData.message?.content || '';
            
            // Clean markdown blocks if present
            let cleaned = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            // find the first { and last }
            const startIdx = cleaned.indexOf('{');
            const endIdx = cleaned.lastIndexOf('}');
            if (startIdx >= 0 && endIdx >= startIdx) {
                cleaned = cleaned.substring(startIdx, endIdx + 1);
            }
            toolPayload = JSON.parse(cleaned);
        } catch (e) {
            console.error('Simulate LLM parse failed:', e.message);
            // Fallback if LLM fails formatting
            toolPayload = { tool: 'unknown.action', action: 'EXECUTE', args: { raw_input: prompt, parse_error: true } };
        }

        // Now pass this simulated tool call straight into the standard explain logic
        const explainRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentName: 'finance-copilot',
                tool: toolPayload.tool || 'unknown',
                action: toolPayload.action || 'EXECUTE',
                args: toolPayload.args || {}
            })
        });
        
        const explainData = await explainRes.json();
        res.status(explainRes.status).json(explainData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Explain: Full decision breakdown (inspectable) ───
app.post('/api/explain', async (req, res) => {
    try {
        const { agentName, agentKey, tool, action, args, resource } = req.body;
        const db = getDb();

        // Resolve agent by name or key
        let agent;
        if (agentKey) {
            const hash = require('crypto').createHash('sha256').update(agentKey).digest('hex');
            agent = db.prepare("SELECT * FROM agents WHERE api_key_hash = ? AND status = 'active'").get(hash);
        } else if (agentName) {
            agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName);
        }
        // Auto-register unknown agents for demo/explain purposes
        if (!agent && agentName) {
            const { uuidv4 } = require('./src/database');
            const newId = uuidv4();
            const demoHash = require('crypto').createHash('sha256').update('demo_' + agentName).digest('hex');
            db.prepare("INSERT OR IGNORE INTO agents (id, name, role, department, status, trust_score, api_key_hash) VALUES (?, ?, 'dynamic', 'demo', 'active', 50, ?)")
              .run(newId, agentName, demoHash);
            agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(agentName);
        }
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        // Policy evaluation
        const { loadAndVerifyBundle } = require('./src/bundle-loader');
        const { evaluateAuthorization } = require('./src/policy-evaluator');
        const loaded = loadAndVerifyBundle();
        const intent = { tool: tool || '', action: action || 'EXECUTE', args: args || {} };
        const policyResult = evaluateAuthorization(loaded.bundle, agent.role, intent);

        // Intent evaluation
        const { analyzeIntent } = require('./src/intent-analyzer');
        const intentResult = await analyzeIntent({
            tool: tool || '',
            action: action || 'EXECUTE',
            args: args || {},
            agentRole: agent.role
        });

        // Risk evaluation
        const riskResult = scoreRequest({
            agent, tool: tool || '', action: action || 'EXECUTE',
            resource: resource || {}, args: args || {},
            semanticSuspicion: intentResult
        });

        // Decision logic (mirrors gateway.js processRequest)
        let decision, code, reason;
        if (!policyResult.allowed) {
            decision = 'DENIED';
            code = 'POLICY_DENY';
            reason = policyResult.reason;
        } else if (riskResult.autoBlock) {
            decision = 'DENIED';
            code = 'RISK_AUTO_BLOCK';
            reason = `Risk score ${riskResult.score}/100 exceeds auto-block threshold (${riskResult.threshold.autoBlock})`;
        } else if (riskResult.needsHumanApproval) {
            decision = 'ESCALATED';
            code = 'REQUIRES_HUMAN_APPROVAL';
            reason = `Risk score ${riskResult.score}/100 exceeds escalation threshold (${riskResult.threshold.escalation})`;
        } else {
            decision = 'APPROVED';
            code = 'EXECUTION_ALLOWED';
            reason = 'Policy allows and risk is below escalation threshold';
        }

        res.json({
            decision,
            code,
            reason,
            agent: {
                name: agent.name,
                role: agent.role,
                trustScore: agent.trust_score,
                status: agent.status,
            },
            policy: {
                allowed: policyResult.allowed,
                reason: policyResult.reason || 'Allowed by role permissions',
                bundleVersion: loaded.bundle.version,
                bundleHash: loaded.hash,
            },
            semantic: intentResult,
            risk: {
                score: riskResult.score,
                factors: riskResult.factors,
                thresholds: riskResult.threshold,
                autoBlock: riskResult.autoBlock,
                needsHumanApproval: riskResult.needsHumanApproval,
            },
            request: { tool, action: action || 'EXECUTE', args },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Agents ───
app.get('/api/agents', (req, res) => res.json(listAgents(req.query.projectId)));
app.get('/api/agents/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
});
app.post('/api/agents', (req, res) => {
    try { res.status(201).json(registerAgent(req.body)); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.patch('/api/agents/:id/trust', (req, res) => {
    updateAgentTrust(req.params.id, req.body.trustScore);
    res.json({ updated: true });
});
app.post('/api/agents/:id/suspend', (req, res) => {
    suspendAgent(req.params.id);
    res.json({ suspended: true });
});

// ─── Kill-Switch ───
app.post('/api/agents/:id/kill', (req, res) => {
    try {
        const result = killAgent(req.params.id);
        if (result.alreadyRevoked) return res.status(409).json({ error: 'Agent already revoked' });
        res.json({ killed: true, agentId: req.params.id, revokedAt: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agents/:id/reactivate', (req, res) => {
    try {
        reactivateAgent(req.params.id);
        res.json({ reactivated: true, agentId: req.params.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Policies ───
app.get('/api/policies', (req, res) => res.json(listPolicies(req.query.projectId)));
app.get('/api/policies/:id', (req, res) => {
    const policy = getPolicy(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json(policy);
});
app.post('/api/policies', (req, res) => {
    try { res.status(201).json(createPolicy(req.body)); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/policies/:id', (req, res) => { updatePolicy(req.params.id, req.body); res.json({ updated: true }); });
app.delete('/api/policies/:id', (req, res) => { deletePolicy(req.params.id); res.json({ deleted: true }); });

// ─── Tool Registry ───
app.get('/api/tools', (req, res) => res.json(listTools()));
app.post('/api/tools', (req, res) => {
    try { res.status(201).json(registerTool(req.body)); }
    catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── Role Permissions Matrix ───
app.get('/api/permissions', (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM role_permissions ORDER BY role, tool_name').all());
});
app.put('/api/permissions', (req, res) => {
    const db = getDb();
    const { role, toolName, permission } = req.body;
    db.prepare('INSERT OR REPLACE INTO role_permissions (role, tool_name, permission) VALUES (?, ?, ?)').run(role, toolName, permission);
    res.json({ updated: true });
});

// ─── Audit Log ───
app.get('/api/audit', (req, res) => {
    const { projectId, agentId, tool, decision, limit, offset, traceId, kind } = req.query;
    res.json(queryLog({ projectId, agentId, tool, decision, traceId, decisionsOnly: kind === 'decision', limit: Math.min(parseInt(limit) || 50, 1000), offset: parseInt(offset) || 0 }));
});
app.get('/api/audit/stats', (req, res) => res.json(getStats(req.query.projectId)));
app.get('/api/audit/verify', (req, res) => res.json(verifyChain(parseInt(req.query.limit) || 1000)));

// ─── Audit Export (free) ───
app.get('/api/audit/export', (req, res) => {
    try {
        const { format = 'json', from, to, agentId, tool, decision, projectId } = req.query;


        const result = exportAuditLog({ projectId, agentId, tool, decision, from, to, format });
        const dateTag = new Date().toISOString().slice(0, 10);

        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="sag-audit-${dateTag}.csv"`);
            return res.send(result.data);
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="sag-audit-${dateTag}.json"`);
        res.json({ exported_at: new Date().toISOString(), count: result.count, records: result.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Enclave / Worker Pool Status ───
app.get('/api/enclave/status', (req, res) => {
    res.json({
        active: grpcClient.isInitialized(),
        pool: grpcClient.poolStatus(),
        workers: workerPool.status(),
        message: 'gRPC pool active',
    });
});

app.get('/api/workers/status', (req, res) => {
    res.json({
        pool:    grpcClient.poolStatus(),
        workers: workerPool.status(),
        poolSize: parseInt(process.env.ENCLAVE_POOL_SIZE || '1', 10),
    });
});
app.post('/api/enclave/rotate-keys', async (req, res) => {
    try {
        if (!grpcClient.isInitialized()) {
            return res.status(503).json({ error: 'gRPC client pool not initialised' });
        }

        const rotatedAt = new Date().toISOString();

        // Generate a new Ed25519 keypair for gateway → enclave ticket verification
        const { privateKey: newPrivateKey, publicKey: newPublicKey } =
            crypto.generateKeyPairSync('ed25519');

        // Export keys in PEM + DER formats
        const newPrivatePem = newPrivateKey.export({ type: 'pkcs8',  format: 'pem' });
        const newPublicPem  = newPublicKey.export({ type: 'spki',   format: 'pem' });
        const newPublicDer  = newPublicKey.export({ type: 'spki',   format: 'der' });

        // Compute fingerprint for audit log
        const fingerprint = crypto
            .createHash('sha256')
            .update(newPublicDer)
            .digest('hex');

        // Send new public key to all enclave workers via gRPC RotateKeys
        const result = await grpcClient.rotateKeys(newPublicDer, rotatedAt);

        if (!result.success) {
            const failedWorkers = result.workerResults.filter(r => !r.success);
            console.error('[ROTATE-KEYS] Some workers failed key rotation:', failedWorkers);
            return res.status(500).json({
                error:          'Key rotation failed on one or more workers',
                workerResults:  result.workerResults,
            });
        }

        // Persist new gateway private key to disk so gateway uses it after restart
        const certsDir = require('path').join(__dirname, 'certs');
        const fs = require('fs');
        fs.writeFileSync(require('path').join(certsDir, 'gateway-ed25519.key'), newPrivatePem, { mode: 0o600 });
        fs.writeFileSync(require('path').join(certsDir, 'gateway-ed25519.pub'), newPublicPem,  { mode: 0o644 });

        console.log(`[ROTATE-KEYS] Ed25519 keypair rotated. Fingerprint: ${fingerprint.substring(0, 16)}… at ${rotatedAt}`);

        res.json({
            success:            true,
            rotatedAt,
            newKeyFingerprint:  fingerprint,
            workerResults:      result.workerResults,
        });
    } catch (err) {
        console.error('[ROTATE-KEYS] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Threat Alerts ───
app.get('/api/alerts', (req, res) => res.json(getThreatAlerts(parseInt(req.query.limit) || 20, req.query.projectId)));
app.post('/api/alerts/:id/resolve', (req, res) => {
    const db = getDb();
    db.prepare('UPDATE threat_alerts SET resolved = 1 WHERE id = ?').run(req.params.id);
    res.json({ resolved: true });
});

// ─── Encrypted Vault ───
app.get('/api/vault/assets', (req, res) => res.json(listAssets()));
app.post('/api/vault/assets', (req, res) => {
    try { res.status(201).json(storeAsset(req.body)); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/vault/access-log', (req, res) => res.json(getAccessLog(req.query.assetId, parseInt(req.query.limit) || 50)));

// ─── GDPR Erasure ───
app.post('/api/vault/erasure', (req, res) => {
    try { res.json(processErasure(req.body.userIdentifier)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/vault/erasure', (req, res) => res.json(listErasureRequests()));

// ─── Dashboard Stats ───
app.get('/api/dashboard/stats', (req, res) => {
    const db = getDb();
    const pid = req.query.projectId || null;
    
    // Use optional project_id filtering
    let agentsSql = "SELECT COUNT(*) as c FROM agents WHERE status = 'active'";
    let alertsSql = "SELECT COUNT(*) as c FROM threat_alerts WHERE resolved = 0";
    if (pid) {
        agentsSql += " AND project_id = ?";
        alertsSql += " AND project_id = ?";
    }
    
    const agents = pid ? db.prepare(agentsSql).get(pid).c : db.prepare(agentsSql).get().c;
    const alerts = pid ? db.prepare(alertsSql).get(pid).c : db.prepare(alertsSql).get().c;
    const auditStats = getStats(pid);

    res.json({
        activeAgents: agents,
        totalRequests: auditStats.totalActions,
        approved: auditStats.approved,
        denied: auditStats.denied,
        escalated: auditStats.escalated,
        approvalRate: auditStats.approvalRate,
        avgLatencyMs: auditStats.averageLatencyMs,
        avgRiskScore: auditStats.averageRiskScore,
        activeAlerts: alerts,
        processIsolation: true,
        gatewayPid: process.pid,
        architecture: 'distributed-grpc',
    });
});

// ─── Architecture Info ───
app.get('/api/architecture', (req, res) => {
    res.json({
        version: 'v1.0',
        architecture: 'distributed-grpc',
        gateway: { pid: process.pid, role: 'control_plane' },
        securityBoundary: 'grpc-trust-isolation',
        protocol: 'gRPC-HMAC-SHA256',
        ticketTTL: '2000ms',
        replayProtection: 'lru-nonce-cache-pending-redis',
        signatureMethod: 'canonical-json + hmac-sha256 + timingSafeEqual',
    });
});

// ─── LLM Settings (runtime configurable) ───
const llmConfig = {
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'disabled',
    model: process.env.LLM_MODEL || 'gpt-5-nano',
    endpoint: process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/responses',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '3000'),
};

app.get('/api/settings/llm', (req, res) => {
    res.json({
        provider: llmConfig.provider,
        model: llmConfig.model,
        endpoint: llmConfig.endpoint,
        timeoutMs: llmConfig.timeoutMs,
        hasApiKey: !!llmConfig.apiKey,
        status: llmConfig.provider === 'disabled' ? 'disabled' :
                llmConfig.apiKey ? 'configured' : 'missing_key',
    });
});

app.post('/api/settings/llm', (req, res) => {
    const { provider, model, endpoint, apiKey, timeoutMs } = req.body;
    if (provider) llmConfig.provider = provider;
    if (model) llmConfig.model = model;
    if (endpoint) llmConfig.endpoint = endpoint;
    if (apiKey !== undefined) llmConfig.apiKey = apiKey;
    if (timeoutMs) llmConfig.timeoutMs = parseInt(timeoutMs);

    // Update environment vars so intent-analyzer picks them up
    if (llmConfig.provider === 'disabled') {
        process.env.LLM_API_KEY = '';
        process.env.OPENAI_API_KEY = '';
    } else if (llmConfig.provider === 'ollama') {
        process.env.LLM_ENDPOINT = llmConfig.endpoint || 'http://localhost:11434/v1/chat/completions';
        process.env.LLM_MODEL = llmConfig.model || 'llama3.1:8b';
        process.env.LLM_API_KEY = 'ollama';
        process.env.OPENAI_API_KEY = 'ollama';
    } else {
        // openai
        process.env.LLM_ENDPOINT = 'https://api.openai.com/v1/responses';
        process.env.LLM_MODEL = llmConfig.model || 'gpt-5-nano';
        if (llmConfig.apiKey) {
            process.env.LLM_API_KEY = llmConfig.apiKey;
            process.env.OPENAI_API_KEY = llmConfig.apiKey;
        }
    }
    process.env.LLM_TIMEOUT_MS = String(llmConfig.timeoutMs);

    console.log(`[SETTINGS] LLM provider changed → ${llmConfig.provider} (${llmConfig.model})`);
    res.json({ ok: true, current: { provider: llmConfig.provider, model: llmConfig.model, status: llmConfig.apiKey ? 'configured' : 'missing_key' } });
});

// ─── Observability Metrics ───
app.get('/api/metrics', (req, res) => {
    const { getAnalyzerMetrics } = require('./src/intent-analyzer');
    const metrics = getAnalyzerMetrics();
    
    let behavioralMetrics = {};
    try {
        const { getEngineMetrics } = require('./src/behavioral-engine');
        behavioralMetrics = getEngineMetrics();
    } catch (e) { /* module not loaded yet */ }
    
    res.json({
        uptime: process.uptime(),
        llm: metrics,
        behavioral: behavioralMetrics,
        memory: process.memoryUsage(),
    });
});

// ─── Usage / Billing ───
app.get('/api/usage', (req, res) => {
    const { getUsage, getUsageHistory } = require('./src/usage-tracker');
    const projectId = req.query.projectId || 'default_project';
    const current = getUsage(projectId);
    const history = getUsageHistory(projectId, 6);
    res.json({ current, history });
});

app.get('/api/workspaces/:id/usage', (req, res) => {
    try {
        const { getUsage, getUsageHistory } = require('./src/usage-tracker');
        const projectId = req.params.id;
        const db = getDb();
        const project = db.prepare('SELECT id, name, plan FROM projects WHERE id = ?').get(projectId);
        if (!project) return res.status(404).json({ error: 'Workspace not found' });

        const current = getUsage(projectId);
        const history = getUsageHistory(projectId, 6);
        const limit   = null; // free: no check limit
        const used    = current?.api_requests || 0;

        res.json({
            workspace: { id: project.id, name: project.name, plan: project.plan || 'starter' },
            current: { ...current, limit, used, remaining: null, overageUnits: 0 },
            history,
            billing: { overageRate: 0, estimatedOverage: '0.0000' },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Escalation Config ───
app.get('/api/escalation/:projectId', (req, res) => {
    try {
        // The stored webhook URL and SMTP URL are secrets (they can carry tokens and passwords): the browser
        // only learns that they are set, and where.
        const hint = (u) => { try { return new URL(u).host; } catch { return 'set'; } };
        res.json(listEscalationConfigs(req.params.projectId).map((c) => ({
            ...c,
            slack_webhook_url: c.slack_webhook_url ? hint(c.slack_webhook_url) : null,
            smtp_url: c.smtp_url ? hint(c.smtp_url) : null,
            has_slack_webhook: !!c.slack_webhook_url,
            has_smtp: !!c.smtp_url,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/escalation/:projectId', (req, res) => {
    try {
        const { channel, slackWebhookUrl, smtpUrl, emailFrom, emailTo, minSeverity, enabled } = req.body;
        if (!channel) return res.status(400).json({ error: 'channel is required (slack or email)' });
        // A blank secret means "keep what is stored": the browser is never shown them, so it cannot send them back.
        const prior = listEscalationConfigs(req.params.projectId).find((c) => c.channel === channel);
        const result = upsertEscalationConfig({
            projectId: req.params.projectId,
            channel,
            slackWebhookUrl: slackWebhookUrl || prior?.slack_webhook_url,
            smtpUrl: smtpUrl || prior?.smtp_url,
            emailFrom, emailTo, minSeverity, enabled,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/escalation/config/:id', (req, res) => {
    try {
        deleteEscalationConfig(req.params.id);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Financial Threshold Config ───
const { listThresholds, upsertThreshold, deleteThreshold } = require('./src/financial-guard');

app.get('/api/financial-threshold/:projectId', (req, res) => {
    try {
        res.json(listThresholds(req.params.projectId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/financial-threshold/:projectId', (req, res) => {
    try {
        const { tool, maxAmount, currency, enabled } = req.body;
        if (!maxAmount) return res.status(400).json({ error: 'maxAmount is required' });
        const result = upsertThreshold({
            projectId: req.params.projectId,
            tool: tool || '*',
            maxAmount: parseFloat(maxAmount),
            currency: currency || 'USD',
            enabled,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/financial-threshold/:id', (req, res) => {
    try {
        deleteThreshold(req.params.id);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Plans (the Gateway is free: one plan, no limit) ───
const billing = require('./src/billing');
const { notify: _escalationNotify, listConfigs: listEscalationConfigs, upsertConfig: upsertEscalationConfig, deleteConfig: deleteEscalationConfig } = require('./src/escalation');

app.get('/api/billing/plans', (req, res) => {
    res.json(billing.PLANS);
});

// What the console's Usage page shows: free, unlimited, nothing to pay.
app.get('/api/billing/status', (req, res) => {
    res.json({ free: true, unlimited: true, plans: [], checkoutAvailable: false, overageRate: 0 });
});

// ─── Health Checks ───
function gatewayHealthData() {
    return {
        status: 'ok',
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        version: '1.0.0',
        adapter: process.env.DB_ADAPTER || 'sqlite',
    };
}

function dbHealthData() {
    try {
        const db = getDb();
        const start = Date.now();
        db.prepare('SELECT 1').get();
        return { status: 'ok', latencyMs: Date.now() - start, adapter: process.env.DB_ADAPTER || 'sqlite' };
    } catch (err) {
        return { status: 'error', error: err.message };
    }
}

app.get('/health', (req, res) => {
    const gw = gatewayHealthData();
    const db = dbHealthData();
    const overall = [gw.status, db.status].every(s => s === 'ok') ? 'ok' : 'degraded';
    res.status(overall === 'ok' ? 200 : 503).json({ status: overall, gateway: gw, db, ts: new Date().toISOString() });
});

app.get('/health/gateway', (req, res) => {
    const data = gatewayHealthData();
    res.status(data.status === 'ok' ? 200 : 503).json(data);
});

app.get('/health/db', (req, res) => {
    const data = dbHealthData();
    res.status(data.status === 'ok' ? 200 : 503).json(data);
});

app.get('/health/enclave', (req, res) => {
    const initialized = grpcClient.isInitialized();
    const poolStat = grpcClient.poolStatus();
    const healthyCount = poolStat.filter(e => e.healthy).length;
    const status = initialized && healthyCount > 0 ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
        status,
        transport: 'gRPC',
        addresses: enclaveAddresses,
        poolSize: poolStat.length,
        healthyWorkers: healthyCount,
        pool: poolStat,
    });
});

// Keep existing /api/health for backwards compat
app.get('/api/health', (req, res) => {
    res.json({
        status: 'operational',
        version: '1.0.0',
        service: 'EMBMIS Gateway',
        uptime: process.uptime(),
        database: dbHealthData().status,
        gatewayPid: process.pid,
        llm: { provider: llmConfig.provider, model: llmConfig.model, configured: !!llmConfig.apiKey },
    });
});


// ─── Console (React app) with SPA fallback ───
// console/dist is built by `npm run console:build` (the Docker image does it for you).
{
    const fs = require('fs');
    const CONSOLE_DIST = path.join(__dirname, 'console', 'dist');
    const indexFile = path.join(CONSOLE_DIST, 'index.html');
    if (fs.existsSync(indexFile)) {
        app.use('/assets', express.static(path.join(CONSOLE_DIST, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
        app.use(express.static(CONSOLE_DIST, { index: false, maxAge: '1h' }));
        app.get(/^\/(?!api(\/|$)|ws$|health)/, (req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(indexFile);
        });
    } else {
        app.get('/', (req, res) => res.status(503).type('text/plain').send('EMBMIS Gateway is running, but the console is not built. Run: npm run console:build'));
    }
}

// ─── Errors: JSON, never HTML ───
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON', code: 'INVALID_JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) return res.status(status).json({ error: status === 404 ? 'Not found' : 'The request could not be handled', code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
    console.error('[SERVER]', err);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
});

// ─── Start Server ───
server.listen(PORT, () => {
    console.log(`\n  Agent Gateway running at http://localhost:${PORT}`);
    console.log(`  Architecture: DISTRIBUTED (gRPC Isolation)`);
    console.log(`  Gateway PID: ${process.pid}`);
    console.log(`  gRPC Target: ${enclaveAddresses.join(', ')}`);
    console.log(`  Protocol: gRPC + HMAC-SHA256 Tickets\n`);
    console.log('  POST /api/gateway/execute    - Process MCP tool call');
    console.log('  GET  /api/health             - Health check\n');
});


// ─── Graceful shutdown ───
function gracefulShutdown(signal) {
    console.log(`\n[GATEWAY] ${signal} received. Shutting down...`);
    workerPool.shutdown();
    server.close(() => {
        console.log('[GATEWAY] HTTP server closed.');
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
