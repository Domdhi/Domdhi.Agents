#!/usr/bin/env node
'use strict';

// Completion-sourced dispatch telemetry. Child content is local, bounded data;
// it is never executed, read as a path, or promoted into curated memory.
const fs = require('fs');
const path = require('path');
const { appendJsonl } = require('../core/_lib/jsonl-writer');
const { getJsonlPath } = require('../core/_lib/telemetry-paths');
const { assertNoSymlinkedAncestor } = require('../core/_lib/fs-safe');
const { resolveProjectRoot, resolveWorktreeRoot } = require('../core/_lib/project-root');
const { parseFrontmatter } = require('../core/_lib/frontmatter');

function configuredSkills(agentType, sourceRoot) {
    for (const directory of ['.agents/roles', '.claude/agents']) {
        const file = path.join(sourceRoot, directory, `${agentType}.md`);
        try {
            if (fs.statSync(file).size > 65536) return { skills: [], skills_truncated: true };
            const value = parseFrontmatter(fs.readFileSync(file, 'utf8'), { listFields: ['skills'] })?.skills;
            const declared = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
            const skills = declared.filter(s => typeof s === 'string' && s.length <= 128).slice(0, 32);
            return { skills, skills_truncated: skills.length !== declared.length };
        } catch (error) {
            if (error.code !== 'ENOENT') return { skills: [], skills_truncated: false };
        }
    }
    return { skills: [], skills_truncated: false };
}

function processEvent(input, projectRoot = resolveProjectRoot(path.resolve(__dirname, '..', '..')), sourceRoot = projectRoot) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || input.hook_event_name !== 'SubagentStop'
        || typeof input.agent_type !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(input.agent_type)
        || typeof input.agent_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.agent_id)
        || (input.last_assistant_message !== null && typeof input.last_assistant_message !== 'string')) return null;

    const lastMessage = input.last_assistant_message;
    const event = {
        timestamp: new Date().toISOString(), type: 'agent_dispatch',
        hook_event_name: 'SubagentStop', agent: input.agent_type,
        agent_type: input.agent_type, agent_id: input.agent_id,
        ...configuredSkills(input.agent_type, sourceRoot), description: null,
        last_assistant_message: lastMessage === null ? null : lastMessage.slice(0, 4096),
        message_truncated: lastMessage !== null && lastMessage.length > 4096,
    };
    const destination = getJsonlPath(projectRoot, 'skill-usage.jsonl');
    assertNoSymlinkedAncestor(destination, projectRoot);
    if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Refusing symlinked telemetry file');
    let failure;
    appendJsonl(destination, event, { maxLines: 2000, tailKeep: 1000, onError: message => { failure = message; } });
    if (failure) throw new Error('Subagent completion telemetry could not be written');
    const summary = JSON.stringify({ agent_type: input.agent_type, last_assistant_message: lastMessage === null ? null : lastMessage.slice(0, 256) });
    return { systemMessage: `Subagent completion (untrusted child data; message excerpt at most 256 characters): ${summary}. Review drafts in docs/.output/.state/memory-inbox before the wave commit; promote or discard them through the memory helper.` };
}

// Unlike the generic hook reader, this entry point caps bytes as well as time.
function readInput(stream = process.stdin) {
    return new Promise(resolve => {
        let chunks = [], bytes = 0, timer;
        const finish = value => {
            clearTimeout(timer);
            stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onError);
            stream.pause(); chunks = [];
            resolve(value);
        };
        const onData = chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 65536) finish(''); else chunks.push(buffer);
        };
        const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
        const onError = () => finish('');
        if (stream.isTTY) return resolve('');
        timer = setTimeout(() => finish(''), 1000);
        stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError);
    });
}

async function main() {
    const input = await readInput();
    let data;
    try { data = JSON.parse(input); } catch { return; }
    try {
        const fallback = path.resolve(__dirname, '..', '..');
        const reminder = processEvent(data, resolveProjectRoot(fallback), resolveWorktreeRoot(fallback));
        if (reminder) process.stdout.write(JSON.stringify(reminder) + '\n');
    } catch {
        process.stdout.write(JSON.stringify({ systemMessage: 'Subagent completion telemetry could not be recorded; review local telemetry and the memory inbox.' }) + '\n');
    }
}
if (require.main === module) main().then(() => process.exit(0), () => process.exit(0));
module.exports = { processEvent, readInput };
