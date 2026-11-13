'use strict';

const { report } = require('./reporter');

// Maps OpenAI method paths to SAG tool names
const METHODS = [
    { path: ['chat', 'completions'],  method: 'create', tool: 'openai.chat.completions.create' },
    { path: ['chat', 'completions'],  method: 'stream', tool: 'openai.chat.completions.stream' },
    { path: ['completions'],          method: 'create', tool: 'openai.completions.create' },
    { path: ['embeddings'],           method: 'create', tool: 'openai.embeddings.create' },
    { path: ['images'],               method: 'generate', tool: 'openai.images.generate' },
    { path: ['images'],               method: 'edit',     tool: 'openai.images.edit' },
    { path: ['audio', 'transcriptions'], method: 'create', tool: 'openai.audio.transcriptions.create' },
    { path: ['beta', 'threads', 'runs'], method: 'create', tool: 'openai.beta.threads.runs.create' },
    { path: ['beta', 'threads', 'runs'], method: 'createAndPoll', tool: 'openai.beta.threads.runs.createAndPoll' },
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

// Patch all known methods on an OpenAI instance
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

// Patch the OpenAI class so every new instance is auto-patched
function patchOpenAI(OpenAIModule) {
    const Cls = OpenAIModule?.default || OpenAIModule;
    if (!Cls || typeof Cls !== 'function') return;
    if (Cls.__sag_patched) return;

    const OriginalConstructor = Cls;

    // We wrap the constructor to patch each instance after creation
    function PatchedOpenAI(...args) {
        const instance = new OriginalConstructor(...args);
        patchInstance(instance);
        return instance;
    }

    // Copy static properties
    Object.setPrototypeOf(PatchedOpenAI, OriginalConstructor);
    Object.assign(PatchedOpenAI, OriginalConstructor);
    PatchedOpenAI.prototype = OriginalConstructor.prototype;
    PatchedOpenAI.__sag_patched = true;

    if (OpenAIModule?.default) {
        OpenAIModule.default = PatchedOpenAI;
    }

    return PatchedOpenAI;
}

module.exports = { patchOpenAI };
