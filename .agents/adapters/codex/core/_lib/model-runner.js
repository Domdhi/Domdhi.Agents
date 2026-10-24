'use strict';

// Memory prompts contain untrusted historical text. Optional inference requires
// a provable no-tools backend; read-only sandboxing does not provide that boundary.
const policy = require('../../../../core/_lib/model-policy');
const DEFAULT_TIMEOUT_MS = 90_000;
const EVENT_FAILURE = 'Codex memory invocation failed';
const INFERENCE_UNAVAILABLE = 'Codex memory inference disabled: no supported, verified tool-free invocation is available; use session handoff or explicit curated-memory helpers.';

function defaultModel() { return process.env.CODEX_MEMORY_MODEL || null; }

function checkCodexCli() {
    // This compatibility probe reports memory-backend availability, rather than
    // executable presence. Do not launch even a version probe on the refusal path.
    policy.writeFailure('model-runner', INFERENCE_UNAVAILABLE);
    return false;
}

function parseExecEvents(raw) {
    try {
        let pending = null;
        let result = null;
        let usage = {};
        let completed = false;
        let turnOpen = false;
        for (const line of String(raw).split(/\r?\n/).filter(line => line.trim())) {
            const event = JSON.parse(line);
            if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
                throw new Error(EVENT_FAILURE);
            }
            if (event.type === 'error' || event.type === 'turn.failed') throw new Error(EVENT_FAILURE);
            if (!['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed'].includes(event.type)) {
                throw new Error(EVENT_FAILURE);
            }
            if (event.type === 'turn.started') {
                if (turnOpen) throw new Error(EVENT_FAILURE);
                turnOpen = true;
            }
            if (event.type.startsWith('item.')) {
                if (!event.item || typeof event.item !== 'object' || Array.isArray(event.item) || typeof event.item.type !== 'string') {
                    throw new Error(EVENT_FAILURE);
                }
                // Defense in depth for supplied event streams: reject every
                // command/MCP/tool item at any stage. Parsing happens after tool
                // execution and cannot prevent its effects; invocation stays disabled.
                if (!['agent_message', 'reasoning'].includes(event.item.type)) throw new Error(EVENT_FAILURE);
                turnOpen = true;
                if (event.type === 'item.completed' && event.item.type === 'agent_message') {
                    if (typeof event.item.text !== 'string' || !event.item.text.trim()) throw new Error(EVENT_FAILURE);
                    pending = event.item.text;
                    turnOpen = true;
                }
            }
            if (event.type === 'turn.completed') {
                if (pending === null) throw new Error(EVENT_FAILURE);
                result = pending;
                pending = null;
                usage = event.usage || {};
                completed = true;
                turnOpen = false;
            }
        }
        // A completed earlier turn cannot bless a later uncompleted message.
        if (!completed || turnOpen || pending !== null || result === null) throw new Error(EVENT_FAILURE);
        return JSON.stringify({ result, usage });
    } catch { throw new Error(EVENT_FAILURE); }
}

function invokeModel(prompt, { model = defaultModel(), logTag = 'model-runner' } = {}) {
    if (!policy.validateModel(model, { allowNull: true })) {
        policy.writeFailure(logTag, 'refusing unsafe model id');
        return null;
    }
    // Fail before submitting any untrusted prompt to a tool-capable process.
    // Keep the diagnostic even for historical callers that suppress generic logs.
    policy.writeFailure(logTag || 'model-runner', INFERENCE_UNAVAILABLE);
    return null;
}

function parseModelResult(raw) { return policy.parseModelResult(raw, { allowRaw: true }); }

module.exports = {
    checkCli: checkCodexCli,
    checkCodexCli, invokeModel, parseExecEvents, parseModelResult,
    tryParseInnerJson: policy.tryParseInnerJson,
    extractTokenCounts: policy.extractTokenCounts,
    get DEFAULT_MODEL() { return defaultModel(); },
    DEFAULT_TIMEOUT_MS,
};
