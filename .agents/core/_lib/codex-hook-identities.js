/** Toolkit change metadata; these fingerprints are not Codex native trust hashes. */
'use strict';

const { createHash } = require('crypto');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
    throw new Error('codex-hook-identities: definition must contain only JSON values');
};
const hash = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');

function logicalCommand(handler) {
    const command = handler.command;
    if (handler.type !== 'command' || typeof command !== 'string' || !command.trim()) throw new Error('codex-hook-identities: expected a command handler');
    // Recognize the toolkit's bounded portable loader before interpreting its
    // script assignment. Assignment text in arbitrary shell data is not code.
    const toolkit = /^node(?:\.exe)?\s+-e\s+"try\{const fs=require\('fs'\),p=require\('path'\);/.test(command)
        && command.endsWith('}"')
        && command.includes("p.join(d,'.agents','adapters','codex','hooks.js')")
        && command.includes('process.exitCode=require(f).main();break;');
    const scripts = toolkit ? [...command.matchAll(/process\.argv\[2\]\s*=\s*(['"])([^'"\r\n]+)\1/g)].map(match => match[2]) : [];
    if (scripts.length > 1) throw new Error('codex-hook-identities: ambiguous toolkit script identity');
    // Unrecognized launchers use their exact portable command. Command edits
    // then replace identity; no shell parsing or positional matching is implied.
    return scripts.length ? { script: scripts[0] } : { command };
}

function validate(metadata) {
    if (!object(metadata) || metadata.schemaVersion !== 1 || !Array.isArray(metadata.handlers)) throw new Error('codex-hook-identities: malformed prior metadata');
    const ids = new Set();
    const positions = new Set();
    for (const handler of metadata.handlers) {
        if (!object(handler) || typeof handler.id !== 'string' || !handler.id || !/^sha256:[a-f0-9]{64}$/.test(handler.fingerprint)
            || typeof handler.event !== 'string' || !handler.event || typeof handler.matcher !== 'string' || !object(handler.position)
            || !Number.isSafeInteger(handler.position.group) || handler.position.group < 0 || !Number.isSafeInteger(handler.position.handler) || handler.position.handler < 0) {
            throw new Error('codex-hook-identities: malformed prior handler metadata');
        }
        if (ids.has(handler.id)) throw new Error(`codex-hook-identities: duplicate identity ${handler.id}`);
        ids.add(handler.id);
        const position = canonical([handler.event, handler.position.group, handler.position.handler]);
        if (positions.has(position)) throw new Error('codex-hook-identities: duplicate native position');
        positions.add(position);
    }
    return metadata;
}

function hookIdentities(config) {
    if (!object(config) || !object(config.hooks)) throw new Error('codex-hook-identities: expected hooks configuration');
    const handlers = [];
    for (const [event, groups] of Object.entries(config.hooks)) {
        if (!Array.isArray(groups)) throw new Error(`codex-hook-identities: invalid groups for ${event}`);
        groups.forEach((group, groupIndex) => {
            if (!object(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== 'string')) throw new Error(`codex-hook-identities: invalid group for ${event}`);
            const matcher = group.matcher ?? '';
            const definition = { ...group };
            delete definition.hooks;
            group.hooks.forEach((handler, handlerIndex) => {
                if (!object(handler)) throw new Error('codex-hook-identities: invalid handler');
                const identity = { event, matcher, ...logicalCommand(handler) };
                handlers.push({
                    id: 'codex-hook:' + hash(identity).slice(7),
                    fingerprint: hash({ event, group: definition, handler }),
                    event, matcher, position: { group: groupIndex, handler: handlerIndex },
                });
            });
        });
    }
    return validate({ schemaVersion: 1, handlers });
}

function changedTrustHandlers(previous, next) {
    validate(next);
    if (previous === null || previous === undefined) return 0;
    validate(previous);
    const before = new Map(previous.handlers.map(handler => [handler.id, handler]));
    return next.handlers.filter(handler => {
        const old = before.get(handler.id);
        return !old || old.fingerprint !== handler.fingerprint || old.event !== handler.event
            || old.position.group !== handler.position.group || old.position.handler !== handler.position.handler;
    }).length;
}

module.exports = { hookIdentities, changedTrustHandlers };
