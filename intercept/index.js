'use strict';

/**
 * sag-intercept
 *
 * Drop-in AI SDK interceptor. Add one line to the top of your entry file:
 *
 *   require('sag-intercept')          // CommonJS
 *   import 'sag-intercept'            // ESM (via loader)
 *
 * Env vars:
 *   SAG_MODE         learn | enforce  (default: learn)
 *   SAG_API_KEY      required in enforce mode
 *   SAG_GATEWAY_URL  default: http://localhost:3000
 *   SAG_AGENT_ID     default: default-agent
 *   SAG_LOG_FILE     default: .sag-observations.jsonl
 *   SAG_FAIL_OPEN    true | false     (default: true)
 *   SAG_DEBUG        true | false     (default: false)
 */

const Module = require('module');
const cfg    = require('./lib/config');

const { patchOpenAI }    = require('./lib/patch-openai');
const { patchAnthropic } = require('./lib/patch-anthropic');
const { patchLangChain } = require('./lib/patch-langchain');

// SDK package names we watch for
const WATCHED = {
    'openai':                    patchOpenAI,
    '@anthropic-ai/sdk':         patchAnthropic,
    'anthropic':                 patchAnthropic,
    '@langchain/core':           patchLangChain,
    '@langchain/core/language_models/chat_models': patchLangChain,
    'langchain':                 patchLangChain,
    'langchain/chat_models':     patchLangChain,
};

// Patch any SDK already in require.cache before we loaded
function patchAlreadyLoaded() {
    for (const [pkg, patcher] of Object.entries(WATCHED)) {
        try {
            const resolved = require.resolve(pkg);
            if (require.cache[resolved]) {
                patcher(require.cache[resolved].exports);
            }
        } catch (_) {
            // package not installed — skip
        }
    }
}

// Hook Node's module loader to patch SDKs the moment they're required
function hookRequire() {
    const originalLoad = Module._load;

    Module._load = function (request, parent, isMain) {
        const exports = originalLoad.apply(this, arguments);

        if (WATCHED[request]) {
            WATCHED[request](exports);
        }

        return exports;
    };
}

function init() {
    const mode = cfg.isLearn ? 'LEARN' : 'ENFORCE';
    console.log(`[sag-intercept] Active — mode: ${mode} | agent: ${cfg.agentId} | gateway: ${cfg.gatewayUrl}`);

    if (cfg.isLearn) {
        console.log(`[sag-intercept] Observations will be written to: ${cfg.logFile}`);
    }

    patchAlreadyLoaded();
    hookRequire();
}

init();

module.exports = { cfg };
