'use strict';

const MODE_LEARN   = 'learn';
const MODE_ENFORCE = 'enforce';

function loadConfig() {
    const mode = (process.env.SAG_MODE || MODE_LEARN).toLowerCase();

    if (mode !== MODE_LEARN && mode !== MODE_ENFORCE) {
        throw new Error(`[sag-intercept] SAG_MODE must be "learn" or "enforce", got "${mode}"`);
    }

    if (mode === MODE_ENFORCE && !process.env.SAG_API_KEY) {
        throw new Error('[sag-intercept] SAG_API_KEY is required in enforce mode');
    }

    return {
        mode,
        apiKey:     process.env.SAG_API_KEY || null,
        gatewayUrl: (process.env.SAG_GATEWAY_URL || 'http://localhost:3000').replace(/\/$/, ''),
        agentId:    process.env.SAG_AGENT_ID || 'default-agent',
        logFile:    process.env.SAG_LOG_FILE || '.sag-observations.jsonl',
        failOpen:   process.env.SAG_FAIL_OPEN !== 'false',
        debug:      process.env.SAG_DEBUG === 'true',
        isLearn:    mode === MODE_LEARN,
        isEnforce:  mode === MODE_ENFORCE,
    };
}

module.exports = loadConfig();
