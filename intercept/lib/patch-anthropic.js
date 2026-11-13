'use strict';

const { report } = require('./reporter');

const METHODS = [
    { path: ['messages'],             method: 'create',  tool: 'anthropic.messages.create' },
    { path: ['messages'],             method: 'stream',  tool: 'anthropic.messages.stream' },
    { path: ['messages'],             method: 'countTokens', tool: 'anthropic.messages.countTokens' },
    { path: ['beta', 'messages'],     method: 'create',  tool: 'anthropic.beta.messages.create' },
    { path: ['beta', 'promptCaching', 'messages'], method: 'create', tool: 'anthropic.beta.promptCaching.messages.create' },
];

function wrapMethod(proto, method, toolName) {
    const original = proto[method];
    if (typeof original !== 'function' || original.__sag_patched) return;

    proto[method] = async function (...args) {
        const callArgs = args[0] || {};
        const decision = await report(toolName, callArgs);

        if (decision.blocked) {
            const err = new Error(`[SAG] Blocked: ${toolName} — ${decision.data?.reason || 'policy denied'}`);
            err.code = 'SAG_BLOCKED';
            err.sagDecision = decision;
            throw err;
        }

        return original.apply(this, args);
    };

    proto[method].__sag_patched = true;
}

function navigatePath(obj, parts) {
    let cur = obj;
    for (const part of parts) {
        if (!cur || typeof cur !== 'object') return null;
        cur = cur[part];
    }
    return cur;
}

function patchInstance(instance) {
    if (!instance || instance.__sag_patched) return;
    for (const { path, method, tool } of METHODS) {
        const target = navigatePath(instance, path);
        if (target && typeof target[method] === 'function') {
            wrapMethod(target, method, tool);
        }
    }
    instance.__sag_patched = true;
}

function patchAnthropic(AnthropicModule) {
    const Cls = AnthropicModule?.default || AnthropicModule;
    if (!Cls || typeof Cls !== 'function') return;
    if (Cls.__sag_patched) return;

    const OriginalConstructor = Cls;

    function PatchedAnthropic(...args) {
        const instance = new OriginalConstructor(...args);
        patchInstance(instance);
        return instance;
    }

    Object.setPrototypeOf(PatchedAnthropic, OriginalConstructor);
    Object.assign(PatchedAnthropic, OriginalConstructor);
    PatchedAnthropic.prototype = OriginalConstructor.prototype;
    PatchedAnthropic.__sag_patched = true;

    if (AnthropicModule?.default) {
        AnthropicModule.default = PatchedAnthropic;
    }

    return PatchedAnthropic;
}

module.exports = { patchAnthropic };
