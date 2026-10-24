'use strict';

// The core composes local authority, leaf persistence, scanning and bounded transport.
// Importing this module performs no capture, authentication or external operation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const store = require('./_lib/learning-intake-store');
const { resolveRuntimeContext } = require('./runtime-context');
const { createGithubTransport, buildIssuePayload } = require('./learning-intake-github');
const { scanContent } = require('../hooks/secret-patterns.cjs');
const { LEARNING_INTAKE_LIMITS: CEILINGS } = require('./constants');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TRIGGERS = ['end', 'do', 'run-todo', 'run-tests', 'todo', 'review-feedback'];
const CODES = new Set(['not-initialized', 'disabled', 'invalid-input', 'unsupported-version', 'identity-mismatch',
    'scope-mismatch', 'not-authorized', 'protected-export', 'not-transferable', 'budget-exhausted', 'auth-unavailable',
    'access-denied', 'destination-unavailable', 'throttled', 'network-unavailable', 'write-uncertain', 'receipt-mismatch',
    'reconciliation-inconclusive', 'invalid-resolution', 'corrupt-history', 'lock-held', 'persistence-failed']);
const LESSON_KEYS = ['toolkitVersion', 'component', 'applicability', 'title', 'problem', 'expected',
    'reproduction', 'verification', 'references', 'exportApproved'];

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function check(condition, code = 'invalid-input') { if (!condition) fail(code); }
function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function safeCode(error, fallback = 'persistence-failed') {
    const code = own(error, 'code'); return CODES.has(code) ? code : fallback;
}
function strict(value, required, optional = [], limit = CEILINGS.MAX_RECORD_BYTES) {
    store.canonicalHash(value); // Reject accessors, prototype keys, cycles and unsupported JSON.
    check(value && typeof value === 'object' && !Array.isArray(value));
    check(Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key)));
    check(Buffer.byteLength(JSON.stringify(value)) <= limit);
    return JSON.parse(JSON.stringify(value));
}
function scan(value) {
    try {
        const found = scanContent(JSON.stringify(value));
        check(Array.isArray(found) && found.length === 0, 'protected-export');
    } catch (error) { fail('protected-export'); }
}
function uuid(value) { check(typeof value === 'string' && UUID.test(value)); }
function at(options) {
    const value = options.clock ? options.clock() : new Date().toISOString();
    check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
    check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value); return value;
}
function id(options) { const value = options.newId ? options.newId() : crypto.randomUUID(); uuid(value); return value; }
function context(options = {}) {
    check(options && typeof options === 'object' && !Array.isArray(options));
    let runtimeContext;
    if (options.projectRoot === undefined) runtimeContext = resolveRuntimeContext();
    const projectRoot = options.projectRoot === undefined ? runtimeContext.projectRoot : options.projectRoot;
    const stateRoot = options.stateRoot === undefined ? (runtimeContext ? runtimeContext.sharedStateRoot : projectRoot) : options.stateRoot;
    check(typeof projectRoot === 'string' && path.isAbsolute(projectRoot));
    check(typeof stateRoot === 'string' && path.isAbsolute(stateRoot));
    const runtime = options.runtime === undefined ? process.env.AGENTS_RUNTIME || process.env.AGENT_RUNTIME ||
        (process.env.CODEX_PROJECT_DIR ? 'codex' : 'claude') : options.runtime;
    check(['codex', 'claude'].includes(runtime));
    check(options.clock === undefined || typeof options.clock === 'function');
    check(options.newId === undefined || typeof options.newId === 'function');
    return { ...options, projectRoot: path.resolve(projectRoot), stateRoot: path.resolve(stateRoot), runtime };
}
function result(ok, code, status, extra = {}) { return { ok, code, status, ...extra }; }
function rejected(error, requestId, extra = {}) {
    const code = safeCode(error);
    return result(false, code, extra.status || 'held', { ...(typeof requestId === 'string' && UUID.test(requestId) ? { requestId } : {}), ...extra });
}

// Read only validated event data. A missing envelope never erases historical evidence.
function stateOf(history) {
    let intent; let receipt; let resolution; let remoteState; let stale = false; let active;
    let retry; const grants = []; const consumed = new Set(); let attempts = 0;
    for (const event of history.events) {
        switch (event.kind) {
            case 'attempt-started': active = event; break;
            case 'create-intent': intent = event; attempts++; active = undefined; if (event.data.recoveryEventId) consumed.add(event.data.recoveryEventId); break;
            case 'acknowledged': case 'reconciled': receipt = event.data.receipt; retry = undefined; active = undefined; break;
            case 'retryable': retry = event; active = undefined; break;
            case 'blocked': if (event.data.operation === 'refresh' && receipt) stale = true; active = undefined; break;
            case 'resolution-observed': resolution = event.data.resolution; remoteState = event.data.remoteState; stale = false; retry = undefined; active = undefined; break;
            case 'refresh-observed': remoteState = event.data.remoteState; stale = resolution !== undefined; retry = undefined; active = undefined; break;
            case 'refresh-failed': retry = event; stale = true; active = undefined; break;
            case 'recovery-approved': if (event.data.decision === 'retry-create') grants.push(event); break;
            default: break;
        }
    }
    if (active?.data.operation === 'refresh') stale = true;
    const grant = grants.filter((event) => !consumed.has(event.eventId) && event.data.intentEventId === intent?.eventId).at(-1);
    return { intent, receipt, resolution, remoteState, stale, active, retry, grant, attempts };
}
function summary(row, history) {
    const state = stateOf(history);
    const request = row.request;
    const value = { requestId: request.requestId, projectId: request.projectId, projectName: request.projectName,
        createdAt: request.createdAt, toolkitVersion: request.toolkitVersion, runtime: request.runtime, component: request.component,
        applicability: request.applicability, fingerprint: request.fingerprint, status: history.status, sourcePath: row.path,
        ...(state.receipt ? { issue: state.receipt } : {}), ...(state.resolution ? { resolution: state.resolution } : {}),
        ...(state.remoteState === undefined ? {} : { remoteState: state.remoteState }), stale: state.stale };
    scan(value); return value;
}
function append(session, kind, data) {
    const added = store.appendEvent(session.request.requestId, kind, data, { ...session.options, lockOwner: session.owner,
        expectedLastEventHash: session.history.lastEventHash });
    session.history = store.readEvents(session.request.requestId, session.options);
    return added.event;
}
async function locked(requestId, operation, options, action) {
    try {
        uuid(requestId); options = context(options);
        return await store.withRequestLock(requestId, async (owner) => {
            const row = store.loadRequest(requestId, options);
            const history = store.readEvents(requestId, options);
            const session = { options, owner, ...row, history };
            return action(session);
        }, { ...options, operation });
    } catch (error) { return rejected(error, typeof requestId === 'string' && UUID.test(requestId) ? requestId : undefined); }
}
function block(session, code, operation) {
    append(session, 'blocked', { code, operation });
    return result(false, code, session.history.status, { requestId: session.request.requestId });
}
function authority(session, operation, historical) {
    const policy = store.loadPolicy(session.options);
    scan(policy);
    check(policy.enabled, 'disabled'); check(policy.operations.includes(operation), 'not-authorized');
    if (Object.hasOwn(session.options, 'trigger')) {
        check(TRIGGERS.includes(session.options.trigger));
        check(policy.triggers.includes(session.options.trigger), 'not-authorized');
    }
    if (historical) check(store.canonicalHash(policy.destination) === store.canonicalHash(historical), 'scope-mismatch');
    return policy;
}
function exportable(session, policy) {
    check(session.request.applicability === 'shared-toolkit', 'not-transferable');
    check(session.request.exportApproved === true, 'protected-export');
    scan(session.request);
    const limits = policy.limits;
    check(Buffer.byteLength(JSON.stringify(session.request)) <= limits.MAX_RECORD_BYTES, 'protected-export');
    check(session.request.references.length <= limits.MAX_REFERENCES, 'protected-export');
    for (const field of ['title', 'problem', 'expected', 'proposed', 'reproduction', 'verification']) {
        if (session.request[field] !== undefined) check(Buffer.byteLength(session.request[field]) <= limits.MAX_FIELD_BYTES, 'protected-export');
    }
    // Use the adapter's actual escaped GitHub payload, including its final JSON
    // serialization, so authority cannot approve a smaller hypothetical body.
    buildIssuePayload(session.request, session.requestHash, limits);
}
function validateBindings(session, policy, destination, grant) {
    const fresh = store.loadRequest(session.request.requestId, session.options);
    check(fresh.requestHash === session.requestHash, 'corrupt-history');
    const current = authority(session, 'submit', destination);
    check(store.canonicalHash(store.policyScope(current)) === store.canonicalHash(store.policyScope(policy)), 'scope-mismatch');
    exportable(session, current);
    if (grant) {
        const state = stateOf(session.history);
        check(state.grant && state.grant.eventId === grant.eventId && grant.data.intentEventId === state.intent?.eventId, 'scope-mismatch');
        check(grant.data.requestHash === session.requestHash && grant.data.destinationHash === store.canonicalHash(destination) &&
            store.canonicalHash(grant.data.destination) === store.canonicalHash(destination) &&
            grant.data.policyHash === store.canonicalHash(store.policyScope(current)) && grant.data.exportProfile === current.exportProfile, 'scope-mismatch');
    }
    check(stateOf(session.history).attempts < current.limits.MAX_CREATE_ATTEMPTS, 'budget-exhausted');
    return current;
}
function transportFor(options, policy) {
    const remote = options.transport === undefined ? createGithubTransport({ limits: policy.limits }) : options.transport;
    check(remote && typeof remote === 'object' && ['validateDestination', 'findByMarker', 'create', 'show'].every((method) => typeof remote[method] === 'function'));
    return remote;
}
async function invoke(remote, method, input, session, policy) {
    session.externalAttempted = false;
    const destination = method === 'validateDestination' ? input : input.destination;
    let guardObserved = false; let methodEntered = false;
    function validateDispatch() {
        session.externalAttempted = false;
        const current = authority(session, session.owner.operation, destination);
        check(store.canonicalHash(store.policyScope(current)) === store.canonicalHash(store.policyScope(policy)), 'scope-mismatch');
        const fresh = store.loadRequest(session.request.requestId, session.options);
        check(fresh.requestHash === session.requestHash, 'corrupt-history');
        const history = store.readEvents(session.request.requestId, session.options);
        check(history.lastEventHash === session.history.lastEventHash, 'corrupt-history');
        exportable(session, current);
        if (session.owner.operation === 'submit') {
            const state = stateOf(history);
            if (method === 'create') {
                check(state.intent && state.intent.data.requestHash === session.requestHash
                    && state.intent.data.destinationHash === store.canonicalHash(destination)
                    && state.intent.data.policyHash === store.canonicalHash(store.policyScope(current)), 'scope-mismatch');
                // The current intent already consumes one cumulative attempt.
                check(state.attempts <= current.limits.MAX_CREATE_ATTEMPTS, 'budget-exhausted');
            } else check(state.attempts < current.limits.MAX_CREATE_ATTEMPTS, 'budget-exhausted');
        }
    }
    function beforeDispatch() {
        guardObserved = true;
        validateDispatch();
        session.externalAttempted = true;
    }
    function dispatch() {
        validateDispatch();
        methodEntered = true;
        return remote[method](input, beforeDispatch);
    }
    // Production adapter owns token/HTTP deadlines and awaited process/stream closure.
    // Never race it against a shorter core timer that could leave owned I/O running.
    if (session.options.transport === undefined) return dispatch();
    // Explicitly injected transports are trusted caller-owned seams. Their own
    // cancellation/lifetime remains the injector's responsibility, not native proof.
    return new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                if (methodEntered && !guardObserved) session.externalAttempted = true;
                reject(Object.assign(new Error('network-unavailable'), { code: 'network-unavailable' }));
            }
        }, policy.limits.OPERATION_TIMEOUT_MS);
        Promise.resolve().then(dispatch).then((value) => {
            if (methodEntered && !guardObserved) session.externalAttempted = true;
            if (!finished) { finished = true; clearTimeout(timer); resolve(value); }
        }, (error) => {
            if (methodEntered && !guardObserved) session.externalAttempted = true;
            if (!finished) { finished = true; clearTimeout(timer); reject(error); }
        });
    });
}
function finishInterrupted(session) {
    const active = stateOf(session.history).active;
    if (!active) return;
    if (active.data.operation === 'refresh') append(session, 'refresh-failed', { code: 'network-unavailable' });
    else append(session, 'retryable', { attemptId: active.data.attemptId, code: 'network-unavailable' });
}
function begin(session, operation, policy) {
    finishInterrupted(session);
    const attemptId = id(session.options);
    append(session, 'attempt-started', { attemptId, operation, policyHash: store.canonicalHash(store.policyScope(policy)) });
    return attemptId;
}
function delayOf(error, options) {
    const value = own(error, 'nextAttemptAt');
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
    const ms = Date.parse(value); const now = Date.parse(at(options));
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value || ms < now || ms > now + 86400000) return undefined;
    return value;
}
function ensureRetryReady(session, state) {
    if (state.retry?.data.nextAttemptAt) {
        check(Date.parse(at(session.options)) >= Date.parse(state.retry.data.nextAttemptAt), 'throttled');
    }
}
function recordFailure(session, error, attemptId, possiblePost) {
    let code = safeCode(error, possiblePost ? 'write-uncertain' : 'network-unavailable');
    if (possiblePost && !(store.isKnownCreateRejection(code) && own(error, 'possibleWrite') === false)) {
        code = 'write-uncertain'; append(session, 'uncertain', { attemptId, code });
    } else {
        const nextAttemptAt = code === 'throttled' ? delayOf(error, session.options) : undefined;
        append(session, 'retryable', { attemptId, code, ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) });
    }
    return result(false, code, session.history.status, { requestId: session.request.requestId });
}
function receiptOf(value, session, destination) {
    const received = store.validateReceipt(value, { requestId: session.request.requestId, requestHash: session.requestHash, destination });
    scan(received); return received;
}
function lookup(value, session, destination, limits) {
    const response = strict(value, ['matches', 'inconclusive'], ['observedEmpty'], limits.MAX_RESPONSE_BYTES);
    check(Array.isArray(response.matches) && response.matches.length <= limits.MAX_RECONCILIATION_MATCHES && typeof response.inconclusive === 'boolean', 'reconciliation-inconclusive');
    if (Object.hasOwn(response, 'observedEmpty')) check(typeof response.observedEmpty === 'boolean', 'reconciliation-inconclusive');
    if (response.matches.length === 1 && response.inconclusive === false && response.observedEmpty !== true) {
        return { receipt: receiptOf(response.matches[0], session, destination) };
    }
    if (response.matches.length === 0 && response.inconclusive === true && response.observedEmpty === true) return { observedEmpty: true };
    fail('reconciliation-inconclusive');
}

async function initProject(options) {
    try {
        options = context(options);
        if (options.projectName !== undefined) scan({ projectName: options.projectName });
        const initialized = store.initializeProject(options);
        return result(true, 'ok', initialized.initialized ? 'initialized' : 'already-initialized');
    } catch (error) { return rejected(error); }
}
async function init(input, options) {
    try { input = strict(input, [], ['projectName']); return await initProject({ ...options, ...input }); }
    catch (error) { return rejected(error); }
}
async function capture(input, options) {
    try {
        options = context(options); const identity = store.loadIdentity(options);
        input = strict(input, LESSON_KEYS, ['toolkitCommit', 'proposed']);
        const draft = store.validateRequest({ ...input, schemaVersion: 1, requestId: id(options), projectId: identity.projectId,
            projectName: identity.projectName, createdAt: at(options), runtime: options.runtime, fingerprint: '0'.repeat(64) });
        const selected = Object.fromEntries([...LESSON_KEYS, 'toolkitCommit', 'proposed'].filter((key) => Object.hasOwn(draft, key)).map((key) => [key, draft[key]]));
        draft.fingerprint = store.canonicalHash(selected); scan(draft);
        const row = await store.publishRequest(draft, options);
        await store.withRequestLock(draft.requestId, (owner) => {
            store.appendEvent(draft.requestId, 'captured', { requestHash: row.requestHash }, { ...options, lockOwner: owner, expectedLastEventHash: null });
        }, { ...options, operation: 'capture' });
        const history = store.readEvents(draft.requestId, options);
        return result(true, 'ok', history.status, { requestId: draft.requestId });
    } catch (error) { return rejected(error); }
}
async function status(options) {
    try {
        options = context(options);
        if (options.requestId !== undefined) uuid(options.requestId);
        const rows = options.requestId === undefined ? store.listRequests(options) : [store.loadRequest(options.requestId, options)];
        const requests = rows.map((row) => summary(row, store.readEvents(row.request.requestId, options)));
        const counts = { total: requests.length };
        for (const request of requests) counts[request.status] = (counts[request.status] || 0) + 1;
        check(Buffer.byteLength(JSON.stringify({ requests, counts })) <= CEILINGS.MAX_RESPONSE_BYTES, 'budget-exhausted');
        return result(true, 'ok', 'local', { requests, counts });
    } catch (error) { return rejected(error); }
}
async function submit(requestId, options) {
    return locked(requestId, 'submit', options, async (session) => {
        let policy; let grant;
        try {
            const state = stateOf(session.history);
            // A definitive rejection permits retry, never a new receiver. Bind
            // all retained intents even when no recovery grant is involved.
            policy = authority(session, 'submit', state.intent?.data.destination); exportable(session, policy);
            if (state.receipt) return result(true, 'ok', 'acknowledged', { requestId, issue: state.receipt });
            check(session.history.status !== 'held', 'corrupt-history');
            if (session.history.status === 'uncertain') {
                grant = state.grant;
                // The retained intent already records this hold; a repeated submit
                // must not mutate reviewed recovery history or imply a fresh attempt.
                if (!grant) return result(false, 'write-uncertain', 'uncertain', { requestId });
            }
            if (grant) validateBindings(session, policy, state.intent.data.destination, grant);
            check(state.attempts < policy.limits.MAX_CREATE_ATTEMPTS, 'budget-exhausted');
            ensureRetryReady(session, state);
        } catch (error) { return block(session, safeCode(error), 'submit'); }
        const attemptId = begin(session, 'submit', policy);
        const destination = policy.destination;
        let remote; let found;
        try {
            remote = transportFor(session.options, policy);
            const checked = await invoke(remote, 'validateDestination', destination, session, policy);
            strict(checked, ['provider', 'owner', 'repository', 'maintainerIds']);
            check(store.canonicalHash(store.validateDestination(checked)) === store.canonicalHash(destination), 'destination-unavailable');
            found = lookup(await invoke(remote, 'findByMarker', { destination, marker: `${store.MARKER_PREFIX}${requestId}`,
                requestHash: session.requestHash, projectId: session.request.projectId }, session, policy), session, destination, policy.limits);
            validateBindings(session, policy, destination, grant);
        } catch (error) { return recordFailure(session, error, attemptId, false); }
        // This intention is retained even when adopting an already existing exact item.
        append(session, 'create-intent', { attemptId, requestHash: session.requestHash, destination,
            destinationHash: store.canonicalHash(destination), policyHash: store.canonicalHash(store.policyScope(policy)),
            marker: `${store.MARKER_PREFIX}${requestId}`, ...(grant ? { recoveryEventId: grant.eventId } : {}) });
        if (found.receipt) {
            append(session, 'reconciled', { receipt: found.receipt });
            return result(true, 'ok', 'acknowledged', { requestId, issue: found.receipt });
        }
        let received;
        try {
            received = receiptOf(await invoke(remote, 'create', { destination, request: session.request, requestHash: session.requestHash,
                marker: `${store.MARKER_PREFIX}${requestId}` }, session, policy), session, destination);
        } catch (error) { return recordFailure(session, error, attemptId, session.externalAttempted === true); }
        append(session, 'acknowledged', { receipt: received });
        return result(true, 'ok', 'acknowledged', { requestId, issue: received });
    });
}
async function reconcile(requestId, options) {
    return locked(requestId, 'reconcile', options, async (session) => {
        const state = stateOf(session.history); let policy;
        try {
            check(state.intent, 'reconciliation-inconclusive');
            policy = authority(session, 'reconcile', state.intent.data.destination); exportable(session, policy);
            if (state.receipt) return result(true, 'ok', 'acknowledged', { requestId, issue: state.receipt });
            check(session.history.status === 'uncertain', 'reconciliation-inconclusive');
            ensureRetryReady(session, state);
        } catch (error) { return block(session, safeCode(error), 'reconcile'); }
        const attemptId = begin(session, 'reconcile', policy);
        let found;
        try {
            const remote = transportFor(session.options, policy);
            found = lookup(await invoke(remote, 'findByMarker', { destination: state.intent.data.destination, marker: state.intent.data.marker,
                requestHash: session.requestHash, projectId: session.request.projectId }, session, policy), session, state.intent.data.destination, policy.limits);
            check(found.receipt, 'reconciliation-inconclusive');
            authority(session, 'reconcile', state.intent.data.destination);
        } catch (error) {
            const code = safeCode(error, 'reconciliation-inconclusive');
            return recordFailure(session, { code: code === 'invalid-input' ? 'reconciliation-inconclusive' : code,
                nextAttemptAt: own(error, 'nextAttemptAt') }, attemptId, false);
        }
        append(session, 'reconciled', { receipt: found.receipt });
        return result(true, 'ok', 'acknowledged', { requestId, issue: found.receipt });
    });
}
async function refresh(requestId, options) {
    return locked(requestId, 'refresh', options, async (session) => {
        const state = stateOf(session.history); let policy;
        try {
            check(state.receipt, 'receipt-mismatch'); policy = authority(session, 'refresh', state.receipt.destination); exportable(session, policy);
            ensureRetryReady(session, state);
        }
        catch (error) { return block(session, safeCode(error), 'refresh'); }
        const attemptId = begin(session, 'refresh', policy);
        let observation;
        try {
            const remote = transportFor(session.options, policy);
            observation = strict(await invoke(remote, 'show', { destination: state.receipt.destination, receipt: state.receipt }, session, policy),
                ['receipt', 'remoteState'], ['resolution'], policy.limits.MAX_RESPONSE_BYTES);
            const received = receiptOf(observation.receipt, session, state.receipt.destination);
            check(store.canonicalHash(received) === store.canonicalHash(state.receipt), 'receipt-mismatch');
            check(typeof observation.remoteState === 'string' && observation.remoteState.trim().length > 0 && Buffer.byteLength(observation.remoteState) <= Math.min(128, policy.limits.MAX_FIELD_BYTES) && !/[\u0000-\u001f\u007f]/.test(observation.remoteState), 'invalid-resolution');
            scan({ remoteState: observation.remoteState });
            if (Object.hasOwn(observation, 'resolution')) {
                try { observation.resolution = store.validateResolution(observation.resolution, { requestId }); scan(observation.resolution); }
                catch (error) { fail(safeCode(error, 'invalid-resolution') === 'protected-export' ? 'protected-export' : 'invalid-resolution'); }
            }
            authority(session, 'refresh', state.receipt.destination);
        } catch (error) {
            const observedCode = safeCode(error, 'invalid-resolution');
            const code = ['invalid-input', 'unsupported-version'].includes(observedCode) ? 'invalid-resolution' : observedCode;
            const nextAttemptAt = code === 'throttled' ? delayOf(error, session.options) : undefined;
            append(session, 'refresh-failed', { code, ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }) });
            return result(false, code, 'acknowledged', { requestId, ...(state.resolution ? { resolution: state.resolution } : {}), stale: true });
        }
        if (Object.hasOwn(observation, 'resolution')) append(session, 'resolution-observed', { resolution: observation.resolution, remoteState: observation.remoteState });
        else append(session, 'refresh-observed', { attemptId, remoteState: observation.remoteState });
        const current = stateOf(session.history);
        return result(true, 'ok', 'acknowledged', { requestId, issue: state.receipt, remoteState: observation.remoteState,
            ...(current.resolution ? { resolution: current.resolution } : {}), stale: current.stale });
    });
}

function recoveryInput(value) {
    const input = strict(value, ['schemaVersion', 'intentEventId', 'expectedLastEventHash', 'actor', 'decision', 'reason', 'acceptDuplicateRisk'], ['ownerNonce']);
    check(input.schemaVersion === 1, 'unsupported-version');
    if (input.intentEventId !== null) uuid(input.intentEventId);
    if (input.expectedLastEventHash !== null) check(typeof input.expectedLastEventHash === 'string' && SHA.test(input.expectedLastEventHash));
    check(typeof input.actor === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(input.actor) && Buffer.byteLength(input.actor) <= 128);
    check(typeof input.reason === 'string' && input.reason.trim().length > 0 && Buffer.byteLength(input.reason) <= CEILINGS.MAX_FIELD_BYTES && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.reason));
    check(['retry-create', 'release-lock'].includes(input.decision) && typeof input.acceptDuplicateRisk === 'boolean');
    if (input.decision === 'retry-create') check(input.acceptDuplicateRisk === true && input.intentEventId !== null && input.expectedLastEventHash !== null && !Object.hasOwn(input, 'ownerNonce'));
    else check(input.acceptDuplicateRisk === false && typeof input.ownerNonce === 'string' && /^[0-9a-f]{32}$/.test(input.ownerNonce));
    scan(input); return input;
}
function reviewed(session, input) {
    const state = stateOf(session.history);
    check(input.expectedLastEventHash === session.history.lastEventHash && input.intentEventId === (state.intent ? state.intent.eventId : null), 'corrupt-history');
    return state;
}
async function recover(requestId, input, options) {
    let resolved;
    try { uuid(requestId); resolved = context(options); input = recoveryInput(input); store.loadIdentity(resolved); }
    catch (error) { return rejected(error, requestId); }
    if (input.decision === 'retry-create') return locked(requestId, 'recover', resolved, async (session) => {
        try {
            const state = reviewed(session, input);
            check(state.intent && !state.receipt && session.history.status === 'uncertain', 'corrupt-history');
            const policy = authority(session, 'recover', state.intent.data.destination); exportable(session, policy);
            check(state.attempts < policy.limits.MAX_CREATE_ATTEMPTS, 'budget-exhausted');
            finishInterrupted(session);
            append(session, 'recovery-approved', { intentEventId: input.intentEventId, actor: input.actor, decision: input.decision,
                reason: input.reason, acceptDuplicateRisk: true, requestHash: session.requestHash, destination: state.intent.data.destination,
                destinationHash: state.intent.data.destinationHash, policyHash: store.canonicalHash(store.policyScope(policy)), exportProfile: policy.exportProfile });
            return result(true, 'ok', 'uncertain', { requestId });
        } catch (error) { return rejected(error, requestId, { status: session.history.status }); }
    });
    try {
        return await store.withRecoveryGuard(requestId, async (recoveryOwner) => {
            const owner = store.loadLock(requestId, resolved);
            check(owner && owner.nonce === input.ownerNonce && owner.host === os.hostname() && owner.projectId === store.loadIdentity(resolved).projectId, 'lock-held');
            const session = { options: resolved, owner, ...store.loadRequest(requestId, resolved), history: store.readEvents(requestId, resolved) };
            reviewed(session, input);
            let absent = false;
            if (resolved.processProbe !== undefined) {
                check(typeof resolved.processProbe === 'function');
                try { absent = resolved.processProbe(owner.pid) === 'absent'; } catch (error) { absent = false; }
            } else {
                try { process.kill(owner.pid, 0); } catch (error) { absent = own(error, 'code') === 'ESRCH'; }
            }
            check(absent, 'lock-held');
            append(session, 'recovery-approved', { intentEventId: input.intentEventId, actor: input.actor, decision: 'release-lock',
                reason: input.reason, acceptDuplicateRisk: false, ownerNonce: input.ownerNonce });
            store.releaseReviewedLock(requestId, input.ownerNonce, { ...resolved, recoveryOwner, expectedLastEventHash: session.history.lastEventHash });
            return result(true, 'ok', session.history.status, { requestId });
        }, resolved);
    } catch (error) { return rejected(error, requestId); }
}
async function lifecycle(options) {
    try {
        options = context(options); check(TRIGGERS.includes(options.trigger));
        const initialized = await initProject(options); if (!initialized.ok) return initialized;
        const policy = store.loadPolicy(options);
        if (!policy.enabled) return result(true, 'disabled', 'local-only', { counts: { attempted: 0, succeeded: 0, failed: 0 } });
        check(policy.triggers.includes(options.trigger), 'not-authorized');
        const counts = { attempted: 0, succeeded: 0, failed: 0 };
        let batchBudget = policy.limits.MAX_BATCH;
        let firstFailure;
        // Durable turns keep a finite queue progressing across invocations,
        // including refreshes and local refusals, even when clocks tie. A
        // timestamp-only sort or submit-only priority can starve other rows.
        const rows = store.listRequests(options)
            .filter((row) => row.request.applicability === 'shared-toolkit' && row.request.exportApproved)
            .map((row) => {
                const history = store.readEvents(row.request.requestId, options);
                const turns = history.events.filter((event) => ['attempt-started', 'blocked'].includes(event.kind)).length;
                return { row, turns };
            })
            .sort((a, b) => a.turns - b.turns || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0));
        for (const { row } of rows) {
            let current;
            try {
                current = store.loadPolicy(options); scan(current);
                check(current.enabled, 'disabled'); check(current.triggers.includes(options.trigger), 'not-authorized');
            } catch (error) { return { ...rejected(error, row.request.requestId), counts }; }
            // Later approval can narrow this run, but cannot widen its already
            // observed ceiling or silently restart the cumulative batch count.
            batchBudget = Math.min(batchBudget, current.limits.MAX_BATCH);
            if (counts.attempted >= batchBudget) break;
            const history = store.readEvents(row.request.requestId, options);
            const state = stateOf(history);
            const operation = state.receipt ? 'refresh' : history.status === 'uncertain' ? 'reconcile' : 'submit';
            if (!current.operations.includes(operation)) continue;
            if (state.retry?.data.nextAttemptAt && Date.parse(at(options)) < Date.parse(state.retry.data.nextAttemptAt)) {
                // Preserve the observable delay without spending a turn or
                // hiding ready peers behind a repeatedly throttled row.
                if (firstFailure === undefined) firstFailure = result(false, 'throttled', history.status, { requestId: row.request.requestId });
                continue;
            }
            // No lifecycle path invokes recover or consumes a reviewed create grant.
            counts.attempted++;
            const methods = { submit, reconcile, refresh };
            const outcome = await methods[operation](row.request.requestId, options);
            if (outcome.ok) counts.succeeded++;
            else { counts.failed++; if (firstFailure === undefined) firstFailure = outcome; }
        }
        return firstFailure ? { ...firstFailure, counts } : result(true, 'ok', 'processed', { counts });
    } catch (error) { return rejected(error); }
}

function readInput(filename, options) {
    check(typeof filename === 'string' && filename.length > 0 && !path.isAbsolute(filename));
    const root = options.projectRoot; const target = path.resolve(root, filename);
    const relative = path.relative(root, target);
    check(relative && !path.isAbsolute(relative) && !relative.split(path.sep).some((part) => part === '..'));
    let current = root; let fd;
    try {
        // The active authority root must be physical too, including ancestors
        // above it; an absolute path does not establish that ownership.
        for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
            const stat = fs.lstatSync(ancestor); check(stat.isDirectory() && !stat.isSymbolicLink());
            if (ancestor === path.dirname(ancestor)) break;
        }
        for (const part of relative.split(path.sep)) {
            check(part && part !== '.' && part !== '..' && !part.includes(':'));
            current = path.join(current, part); check(!fs.lstatSync(current).isSymbolicLink());
        }
        const leaf = fs.lstatSync(target); check(leaf.isFile() && leaf.size <= CEILINGS.MAX_RECORD_BYTES);
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const info = fs.fstatSync(fd); check(info.isFile() && info.size <= CEILINGS.MAX_RECORD_BYTES);
        const bytes = Buffer.alloc(CEILINGS.MAX_RECORD_BYTES + 1); let used = 0;
        while (used < bytes.length) { const count = fs.readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
        check(used <= CEILINGS.MAX_RECORD_BYTES);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    } catch (error) { fail('invalid-input'); }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { fail('persistence-failed'); } } }
}
function exitCode(outcome) {
    if (outcome.ok) return 0;
    if (['invalid-input', 'unsupported-version'].includes(outcome.code)) return 2;
    if (['not-initialized', 'disabled', 'identity-mismatch', 'scope-mismatch', 'not-authorized', 'protected-export', 'not-transferable'].includes(outcome.code)) return 3;
    if (['persistence-failed', 'corrupt-history', 'lock-held'].includes(outcome.code)) return 5;
    return 4;
}
async function cli(args) {
    try {
        check(Array.isArray(args) && args.length > 0);
        const command = args[0];
        const flagsByCommand = { init: ['input'], capture: ['input'], status: ['id'], submit: ['id'], reconcile: ['id'],
            refresh: ['id'], recover: ['id', 'input'], lifecycle: ['trigger'] };
        check(Object.hasOwn(flagsByCommand, command));
        const parsed = {};
        for (let index = 1; index < args.length; index += 2) {
            const flag = args[index]; const value = args[index + 1];
            check(typeof flag === 'string' && flag.startsWith('--') && flagsByCommand[command].includes(flag.slice(2)) &&
                !Object.hasOwn(parsed, flag.slice(2)) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'));
            parsed[flag.slice(2)] = value;
        }
        const options = context();
        if (['submit', 'reconcile', 'refresh', 'recover'].includes(command)) { check(Object.hasOwn(parsed, 'id')); uuid(parsed.id); }
        if (['init', 'capture', 'recover'].includes(command)) check(Object.hasOwn(parsed, 'input'));
        if (command === 'status') return status({ ...options, ...(parsed.id === undefined ? {} : { requestId: parsed.id }) });
        if (command === 'lifecycle') { check(Object.hasOwn(parsed, 'trigger')); return lifecycle({ ...options, trigger: parsed.trigger }); }
        if (command === 'init') return init(readInput(parsed.input, options), options);
        if (command === 'capture') return capture(readInput(parsed.input, options), options);
        if (command === 'recover') return recover(parsed.id, readInput(parsed.input, options), options);
        return { submit, reconcile, refresh }[command](parsed.id, options);
    } catch (error) { return rejected(error); }
}

module.exports = { initProject, init, capture, status, submit, reconcile, refresh, recover, lifecycle };
if (require.main === module) cli(process.argv.slice(2)).then((outcome) => {
    process.stdout.write(JSON.stringify(outcome) + '\n'); process.exitCode = exitCode(outcome);
}, () => { process.stdout.write(JSON.stringify(result(false, 'persistence-failed', 'held')) + '\n'); process.exitCode = 5; });
