'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// Human-readable descriptions for known tool patterns
const TOOL_DESCRIPTIONS = {
    'openai.chat.completions.create':   'Generate a chat response via OpenAI',
    'openai.chat.completions.stream':   'Stream a chat response via OpenAI',
    'openai.completions.create':        'Generate a text completion via OpenAI',
    'openai.embeddings.create':         'Generate vector embeddings via OpenAI',
    'openai.images.generate':           'Generate an image via OpenAI DALL-E',
    'openai.images.edit':               'Edit an image via OpenAI',
    'openai.audio.transcriptions.create': 'Transcribe audio via OpenAI Whisper',
    'openai.beta.threads.runs.create':  'Run an OpenAI Assistant thread',
    'openai.beta.threads.runs.createAndPoll': 'Run and poll an OpenAI Assistant thread',
    'anthropic.messages.create':        'Send a message via Anthropic Claude',
    'anthropic.messages.stream':        'Stream a message via Anthropic Claude',
    'anthropic.messages.countTokens':   'Count tokens for an Anthropic message',
    'anthropic.beta.messages.create':   'Send a beta message via Anthropic Claude',
    'langchain.chat.invoke':            'Invoke a LangChain chat model',
    'langchain.llm.invoke':             'Invoke a LangChain LLM',
};

// Tools that should always require human approval regardless of volume
const HIGH_RISK_TOOLS = new Set([
    'openai.images.edit',
    'openai.beta.threads.runs.create',
    'openai.beta.threads.runs.createAndPoll',
]);

function readObservations(logFile) {
    const absPath = path.resolve(process.cwd(), logFile);

    if (!fs.existsSync(absPath)) {
        throw new Error(`Observations file not found: ${absPath}\nRun your app in SAG_MODE=learn first.`);
    }

    const lines = fs.readFileSync(absPath, 'utf8')
        .split('\n')
        .filter(l => l.trim());

    if (lines.length === 0) {
        throw new Error(`Observations file is empty: ${absPath}`);
    }

    return lines.map((line, i) => {
        try {
            return JSON.parse(line);
        } catch {
            throw new Error(`Invalid JSON on line ${i + 1} of ${absPath}`);
        }
    });
}

function analyzeObservations(observations) {
    const toolStats  = new Map(); // tool -> { count, agents, models, firstSeen, lastSeen }
    const agentTools = new Map(); // agentId -> Set<tool>

    for (const obs of observations) {
        const tool    = obs.tool;
        const agent   = obs.agent || 'default-agent';
        const model   = obs.args?.model || null;
        const ts      = obs.ts || new Date().toISOString();

        // tool stats
        if (!toolStats.has(tool)) {
            toolStats.set(tool, { count: 0, agents: new Set(), models: new Set(), firstSeen: ts, lastSeen: ts });
        }
        const stat = toolStats.get(tool);
        stat.count++;
        stat.agents.add(agent);
        if (model) stat.models.add(model);
        if (ts < stat.firstSeen) stat.firstSeen = ts;
        if (ts > stat.lastSeen)  stat.lastSeen  = ts;

        // agent -> tools map
        if (!agentTools.has(agent)) agentTools.set(agent, new Set());
        agentTools.get(agent).add(tool);
    }

    return { toolStats, agentTools };
}

function buildPolicies(toolStats) {
    const policies = [];
    let policyId = 200;

    // Always-on safety policies
    policies.push({
        id: `pol-${policyId++}`,
        name: 'Block All DELETE Operations',
        description: 'Deny all DELETE actions regardless of agent',
        priority: 1,
        effect: 'deny',
        conditions: { action: 'DELETE' },
    });

    policies.push({
        id: `pol-${policyId++}`,
        name: 'Block DROP TABLE',
        description: 'Deny all DROP TABLE actions',
        priority: 1,
        effect: 'deny',
        conditions: { action: 'DROP_TABLE' },
    });

    // Flag high-volume AI calls for review
    for (const [tool, stat] of toolStats.entries()) {
        if (stat.count > 1000) {
            policies.push({
                id: `pol-${policyId++}`,
                name: `Rate-flag: ${tool}`,
                description: `Auto-generated: ${tool} seen ${stat.count} times in learn period`,
                priority: 10,
                effect: 'escalate',
                conditions: { tool, velocity: 'high' },
            });
        }
    }

    return policies;
}

function buildToolRegistry(toolStats) {
    const registry = {};
    for (const [tool, stat] of toolStats.entries()) {
        registry[tool] = {
            description: TOOL_DESCRIPTIONS[tool] || `Auto-detected tool: ${tool}`,
            observedCount: stat.count,
            firstSeen: stat.firstSeen,
            lastSeen: stat.lastSeen,
            models: [...stat.models],
        };
    }
    return registry;
}

function buildRolePermissions(agentTools) {
    const rolePermissions = {};

    for (const [agent, tools] of agentTools.entries()) {
        const role = agent.replace(/[^a-zA-Z0-9_-]/g, '_');
        rolePermissions[role] = {};

        for (const tool of tools) {
            rolePermissions[role][tool] = HIGH_RISK_TOOLS.has(tool) ? 'escalate' : 'allow';
        }
    }

    return rolePermissions;
}

function generateBundle(observations) {
    const { toolStats, agentTools } = analyzeObservations(observations);

    const bundle = {
        version: 3,
        generated: true,
        generatedAt: new Date().toISOString(),
        observationCount: observations.length,
        policies:         buildPolicies(toolStats),
        role_permissions: buildRolePermissions(agentTools),
        risk_thresholds: {
            autoBlock:             85,
            requiresHumanApproval: 60,
        },
        tool_registry: buildToolRegistry(toolStats),
    };

    const bundleStr = JSON.stringify(bundle);
    const hash = crypto.createHash('sha256').update(bundleStr).digest('hex');

    return {
        metadata: {
            version: '1.0.0',
            compiler_version: '0.5.0',
            created_at: new Date().toISOString(),
            policy_bundle_hash: hash,
            generated_by: 'sag-intercept/generate-policy',
            observation_count: observations.length,
            tool_count: toolStats.size,
            agent_count: agentTools.size,
        },
        bundle,
        signature: null,
        _note: 'This bundle was auto-generated from learn mode observations. Review policies before switching to enforce mode. Signature is null — sign with your policy key before production use.',
    };
}

function generatePolicy({ logFile = '.sag-observations.jsonl', outFile = 'policy.bundle.json', dry = false } = {}) {
    console.log(`[sag-policy-gen] Reading observations from: ${logFile}`);
    const observations = readObservations(logFile);
    console.log(`[sag-policy-gen] Analyzed ${observations.length} observations`);

    const policyBundle = generateBundle(observations);

    const { bundle } = policyBundle;
    console.log(`[sag-policy-gen] Detected ${bundle.tool_registry ? Object.keys(bundle.tool_registry).length : 0} unique tools`);
    console.log(`[sag-policy-gen] Generated ${bundle.policies.length} policies`);
    console.log(`[sag-policy-gen] Built permissions for ${Object.keys(bundle.role_permissions).length} agents`);

    if (dry) {
        console.log('\n--- DRY RUN OUTPUT ---');
        console.log(JSON.stringify(policyBundle, null, 2));
        return policyBundle;
    }

    const absOut = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(absOut, JSON.stringify(policyBundle, null, 2), 'utf8');
    console.log(`[sag-policy-gen] Policy bundle written to: ${absOut}`);
    console.log(`[sag-policy-gen] Review it, then set SAG_MODE=enforce to activate.`);

    return policyBundle;
}

module.exports = { generatePolicy, readObservations, analyzeObservations, generateBundle };
