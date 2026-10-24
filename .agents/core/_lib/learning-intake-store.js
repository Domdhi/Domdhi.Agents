'use strict';

// Leaf persistence boundary: project-owned authority, no runtime discovery or network.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { TextDecoder } = require('util');
const { LEARNING_INTAKE_LIMITS: LIMITS } = require('../constants');
const { compartmentDir } = require('./output-paths');

const IDENTITY_FILE = '.agents/learning-intake/identity.json';
const POLICY_FILE = '.agents/learning-intake/policy.json';
const REQUEST_PREFIX = 'AGENTS_LEARNING_REQUEST_V1:';
const RESOLUTION_PREFIX = 'AGENTS_LEARNING_RESOLUTION_V1:';
const MARKER_PREFIX = 'agents-learning-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPERATIONS = ['submit', 'reconcile', 'refresh', 'recover'];
const TRIGGERS = ['end', 'do', 'run-todo', 'run-tests', 'todo', 'review-feedback'];
const CODES = new Set(['not-initialized', 'disabled', 'invalid-input', 'unsupported-version',
    'identity-mismatch', 'scope-mismatch', 'not-authorized', 'protected-export', 'not-transferable',
    'budget-exhausted', 'auth-unavailable', 'access-denied', 'destination-unavailable', 'throttled',
    'network-unavailable', 'write-uncertain', 'receipt-mismatch', 'reconciliation-inconclusive',
    'invalid-resolution', 'corrupt-history', 'lock-held', 'persistence-failed']);
// Only explicit definitive rejection events can make an existing intent safe to retry.
// A transport outage or malformed response is never evidence that POST did not commit.
const KNOWN_CREATE_REJECTIONS = new Set(['invalid-input', 'auth-unavailable', 'access-denied', 'destination-unavailable', 'throttled']);

function fail(code = 'invalid-input') { const error = new Error(code); error.code = code; throw error; }
function check(condition, code) { if (!condition) fail(code); }
function isKnownCreateRejection(code) { return KNOWN_CREATE_REJECTIONS.has(code); }
function jsonValue(value, ancestors = new Set()) {
    check(ancestors.size <= 32);
    if (typeof value === 'string') {
        check(Buffer.byteLength(value) <= LIMITS.MAX_RECORD_BYTES && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
        return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { check(Number.isFinite(value)); return value; }
    check(typeof value === 'object' && value !== null && !ancestors.has(value));
    check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    check(keys.length <= LIMITS.MAX_RECORD_BYTES);
    check(keys.every((key) => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key)));
    const result = Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) {
        check(keys.length === value.length + 1 && keys.includes('length'));
        for (let i = 0; i < value.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
            check(descriptor && Object.hasOwn(descriptor, 'value'));
            result.push(jsonValue(descriptor.value, ancestors));
        }
    } else {
        for (const key of keys.sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
            result[key] = jsonValue(descriptor.value, ancestors);
        }
    }
    ancestors.delete(value);
    return result;
}
function canonicalHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(jsonValue(value))).digest('hex');
}
function dto(value, required, optional = []) {
    const clean = jsonValue(value);
    check(clean && !Array.isArray(clean) && typeof clean === 'object');
    check(Buffer.byteLength(JSON.stringify(clean)) <= LIMITS.MAX_RECORD_BYTES);
    check(Object.keys(clean).every((key) => required.includes(key) || optional.includes(key)));
    check(required.every((key) => Object.hasOwn(clean, key)));
    return clean;
}
function version(value) { check(value.schemaVersion === 1, 'unsupported-version'); }
function string(value, max = LIMITS.MAX_FIELD_BYTES) {
    check(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max);
    check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
    return value;
}
function alias(value) { string(value, 128); check(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value)); }
function uuid(value) { check(typeof value === 'string' && UUID.test(value)); }
function sha(value) { check(typeof value === 'string' && SHA.test(value)); }
function commit(value) { check(typeof value === 'string' && COMMIT.test(value)); }
function date(value) {
    check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
    const parsed = new Date(value);
    check(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value);
}
function identityMatch(value, identity) {
    check(value.projectId === identity.projectId && value.projectName === identity.projectName, 'identity-mismatch');
}
function validateIdentity(value) {
    const result = dto(value, ['schemaVersion', 'projectId', 'projectName', 'createdAt']);
    version(result); uuid(result.projectId); alias(result.projectName); date(result.createdAt);
    return result;
}
function validateDestination(value) {
    const result = dto(value, ['provider', 'owner', 'repository', 'maintainerIds']);
    check(result.provider === 'github');
    check(typeof result.owner === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(result.owner) && !result.owner.includes('--'));
    check(typeof result.repository === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(result.repository) && !/^\.+$/.test(result.repository));
    check(Array.isArray(result.maintainerIds) && result.maintainerIds.length <= LIMITS.MAX_MAINTAINERS);
    check(new Set(result.maintainerIds).size === result.maintainerIds.length);
    check(result.maintainerIds.every((id) => Number.isSafeInteger(id) && id > 0));
    return result;
}
function policyScope(value) {
    const scope = { projectId: value.projectId, projectName: value.projectName, exportProfile: value.exportProfile,
        operations: value.operations, triggers: value.triggers, limits: value.limits };
    if (Object.hasOwn(value, 'destination')) scope.destination = value.destination;
    return scope;
}
function validatePolicy(value, { identity } = {}) {
    const result = dto(value, ['schemaVersion', 'projectId', 'projectName', 'enabled', 'exportProfile', 'operations', 'triggers', 'limits'], ['destination', 'approval']);
    version(result); uuid(result.projectId); alias(result.projectName);
    if (identity !== undefined) identityMatch(result, validateIdentity(identity));
    check(typeof result.enabled === 'boolean' && result.exportProfile === 'toolkit-summary-v1');
    for (const [field, allowed] of [['operations', OPERATIONS], ['triggers', TRIGGERS]]) {
        check(Array.isArray(result[field]) && result[field].length <= allowed.length);
        check(new Set(result[field]).size === result[field].length && result[field].every((entry) => allowed.includes(entry)));
    }
    result.limits = dto(result.limits, Object.keys(LIMITS));
    for (const key of Object.keys(LIMITS)) check(Number.isSafeInteger(result.limits[key]) && result.limits[key] > 0 && result.limits[key] <= LIMITS[key]);
    if (Object.hasOwn(result, 'approval')) {
        result.approval = dto(result.approval, ['approvedBy', 'approvedAt', 'scopeHash']);
        alias(result.approval.approvedBy); date(result.approval.approvedAt); sha(result.approval.scopeHash);
        check(result.approval.scopeHash === canonicalHash(policyScope(result)), 'scope-mismatch');
    }
    if (Object.hasOwn(result, 'destination')) {
        result.destination = validateDestination(result.destination);
        check(result.destination.maintainerIds.length <= result.limits.MAX_MAINTAINERS);
    }
    if (result.enabled) check(result.destination && result.approval, 'not-authorized');
    return result;
}
function referencePath(value) {
    string(value, 512);
    const normalized = value.replace(/\\/g, '/');
    check(/^(?:\.agents\/|\.codex\/core\/|\.claude\/core\/)/.test(normalized));
    check(!/[:\u0000-\u001f\u007f]/.test(normalized));
    check(normalized.split('/').every((part) => part && part !== '.' && part !== '..'));
    return normalized;
}
function validateRequest(value) {
    const result = dto(value, ['schemaVersion', 'requestId', 'projectId', 'projectName', 'createdAt', 'toolkitVersion',
        'runtime', 'component', 'applicability', 'title', 'problem', 'expected', 'reproduction', 'verification',
        'references', 'fingerprint', 'exportApproved'], ['toolkitCommit', 'proposed']);
    version(result); uuid(result.requestId); uuid(result.projectId); alias(result.projectName); date(result.createdAt);
    string(result.toolkitVersion, 128); string(result.component, 256);
    check(!/[\u0000-\u001f\u007f]/.test(result.component + result.toolkitVersion));
    if (result.toolkitCommit !== undefined) commit(result.toolkitCommit);
    check(['codex', 'claude'].includes(result.runtime));
    check(['shared-toolkit', 'project-specific'].includes(result.applicability));
    for (const field of ['title', 'problem', 'expected', 'reproduction', 'verification']) string(result[field]);
    if (result.proposed !== undefined) string(result.proposed);
    sha(result.fingerprint); check(typeof result.exportApproved === 'boolean');
    check(Array.isArray(result.references) && result.references.length <= LIMITS.MAX_REFERENCES);
    result.references = result.references.map((value) => {
        const ref = dto(value, ['path'], ['commit', 'sha256']);
        ref.path = referencePath(ref.path);
        if (ref.commit !== undefined) commit(ref.commit);
        if (ref.sha256 !== undefined) sha(ref.sha256);
        return ref;
    });
    return result;
}
function receiptUrl(destination, id) {
    return `https://github.com/${destination.owner}/${destination.repository}/issues/${id}`;
}
function validateReceipt(value, bindings = {}) {
    const result = dto(value, ['issueId', 'issueNumber', 'url', 'destination', 'destinationHash', 'requestHash', 'marker', 'receivedAt']);
    check(Number.isSafeInteger(result.issueId) && result.issueId > 0);
    check(Number.isSafeInteger(result.issueNumber) && result.issueNumber > 0);
    result.destination = validateDestination(result.destination);
    sha(result.destinationHash); sha(result.requestHash); date(result.receivedAt);
    check(result.destinationHash === canonicalHash(result.destination));
    check(result.url === receiptUrl(result.destination, result.issueNumber));
    check(typeof result.marker === 'string' && result.marker.startsWith(MARKER_PREFIX));
    uuid(result.marker.slice(MARKER_PREFIX.length));
    if (bindings.requestId !== undefined) { uuid(bindings.requestId); check(result.marker === `${MARKER_PREFIX}${bindings.requestId}`); }
    if (bindings.requestHash !== undefined) { sha(bindings.requestHash); check(result.requestHash === bindings.requestHash); }
    if (bindings.destination !== undefined) check(canonicalHash(result.destination) === canonicalHash(validateDestination(bindings.destination)));
    return result;
}
function evidence(value) {
    const result = dto(value, ['reference', 'summary', 'sourceCommit']);
    string(result.reference); string(result.summary); commit(result.sourceCommit);
    return result;
}
function validateResolution(value, bindings = {}) {
    const result = dto(value, ['schemaVersion', 'requestId', 'disposition', 'rationale', 'reviewedAt'], ['duplicateOf', 'implementation', 'verification', 'release']);
    version(result); uuid(result.requestId); string(result.rationale); date(result.reviewedAt);
    check(['accepted', 'duplicate', 'project-specific', 'needs-evidence', 'declined'].includes(result.disposition));
    if (bindings.requestId !== undefined) { uuid(bindings.requestId); check(result.requestId === bindings.requestId); }
    if (result.duplicateOf !== undefined) check(result.disposition === 'duplicate' && Number.isSafeInteger(result.duplicateOf) && result.duplicateOf > 0);
    if (result.implementation !== undefined) result.implementation = evidence(result.implementation);
    if (result.verification !== undefined) result.verification = evidence(result.verification);
    if (result.release !== undefined) {
        result.release = dto(result.release, ['version', 'sourceCommit', 'artifactSha256', 'publicationReference', 'inspectedBy', 'inspectedAt']);
        string(result.release.version, 128); commit(result.release.sourceCommit); sha(result.release.artifactSha256);
        string(result.release.publicationReference); alias(result.release.inspectedBy); date(result.release.inspectedAt);
        check(result.disposition === 'accepted' && result.implementation && result.verification);
        check(result.implementation.sourceCommit === result.release.sourceCommit && result.verification.sourceCommit === result.release.sourceCommit);
    }
    return result;
}

// Validate the absolute authority root as well as every path below it.
function ordinaryRoot(root, code = 'persistence-failed') {
    for (let current = root; ; current = path.dirname(current)) {
        const stat = fs.lstatSync(current);
        check(stat.isDirectory() && !stat.isSymbolicLink(), code);
        if (current === path.dirname(current)) break;
    }
}
function projectRoot(options) {
    check(options && typeof options.projectRoot === 'string' && path.isAbsolute(options.projectRoot), 'invalid-input');
    const root = path.resolve(options.projectRoot);
    try { ordinaryRoot(root); }
    catch (error) { fail(error.code === 'invalid-input' ? error.code : 'persistence-failed'); }
    return root;
}
function guarded(root, relative, code = 'persistence-failed') {
    check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), code);
    const parts = relative.replace(/\\/g, '/').split('/');
    check(parts.every((part) => part && part !== '.' && part !== '..' && !part.includes(':')), code);
    let current = root;
    try {
        ordinaryRoot(root, code);
        for (const part of parts) {
            current = path.join(current, part);
            const stat = fs.lstatSync(current, { throwIfNoEntry: false });
            check(!stat || !stat.isSymbolicLink(), code);
        }
    } catch (error) { fail(code); }
    return current;
}
function readJson(root, relative, code = 'invalid-input') {
    const filename = guarded(root, relative);
    let fd;
    try {
        const before = fs.lstatSync(filename);
        check(before.isFile() && before.size <= LIMITS.MAX_RECORD_BYTES, code);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const stat = fs.fstatSync(fd);
        check(stat.isFile() && stat.size <= LIMITS.MAX_RECORD_BYTES, code);
        // Bounded read avoids a file growing between fstat and readFile.
        const bytes = Buffer.alloc(LIMITS.MAX_RECORD_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
            if (!count) break;
            offset += count;
        }
        check(offset <= LIMITS.MAX_RECORD_BYTES, code);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    } catch (error) { if (CODES.has(error.code)) throw error; fail(code); }
    finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { fail('persistence-failed'); } }
    }
}
function exists(root, relative) { return !!fs.lstatSync(guarded(root, relative), { throwIfNoEntry: false }); }
function publish(root, relative, value, collisionCode = 'corrupt-history') {
    const target = guarded(root, relative);
    const bytes = Buffer.from(JSON.stringify(jsonValue(value)) + '\n');
    check(bytes.length <= LIMITS.MAX_RECORD_BYTES);
    let fd;
    const temp = `${relative}.${crypto.randomBytes(16).toString('hex')}.tmp`;
    let tempStat;
    let failure;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        guarded(root, relative);
        const temporary = guarded(root, temp);
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); tempStat = fs.fstatSync(fd);
        fs.closeSync(fd); fd = undefined;
        guarded(root, relative);
        fs.linkSync(temporary, target); // No-replace publication; rename would overwrite.
        check(canonicalHash(readJson(root, relative, 'persistence-failed')) === canonicalHash(value), 'persistence-failed');
    } catch (error) {
        failure = CODES.has(error.code) ? error.code : error.code === 'EEXIST' ? collisionCode : 'persistence-failed';
    } finally {
        try {
            if (fd !== undefined) {
                try { tempStat = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
            }
            if (tempStat) {
                const temporary = guarded(root, temp);
                const stat = fs.lstatSync(temporary, { throwIfNoEntry: false });
                if (stat && !stat.isSymbolicLink() && stat.dev === tempStat.dev && stat.ino === tempStat.ino) fs.unlinkSync(temporary);
            }
        } catch (error) {
            failure = failure || 'persistence-failed';
        }
    }
    if (!failure) {
        // Flush the new record link and every potentially newly created parent
        // link before acknowledging a durable intent. Unsupported filesystems
        // refuse publication rather than authorizing a remote write on weak proof.
        try {
            guarded(root, relative);
            for (let directory = path.dirname(target); ; directory = path.dirname(directory)) {
                let dirFd;
                try {
                    guarded(root, relative);
                    dirFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
                    check(fs.fstatSync(dirFd).isDirectory(), 'persistence-failed');
                    fs.fsyncSync(dirFd);
                } finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
                if (directory === root) break;
            }
        } catch (error) { failure = 'persistence-failed'; }
    }
    if (failure) fail(failure);
}
function now(options) { const value = options.clock ? options.clock() : new Date().toISOString(); date(value); return value; }
function newId(options) { const value = options.newId ? options.newId() : crypto.randomUUID(); uuid(value); return value; }
function recordPath(kind, at, id) {
    date(at); uuid(id);
    const base = path.posix.dirname(compartmentDir(kind));
    const stamp = `${at.slice(2, 4)}${at.slice(5, 7)}${at.slice(8, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}`;
    return `${base}/${at.slice(0, 7)}/${stamp}-${id}.json`;
}
function recordFiles(root, kind) {
    const base = path.posix.dirname(compartmentDir(kind));
    const target = guarded(root, base);
    if (!fs.existsSync(target)) return [];
    const result = [];
    try {
        check(fs.lstatSync(target).isDirectory(), 'persistence-failed');
        for (const month of fs.readdirSync(target).sort()) {
            const monthRel = `${base}/${month}`;
            const dir = guarded(root, monthRel);
            const stat = fs.lstatSync(dir);
            if (month.endsWith('.tmp')) continue;
            check(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && stat.isDirectory(), 'corrupt-history');
            for (const name of fs.readdirSync(dir).sort()) {
                const relative = `${monthRel}/${name}`;
                const filename = guarded(root, relative);
                const leaf = fs.lstatSync(filename);
                if (name.endsWith('.tmp')) continue;
                check(name.endsWith('.json') && leaf.isFile(), 'corrupt-history');
                result.push(relative);
            }
        }
    } catch (error) { if (CODES.has(error.code)) throw error; fail('persistence-failed'); }
    return result;
}
function loadIdentity(options) {
    const root = projectRoot(options);
    check(exists(root, IDENTITY_FILE), 'not-initialized');
    return validateIdentity(readJson(root, IDENTITY_FILE));
}
function loadPolicy(options) {
    const root = projectRoot(options);
    const identity = loadIdentity(options);
    check(exists(root, POLICY_FILE), 'not-initialized');
    return validatePolicy(readJson(root, POLICY_FILE), { identity });
}
function initializeProject(options) {
    const root = projectRoot(options);
    const projectName = options.projectName === undefined ? 'ToolkitProject' : options.projectName;
    alias(projectName);
    const identityExists = exists(root, IDENTITY_FILE);
    check(identityExists || !exists(root, POLICY_FILE), 'identity-mismatch');
    let initialized = false;
    if (!identityExists) {
        const identity = validateIdentity({ schemaVersion: 1, projectId: newId(options), projectName, createdAt: now(options) });
        try { publish(root, IDENTITY_FILE, identity); initialized = true; }
        catch (error) { if (error.code !== 'corrupt-history') throw error; }
    }
    const identity = loadIdentity(options);
    if (!exists(root, POLICY_FILE)) {
        const policy = { schemaVersion: 1, projectId: identity.projectId, projectName: identity.projectName, enabled: false,
            exportProfile: 'toolkit-summary-v1', operations: [], triggers: [], limits: { ...LIMITS } };
        try { publish(root, POLICY_FILE, policy); } catch (error) { if (error.code !== 'corrupt-history') throw error; }
    }
    return { initialized, identity, policy: loadPolicy(options) };
}
function listRequests(options) {
    const root = projectRoot(options);
    const identity = loadIdentity(options);
    const seen = new Set();
    return recordFiles(root, 'evolution/learning-requests').map((relative) => {
        let request;
        try { request = validateRequest(readJson(root, relative, 'corrupt-history')); }
        catch (error) { if (error.code === 'persistence-failed') throw error; fail('corrupt-history'); }
        check(request.projectId === identity.projectId && request.projectName === identity.projectName && !seen.has(request.requestId), 'corrupt-history');
        seen.add(request.requestId);
        for (const reference of request.references) guarded(root, reference.path, 'invalid-input');
        return { request, path: relative, requestHash: canonicalHash(request) };
    });
}
function loadRequest(requestId, options) {
    uuid(requestId);
    const result = listRequests(options).find((row) => row.request.requestId === requestId);
    check(result, 'invalid-input'); return result;
}
async function publishRequest(value, options) {
    const request = validateRequest(value);
    const identity = loadIdentity(options);
    identityMatch(request, identity);
    const root = projectRoot(options);
    for (const reference of request.references) guarded(root, reference.path, 'invalid-input');
    // Serialization is by UUID, independently of the caller's timestamp/filename.
    return withRequestLock(request.requestId, () => {
        check(!listRequests(options).some((row) => row.request.requestId === request.requestId), 'corrupt-history');
        const relative = recordPath('evolution/learning-requests', request.createdAt, request.requestId);
        publish(root, relative, request);
        return loadRequest(request.requestId, options);
    }, options);
}

function validateEvent(value) {
    const event = dto(value, ['schemaVersion', 'eventId', 'requestId', 'projectId', 'at', 'sequence', 'previousEventHash', 'kind', 'data']);
    version(event); uuid(event.eventId); uuid(event.requestId); uuid(event.projectId); date(event.at);
    check(Number.isSafeInteger(event.sequence) && event.sequence > 0);
    if (event.previousEventHash !== null) sha(event.previousEventHash);
    const schemas = {
        captured: [['requestHash']], blocked: [['code', 'operation']],
        'attempt-started': [['attemptId', 'operation', 'policyHash']],
        'create-intent': [['attemptId', 'requestHash', 'destination', 'destinationHash', 'policyHash', 'marker'], ['recoveryEventId']],
        retryable: [['attemptId', 'code'], ['nextAttemptAt']], uncertain: [['attemptId', 'code']],
        acknowledged: [['receipt']], reconciled: [['receipt']],
        'resolution-observed': [['resolution', 'remoteState']],
        'refresh-observed': [['attemptId', 'remoteState']], 'refresh-failed': [['code'], ['nextAttemptAt']],
        'recovery-approved': [['intentEventId', 'actor', 'decision', 'reason', 'acceptDuplicateRisk'],
            ['ownerNonce', 'requestHash', 'destination', 'destinationHash', 'policyHash', 'exportProfile']],
    };
    check(Object.hasOwn(schemas, event.kind));
    event.data = dto(event.data, ...schemas[event.kind]);
    const data = event.data;
    for (const field of ['requestHash', 'destinationHash', 'policyHash']) if (data[field] !== undefined) sha(data[field]);
    if (data.attemptId !== undefined) uuid(data.attemptId);
    if (data.code !== undefined) check(CODES.has(data.code));
    if (data.operation !== undefined) check((event.kind === 'attempt-started' ? OPERATIONS.slice(0, 3) : OPERATIONS).includes(data.operation));
    if (data.nextAttemptAt !== undefined) date(data.nextAttemptAt);
    if (data.destination !== undefined) { data.destination = validateDestination(data.destination); check(data.destinationHash === canonicalHash(data.destination)); }
    if (data.marker !== undefined) check(data.marker === `${MARKER_PREFIX}${event.requestId}`);
    if (data.recoveryEventId !== undefined) uuid(data.recoveryEventId);
    if (Object.hasOwn(data, 'receipt')) data.receipt = validateReceipt(data.receipt, { requestId: event.requestId });
    if (Object.hasOwn(data, 'resolution')) data.resolution = validateResolution(data.resolution, { requestId: event.requestId });
    if (data.remoteState !== undefined) { string(data.remoteState, 128); check(!/[\u0000-\u001f\u007f]/.test(data.remoteState)); }
    if (event.kind === 'recovery-approved') {
        alias(data.actor); string(data.reason); check(typeof data.acceptDuplicateRisk === 'boolean');
        if (data.intentEventId !== null) uuid(data.intentEventId);
        if (data.ownerNonce !== undefined) check(typeof data.ownerNonce === 'string' && /^[0-9a-f]{32}$/.test(data.ownerNonce));
        if (data.decision === 'retry-create') {
            check(data.intentEventId !== null && data.acceptDuplicateRisk === true);
            check(['requestHash', 'destination', 'destinationHash', 'policyHash', 'exportProfile'].every((key) => Object.hasOwn(data, key)));
            check(data.exportProfile === 'toolkit-summary-v1' && !Object.hasOwn(data, 'ownerNonce'));
        } else {
            check(data.decision === 'release-lock' && data.acceptDuplicateRisk === false && Object.hasOwn(data, 'ownerNonce'));
            check(!['requestHash', 'destination', 'destinationHash', 'policyHash', 'exportProfile'].some((key) => Object.hasOwn(data, key)));
        }
    }
    return event;
}
function reduceEvents(events, requestValue) {
    const request = validateRequest(requestValue.request || requestValue);
    const requestHash = canonicalHash(request);
    let status = 'held'; let lastEventHash = null; let intent = null; let receipt = null; let started = null;
    let intentRejected = false;
    const ids = new Set(); const attempts = new Set(); const grants = new Map(); const consumed = new Set();
    try {
        check(Array.isArray(events));
        events = events.map(validateEvent).sort((a, b) => a.sequence - b.sequence);
        for (let index = 0; index < events.length; index++) {
            const event = events[index]; const data = event.data;
            check(event.requestId === request.requestId && event.projectId === request.projectId);
            check(event.sequence === index + 1 && event.previousEventHash === lastEventHash && !ids.has(event.eventId));
            ids.add(event.eventId);
            if (index === 0) check(event.kind === 'captured' || (event.kind === 'recovery-approved' && data.decision === 'release-lock' && data.intentEventId === null));
            switch (event.kind) {
                case 'captured': check(index === 0 && data.requestHash === requestHash); status = request.applicability === 'project-specific' ? 'project-specific' : 'pending'; break;
                case 'blocked': status = intent && !receipt && !intentRejected ? 'uncertain' : receipt ? 'acknowledged' : 'blocked'; started = null; break;
                case 'attempt-started':
                    check(index > 0 && !attempts.has(data.attemptId) && !started);
                    if (data.operation === 'submit') check(!receipt);
                    if (data.operation === 'reconcile') check(intent && !receipt && !intentRejected);
                    if (data.operation === 'refresh') check(receipt);
                    attempts.add(data.attemptId); started = event; break;
                case 'create-intent': {
                    check(started && started.data.operation === 'submit' && started.data.attemptId === data.attemptId && started.data.policyHash === data.policyHash);
                    check(data.requestHash === requestHash && !receipt);
                    if (intent && !intentRejected) {
                        const grant = grants.get(data.recoveryEventId);
                        check(grant && !consumed.has(grant.eventId) && grant.data.intentEventId === intent.eventId);
                        for (const key of ['requestHash', 'destinationHash', 'policyHash']) check(grant.data[key] === data[key]);
                        check(canonicalHash(grant.data.destination) === canonicalHash(data.destination));
                        consumed.add(grant.eventId);
                    } else check(!data.recoveryEventId);
                    intent = event; intentRejected = false; started = null; status = 'uncertain'; break;
                }
                case 'retryable':
                    check(started && started.data.attemptId === data.attemptId || intent && intent.data.attemptId === data.attemptId && !started && events[index - 1].kind === 'create-intent');
                    if (intent && !receipt && intent.data.attemptId === data.attemptId && !started && isKnownCreateRejection(data.code)) intentRejected = true;
                    status = intent && !receipt && !intentRejected ? 'uncertain' : receipt ? 'acknowledged' : 'retryable'; started = null; break;
                case 'uncertain': check(intent && !receipt && intent.data.attemptId === data.attemptId && !intentRejected); status = 'uncertain'; break;
                case 'acknowledged': case 'reconciled':
                    check(intent && !receipt && !intentRejected); validateReceipt(data.receipt, { requestId: request.requestId, requestHash, destination: intent.data.destination });
                    receipt = data.receipt; status = 'acknowledged'; started = null; break;
                case 'resolution-observed': check(receipt); status = 'acknowledged'; started = null; break;
                case 'refresh-observed':
                    check(receipt && started && started.data.operation === 'refresh' && started.data.attemptId === data.attemptId);
                    status = 'acknowledged'; started = null; break;
                case 'refresh-failed': check(receipt); status = 'acknowledged'; started = null; break;
                case 'recovery-approved':
                    if (data.decision === 'retry-create') {
                        check(intent && !receipt && data.intentEventId === intent.eventId && data.requestHash === requestHash);
                        check(data.destinationHash === intent.data.destinationHash && canonicalHash(data.destination) === canonicalHash(intent.data.destination));
                        grants.set(event.eventId, event); status = 'uncertain';
                    } else check(data.intentEventId === (intent ? intent.eventId : null));
                    break;
                default: fail('corrupt-history');
            }
            lastEventHash = canonicalHash(event);
        }
    } catch (error) { fail('corrupt-history'); }
    return { events, status, lastEventHash };
}
function readEvents(requestId, options) {
    uuid(requestId);
    const root = projectRoot(options);
    const request = loadRequest(requestId, options);
    const allRequests = new Map(listRequests(options).map((row) => [row.request.requestId, row.request]));
    const events = [];
    for (const relative of recordFiles(root, 'evolution/learning-events')) {
        let event;
        try {
            event = validateEvent(readJson(root, relative, 'corrupt-history'));
            const owner = allRequests.get(event.requestId);
            check(owner && event.projectId === owner.projectId);
        } catch (error) { if (error.code === 'persistence-failed') throw error; fail('corrupt-history'); }
        if (event.requestId === requestId) events.push(event);
    }
    return reduceEvents(events, request.request);
}
function lockLocation(requestId, options, recovery = false) {
    uuid(requestId);
    const root = options.stateRoot ? projectRoot({ projectRoot: options.stateRoot }) : projectRoot(options);
    return { root, relative: `${compartmentDir('state/learning-intake')}/${requestId}${recovery ? '.recovery' : ''}.lock.json` };
}
function loadOwner(requestId, options, recovery = false) {
    const location = lockLocation(requestId, options, recovery);
    if (!exists(location.root, location.relative)) return null;
    const value = dto(readJson(location.root, location.relative, 'lock-held'), ['schemaVersion', 'requestId', 'projectId', 'nonce', 'pid', 'host', 'createdAt', 'operation']);
    version(value); uuid(value.requestId); uuid(value.projectId);
    check(value.requestId === requestId && typeof value.nonce === 'string' && /^[0-9a-f]{32}$/.test(value.nonce), 'lock-held');
    check(Number.isSafeInteger(value.pid) && value.pid > 0, 'lock-held'); string(value.host, 256); date(value.createdAt); string(value.operation, 64);
    return { ...value, path: location.relative };
}
function loadLock(requestId, options) { return loadOwner(requestId, options); }
function assertLock(requestId, owner, options) {
    check(owner && typeof owner.nonce === 'string', 'lock-held');
    const value = loadLock(requestId, options);
    check(value && value.path === owner.path && value.nonce === owner.nonce && value.projectId === loadIdentity(options).projectId, 'lock-held');
    return value;
}
async function withExclusiveLock(requestId, callback, options, recovery = false) {
    uuid(requestId); check(typeof callback === 'function');
    const identity = loadIdentity(options); const { root, relative } = lockLocation(requestId, options, recovery);
    const filename = guarded(root, relative);
    const lock = { schemaVersion: 1, requestId, projectId: identity.projectId, nonce: crypto.randomBytes(16).toString('hex'),
        pid: process.pid, host: os.hostname(), createdAt: now(options), operation: recovery ? 'recovery' : options.operation || 'local' };
    string(lock.operation, 64);
    let fd;
    let opened = false;
    try {
        fs.mkdirSync(path.dirname(filename), { recursive: true }); guarded(root, relative);
        fd = fs.openSync(filename, 'wx', 0o600); opened = true;
        fs.writeFileSync(fd, JSON.stringify(lock)); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
    } catch (error) {
        const failure = error.code === 'EEXIST' ? 'lock-held' : 'persistence-failed';
        // Failed acquisition may leave a partial lock. Delete only a read-back exact
        // owner, otherwise retain it for explicit reviewed recovery.
        try {
            if (fd !== undefined) fs.closeSync(fd);
            if (opened) {
                const current = loadOwner(requestId, options, recovery);
                if (current && current.nonce === lock.nonce && current.projectId === lock.projectId) fs.unlinkSync(guarded(root, relative));
            }
        } catch (cleanupError) { /* Retain ambiguous ownership; preserve classified failure. */ }
        fail(failure);
    }
    const owner = { ...lock, path: relative };
    let result; let callbackFailure; let didThrow = false;
    try { result = await callback(owner); } catch (error) { didThrow = true; callbackFailure = error; }
    try {
        const current = loadOwner(requestId, options, recovery);
        if (current && current.nonce === owner.nonce && current.projectId === owner.projectId) fs.unlinkSync(guarded(root, relative));
    } catch (error) { if (!didThrow) fail(CODES.has(error.code) ? error.code : 'persistence-failed'); }
    if (didThrow) throw callbackFailure;
    return result;
}
function withRequestLock(requestId, callback, options) { return withExclusiveLock(requestId, callback, options); }
function withRecoveryGuard(requestId, callback, options) { return withExclusiveLock(requestId, callback, options, true); }
function releaseReviewedLock(requestId, ownerNonce, options) {
    uuid(requestId);
    check(typeof ownerNonce === 'string' && /^[0-9a-f]{32}$/.test(ownerNonce), 'invalid-input');
    const identity = loadIdentity(options);
    const guard = loadOwner(requestId, options, true);
    const owner = options.recoveryOwner;
    check(owner && guard && owner.path === guard.path && owner.nonce === guard.nonce && guard.projectId === identity.projectId, 'lock-held');
    const current = loadLock(requestId, options);
    check(current && current.nonce === ownerNonce && current.projectId === identity.projectId, 'lock-held');
    const history = readEvents(requestId, options);
    // The core verifies local liveness and reviewed input; the leaf additionally
    // requires the durable chain to contain this exact local release decision.
    const decision = [...history.events].reverse().find((event) => event.kind === 'recovery-approved');
    check(decision && decision.data.decision === 'release-lock' && decision.data.ownerNonce === ownerNonce, 'corrupt-history');
    if (Object.hasOwn(options, 'expectedLastEventHash')) check(options.expectedLastEventHash === history.lastEventHash, 'corrupt-history');
    const location = lockLocation(requestId, options);
    try { fs.unlinkSync(guarded(location.root, location.relative)); }
    catch (error) { fail('persistence-failed'); }
    return { removed: true };
}
function appendEvent(requestId, kind, data, options) {
    uuid(requestId); const root = projectRoot(options); const identity = loadIdentity(options);
    assertLock(requestId, options.lockOwner, options);
    const history = readEvents(requestId, options);
    check(Object.hasOwn(options, 'expectedLastEventHash') && history.lastEventHash === options.expectedLastEventHash, 'corrupt-history');
    const event = { schemaVersion: 1, eventId: newId(options), requestId, projectId: identity.projectId, at: now(options),
        sequence: history.events.length + 1, previousEventHash: history.lastEventHash, kind, data };
    const request = loadRequest(requestId, options);
    reduceEvents([...history.events, event], request.request);
    const relative = recordPath('evolution/learning-events', event.at, event.eventId);
    publish(root, relative, event);
    const observed = readEvents(requestId, options);
    check(observed.lastEventHash === canonicalHash(event), 'persistence-failed');
    return { event, eventHash: canonicalHash(event), path: relative };
}

module.exports = { REQUEST_PREFIX, RESOLUTION_PREFIX, MARKER_PREFIX, validateIdentity, validateDestination, validateRequest, validatePolicy, validateReceipt, validateResolution,
    validateEvent, policyScope, canonicalHash, initializeProject, publishRequest, loadIdentity, loadPolicy, listRequests,
    loadRequest, readEvents, reduceEvents, appendEvent, withRequestLock, withRecoveryGuard, releaseReviewedLock,
    loadLock, assertLock, receiptUrl, isKnownCreateRejection };
