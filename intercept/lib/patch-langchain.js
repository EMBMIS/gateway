'use strict';

const { report } = require('./reporter');

// LangChain uses a BaseLanguageModel with an _generate / invoke / call pattern.
// We patch at the class prototype level so all LLM subclasses are covered.

function wrapLangChainMethod(proto, method, toolPrefix) {
    const original = proto[method];
    if (typeof original !== 'function' || original.__sag_patched) return;

    proto[method] = async function (...args) {
        const modelName = this.modelName || this.model || 'unknown';
        const toolName  = `${toolPrefix}.${method}`;
        const callArgs  = { model: modelName, input: args[0] };

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

function patchLangChainClass(Cls, toolPrefix) {
    if (!Cls?.prototype || Cls.__sag_patched) return;
    for (const method of ['invoke', 'call', '_generate', 'predict', 'stream', 'batch']) {
        if (typeof Cls.prototype[method] === 'function') {
            wrapLangChainMethod(Cls.prototype, method, toolPrefix);
        }
    }
    Cls.__sag_patched = true;
}

function patchLangChain(LangChainModule) {
    if (!LangChainModule) return;

    // @langchain/core — BaseChatModel, BaseLLM
    if (LangChainModule.BaseChatModel) {
        patchLangChainClass(LangChainModule.BaseChatModel, 'langchain.chat');
    }
    if (LangChainModule.BaseLLM) {
        patchLangChainClass(LangChainModule.BaseLLM, 'langchain.llm');
    }

    // langchain/chat_models — ChatOpenAI, ChatAnthropic, etc.
    if (LangChainModule.ChatOpenAI) {
        patchLangChainClass(LangChainModule.ChatOpenAI, 'langchain.chat.openai');
    }
    if (LangChainModule.ChatAnthropic) {
        patchLangChainClass(LangChainModule.ChatAnthropic, 'langchain.chat.anthropic');
    }
}

module.exports = { patchLangChain };
