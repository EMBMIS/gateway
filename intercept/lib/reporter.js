'use strict';

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

// Append a single observation line to the log file (learn mode)
function appendLearnLog(entry) {
    const line = JSON.stringify(entry) + '\n';
    try {
        fs.appendFileSync(path.resolve(process.cwd(), cfg.logFile), line, 'utf8');
    } catch (_) {
        // never crash the host app over logging
    }
}

// Send a tool call to the SAG gateway and return the decision
async function enforceCall(toolName, args) {
    const body = JSON.stringify({
        agentApiKey: cfg.apiKey,
        tool: toolName,
        action: 'EXECUTE',
        args: args || {},
        resource: {},
    });

    try {
        const res = await fetch(`${cfg.gatewayUrl}/api/gateway/execute`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Key': cfg.apiKey,
            },
            body,
            signal: AbortSignal.timeout(5000),
        });

        const data = await res.json();
        return { allowed: res.status === 200, blocked: res.status === 403, data };
    } catch (err) {
        if (cfg.failOpen) {
            if (cfg.debug) console.warn('[sag-intercept] Gateway unreachable, fail-open:', err.message);
            return { allowed: true, blocked: false, data: null };
        }
        throw new Error(`[sag-intercept] SAG gateway unreachable and SAG_FAIL_OPEN=false. Set SAG_FAIL_OPEN=true to allow on outage.`);
    }
}

// Main report function — called before every intercepted AI SDK call
async function report(toolName, args) {
    const entry = {
        ts:      new Date().toISOString(),
        agent:   cfg.agentId,
        tool:    toolName,
        args,
        mode:    cfg.mode,
    };

    if (cfg.isLearn) {
        appendLearnLog(entry);
        if (cfg.debug) console.log(`[sag-intercept] [LEARN] ${toolName}`);
        return { allowed: true, blocked: false };
    }

    // enforce mode
    const decision = await enforceCall(toolName, args);

    if (cfg.debug) {
        console.log(`[sag-intercept] [${decision.allowed ? 'ALLOW' : 'BLOCK'}] ${toolName}`);
    }

    return decision;
}

module.exports = { report };
