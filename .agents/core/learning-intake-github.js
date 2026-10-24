'use strict';

// Credentials stay private; selected proposals travel only as bounded HTTPS data.
const https = require('https');
const { spawn } = require('child_process');
const { TextDecoder } = require('util');
const store = require('./_lib/learning-intake-store');
const { LEARNING_INTAKE_LIMITS: CEILINGS } = require('./constants');
const { REQUEST_PREFIX, RESOLUTION_PREFIX, MARKER_PREFIX } = store;

const TOKEN_ARGS = Object.freeze(['auth', 'token', '--hostname', 'github.com']);
const API_VERSION = '2026-03-10';
const TOOL_CLEANUP_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const REJECTIONS = Object.freeze({ 401: 'auth-unavailable', 403: 'access-denied', 404: 'destination-unavailable', 422: 'invalid-input', 429: 'throttled' });
const DISPATCH_REFUSALS = new Set(['not-initialized', 'disabled', 'invalid-input', 'unsupported-version',
    'identity-mismatch', 'scope-mismatch', 'not-authorized', 'protected-export', 'not-transferable',
    'budget-exhausted', 'corrupt-history', 'lock-held', 'persistence-failed']);

function failure(code, possibleWrite = false, extras) {
    const error = new Error(code);
    error.code = code; error.possibleWrite = possibleWrite;
    if (extras) Object.assign(error, extras);
    return error;
}
function check(condition, code = 'invalid-input') { if (!condition) throw failure(code); }
function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function limitsOf(value) {
    if (value === undefined) return { ...CEILINGS };
    store.canonicalHash(value);
    check(value && typeof value === 'object' && !Array.isArray(value));
    check(Object.keys(value).every((key) => Object.hasOwn(CEILINGS, key)));
    const limits = { ...CEILINGS, ...value };
    for (const key of Object.keys(limits)) check(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= CEILINGS[key]);
    return limits;
}
function object(value, required, optional = []) {
    store.canonicalHash(value);
    check(value && typeof value === 'object' && !Array.isArray(value));
    check(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
    return value;
}
function tokenValue(value, limit) {
    check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && /^[\x21-\x7e]+$/.test(value), 'auth-unavailable');
    return value;
}
function bounded(action, timeoutMs, code, possibleWrite = false) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(ok, value) {
            if (finished) return;
            finished = true; clearTimeout(timer);
            if (ok) resolve(value); else reject(failure(code, possibleWrite));
        }
        Promise.resolve().then(action).then((value) => finish(true, value), () => finish(false));
    });
}
function runFixedTool(options) {
    // POSIX supplies an isolated owned process group. Without a Windows Job
    // Object there is no equivalent proven containment, so refuse before spawn.
    if (process.platform === 'win32') return Promise.resolve({ status: 1, stdout: '', stderr: '' });
    return new Promise((resolve) => {
        let child; let stopping = false; let closed = false; let stdoutSize = 0; let stderrSize = 0;
        const stdout = [];
        const timer = setTimeout(() => finish(false), options.timeoutMs);
        function groupAbsent() {
            if (!child || !child.pid) return true;
            try { process.kill(-child.pid, 0); return false; }
            catch (error) { return own(error, 'code') === 'ESRCH'; }
        }
        async function finish(ok, status = 1) {
            if (stopping) return;
            stopping = true; clearTimeout(timer);
            if (child && child.pid && !groupAbsent()) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* An unresolved group never yields a credential. */ }
            }
            let closureObserved = !child || !child.pid;
            if (!closureObserved) {
                const deadline = Date.now() + TOOL_CLEANUP_MS;
                // Close reaps the direct child; kill(0) additionally proves no
                // remaining processes in the credential tool's owned group.
                while (!(closureObserved = closed && groupAbsent()) && Date.now() < deadline) {
                    await new Promise((done) => setTimeout(done, 25));
                }
            }
            const success = ok && closureObserved;
            let output = '';
            try { if (success) output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)); }
            catch { resolve({ status: 1, stdout: '', stderr: '' }); return; }
            resolve({ status: success ? status : 1, stdout: output, stderr: '' });
        }
        try {
            child = spawn(options.command, options.args, { windowsHide: true, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            child.on('error', () => finish(false));
            child.stdout.on('data', (chunk) => {
                if (stopping) return;
                stdoutSize += chunk.length;
                if (stdoutSize > options.maxOutputBytes) finish(false); else stdout.push(chunk);
            });
            child.stderr.on('data', (chunk) => {
                if (stopping) return;
                stderrSize += chunk.length;
                if (stderrSize > options.maxOutputBytes) finish(false);
            });
            child.on('close', (code) => { closed = true; finish(code === 0, code); });
        } catch { finish(false); }
    });
}
async function acquireGithubToken({ runTool = runFixedTool, limits } = {}) {
    const bounds = limitsOf(limits); check(typeof runTool === 'function');
    const invoke = () => runTool({ command: 'gh', args: [...TOKEN_ARGS], timeoutMs: bounds.OPERATION_TIMEOUT_MS,
        maxOutputBytes: bounds.MAX_RESPONSE_BYTES, shell: false });
    // The owned runner awaits child closure after a stop; a competing watchdog
    // must not return while cleanup is still in progress. Injected seams own I/O.
    let result;
    try { result = runTool === runFixedTool ? await invoke() : await bounded(invoke, bounds.OPERATION_TIMEOUT_MS, 'auth-unavailable'); }
    catch { throw failure('auth-unavailable'); }
    try {
        check(own(result, 'status') === 0 && !own(result, 'error') && !own(result, 'signal'), 'auth-unavailable');
        const output = own(result, 'stdout');
        check(typeof output === 'string' && Buffer.byteLength(output) <= bounds.MAX_RESPONSE_BYTES, 'auth-unavailable');
        return tokenValue(output.replace(/\r?\n$/, ''), bounds.MAX_RESPONSE_BYTES);
    } catch { throw failure('auth-unavailable'); }
}

function approvedEndpoint(input) {
    object(input, ['method', 'url', 'headers', 'timeoutMs', 'maxResponseBytes'], ['body']);
    check(['GET', 'POST'].includes(input.method) && typeof input.url === 'string');
    const url = new URL(input.url);
    check(url.href === input.url && url.protocol === 'https:' && url.hostname === 'api.github.com' && !url.username && !url.password && !url.port && !url.hash);
    const parts = url.pathname.split('/').slice(1);
    const query = [...url.searchParams.entries()];
    let allowed = false;
    if (parts[0] === 'repos' && parts.length >= 3) {
        store.validateDestination({ provider: 'github', owner: parts[1], repository: parts[2], maintainerIds: [] });
        if (parts.length === 3) allowed = input.method === 'GET' && query.length === 0;
        if (parts.length === 4 && parts[3] === 'issues') allowed = input.method === 'POST' && query.length === 0;
        if (parts.length >= 5 && parts[3] === 'issues' && /^[1-9]\d*$/.test(parts[4]) && Number.isSafeInteger(Number(parts[4]))) {
            if (parts.length === 5) allowed = input.method === 'GET' && query.length === 0;
            if (parts.length === 6 && parts[5] === 'comments') allowed = input.method === 'GET' && query.length === 1 &&
                query[0][0] === 'per_page' && /^[1-9]\d*$/.test(query[0][1]) && Number(query[0][1]) <= CEILINGS.MAX_RESOLUTION_COMMENTS;
        }
    }
    if (url.pathname === '/search/issues') {
        allowed = input.method === 'GET' && query.length === 2 && new Set(query.map(([key]) => key)).size === 2 &&
            query.some(([key, value]) => key === 'q' && /^repo:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+ is:issue in:body "agents-learning-[0-9a-f-]+"$/.test(value)) &&
            query.some(([key, value]) => key === 'per_page' && /^[1-9]\d*$/.test(value) && Number(value) <= CEILINGS.MAX_RECONCILIATION_MATCHES + 1);
    }
    check(allowed);
    check(Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= CEILINGS.OPERATION_TIMEOUT_MS);
    check(Number.isSafeInteger(input.maxResponseBytes) && input.maxResponseBytes > 0 && input.maxResponseBytes <= CEILINGS.MAX_RESPONSE_BYTES);
    const names = Object.keys(input.headers).map((key) => key.toLowerCase());
    check(new Set(names).size === names.length && names.every((key) => ['authorization', 'content-type', 'accept', 'user-agent', 'x-github-api-version'].includes(key)));
    for (const value of Object.values(input.headers)) check(typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= CEILINGS.MAX_RESPONSE_BYTES);
    if (input.body !== undefined) check(input.method === 'POST' && typeof input.body === 'string' && Buffer.byteLength(input.body) <= CEILINGS.MAX_EXPORT_BYTES);
    return url;
}
function requestHttps(input, { httpsRequest = https.request } = {}) {
    let url;
    try { url = approvedEndpoint(input); check(typeof httpsRequest === 'function'); }
    catch { return Promise.reject(failure('invalid-input')); }
    return new Promise((resolve, reject) => {
        let req; let res; let settled = false; let ended = false;
        const chunks = []; let size = 0;
        const timer = setTimeout(() => finish(false), input.timeoutMs);
        async function finish(ok, value) {
            if (settled) return;
            settled = true; clearTimeout(timer);
            const owned = [req, res].filter(Boolean);
            const closures = owned.map((stream) => new Promise((done) => {
                if (stream.closed === true) { done(true); return; }
                let complete = false;
                const closeTimer = setTimeout(() => close(false), TOOL_CLEANUP_MS);
                function close(observed) {
                    if (complete) return;
                    complete = true; clearTimeout(closeTimer); stream.removeListener('close', onClose); done(observed);
                }
                function onClose() { close(true); }
                stream.once('close', onClose);
                try { stream.destroy(); } catch { close(false); }
                if (stream.closed === true) close(true);
            }));
            // Resolve failures only after destruction has closed owned I/O, or a
            // bounded cleanup refusal. Never leave a competing timeout winner.
            const closed = await Promise.all(closures);
            if (ok && closed.every(Boolean)) { resolve(value); return; }
            reject(failure('network-unavailable', input.method === 'POST'));
        }
        try {
            req = httpsRequest(url.href, { method: input.method, headers: input.headers, rejectUnauthorized: true }, (response) => {
                try {
                    res = response;
                    if (settled) { res.destroy(); return; }
                    res.on('error', () => finish(false)); res.on('aborted', () => finish(false));
                    if (!Number.isInteger(res.statusCode) || res.statusCode < 100 || res.statusCode > 599) { finish(false); return; }
                    if (Object.hasOwn(REJECTIONS, res.statusCode)) {
                        const headers = {};
                        for (const name of ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
                            const value = res.headers?.[name];
                            if (typeof value === 'string' && /^\d{1,12}$/.test(value)) headers[name] = value;
                        }
                        // Definitive status is independent of an unused error body.
                        finish(true, { statusCode: res.statusCode, headers, body: '' });
                        res.destroy(); if (req) req.destroy(); return;
                    }
                    res.on('close', () => { if (!ended) finish(false); });
                    res.on('data', (chunk) => {
                        if (settled) return;
                        try {
                            if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { finish(false); return; }
                            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                            size += bytes.length;
                            if (size > input.maxResponseBytes) { finish(false); return; }
                            chunks.push(bytes);
                        } catch { finish(false); }
                    });
                    res.on('end', () => {
                        ended = true;
                        try { finish(true, { statusCode: res.statusCode, headers: res.headers || {}, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
                        catch { finish(false); }
                    });
                } catch { finish(false); }
            });
            req.on('error', () => finish(false));
            if (settled) { req.destroy(); return; }
            req.setTimeout(input.timeoutMs, () => finish(false));
            if (input.body !== undefined) req.write(input.body);
            req.end();
        } catch { finish(false); }
    });
}

function escapeHtml(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function unescapeHtml(value) { return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function narrowedRequest(value, limits) {
    const request = store.validateRequest(value);
    check(Buffer.byteLength(JSON.stringify(request)) <= limits.MAX_RECORD_BYTES && request.references.length <= limits.MAX_REFERENCES, 'protected-export');
    for (const field of ['title', 'problem', 'expected', 'proposed', 'reproduction', 'verification']) {
        if (request[field] !== undefined) check(Buffer.byteLength(request[field]) <= limits.MAX_FIELD_BYTES, 'protected-export');
    }
    return request;
}
function buildIssuePayload(value, requestHash, limits) {
    const bounds = limitsOf(limits); const request = narrowedRequest(value, bounds);
    check(request.applicability === 'shared-toolkit' && request.exportApproved === true, 'protected-export');
    check(typeof requestHash === 'string' && SHA.test(requestHash) && requestHash === store.canonicalHash(request));
    const envelope = { schemaVersion: 1, requestHash, request };
    const payload = { title: request.title, body: `${MARKER_PREFIX}${request.requestId}\n${REQUEST_PREFIX}<pre>${escapeHtml(JSON.stringify(envelope))}</pre>` };
    check(Buffer.byteLength(JSON.stringify(payload)) <= bounds.MAX_EXPORT_BYTES, 'protected-export');
    return payload;
}
function parseBody(body, maximum) {
    check(typeof body === 'string' || Buffer.isBuffer(body));
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    check(bytes.length <= maximum);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function markerIdentity(marker) {
    check(typeof marker === 'string' && marker.startsWith(MARKER_PREFIX));
    const id = marker.slice(MARKER_PREFIX.length); check(UUID.test(id)); return id;
}
function requestEnvelope(body, marker, limits) {
    check(typeof body === 'string' && Buffer.byteLength(body) <= limits.MAX_RESPONSE_BYTES);
    const start = `${marker}\n${REQUEST_PREFIX}<pre>`;
    check(body.startsWith(start));
    const end = body.indexOf('</pre>', start.length); check(end !== -1);
    const encoded = body.slice(start.length, end); check(!/[<>]/.test(encoded));
    const envelope = object(parseBody(unescapeHtml(encoded), limits.MAX_RECORD_BYTES), ['schemaVersion', 'requestHash', 'request']);
    check(envelope.schemaVersion === 1 && typeof envelope.requestHash === 'string' && SHA.test(envelope.requestHash));
    envelope.request = narrowedRequest(envelope.request, limits);
    check(envelope.requestHash === store.canonicalHash(envelope.request));
    // Extra issue prose is inert, including a forged body-only resolution. A
    // second request envelope is ambiguous and can never validate a receipt.
    check(!body.slice(end + '</pre>'.length).includes(REQUEST_PREFIX));
    return envelope;
}
function repoApi(destination) { return `https://api.github.com/repos/${destination.owner}/${destination.repository}`; }
function matchedIssue(item, destination, bindings, limits) {
    check(item && typeof item === 'object' && !Array.isArray(item)); store.canonicalHash(item);
    check(!Object.hasOwn(item, 'pull_request') && Number.isSafeInteger(item.id) && item.id > 0 && Number.isSafeInteger(item.number) && item.number > 0);
    check(item.repository_url === repoApi(destination) && item.url === `${repoApi(destination)}/issues/${item.number}` && item.html_url === store.receiptUrl(destination, item.number));
    if (bindings.issueId !== undefined) check(item.id === bindings.issueId);
    if (bindings.issueNumber !== undefined) check(item.number === bindings.issueNumber);
    const envelope = requestEnvelope(item.body, bindings.marker, limits);
    check(envelope.request.applicability === 'shared-toolkit' && envelope.request.exportApproved === true);
    check(envelope.request.requestId === markerIdentity(bindings.marker) && envelope.requestHash === bindings.requestHash);
    if (bindings.projectId !== undefined) check(envelope.request.projectId === bindings.projectId);
    const receipt = store.validateReceipt({ issueId: item.id, issueNumber: item.number, url: item.html_url, destination,
        destinationHash: store.canonicalHash(destination), requestHash: bindings.requestHash, marker: bindings.marker, receivedAt: new Date().toISOString() },
    { requestId: envelope.request.requestId, requestHash: bindings.requestHash, destination });
    check(['open', 'closed'].includes(item.state));
    return { receipt, remoteState: item.state };
}
function hasNext(headers) { return typeof headers.link === 'string' && /rel\s*=\s*["']?next(?:["';,\s]|$)/i.test(headers.link); }
function commentResolution(comments, requestId, destination, limits) {
    check(Array.isArray(comments) && comments.length <= limits.MAX_RESOLUTION_COMMENTS, 'invalid-resolution');
    const ids = new Set(); let resolution;
    for (const comment of comments) {
        check(comment && typeof comment === 'object' && Number.isSafeInteger(comment.id) && comment.id > 0 && !ids.has(comment.id), 'invalid-resolution');
        ids.add(comment.id);
        check(comment.user && typeof comment.user === 'object' && Number.isSafeInteger(comment.user.id) && comment.user.id > 0 && typeof comment.body === 'string', 'invalid-resolution');
        if (!destination.maintainerIds.includes(comment.user.id) || !comment.body.includes(RESOLUTION_PREFIX)) continue;
        check(resolution === undefined, 'invalid-resolution');
        const start = `${RESOLUTION_PREFIX}<pre>`;
        check(comment.body.startsWith(start) && comment.body.endsWith('</pre>'), 'invalid-resolution');
        const encoded = comment.body.slice(start.length, -'</pre>'.length);
        check(!/[<>]/.test(encoded), 'invalid-resolution');
        resolution = store.validateResolution(parseBody(unescapeHtml(encoded), limits.MAX_RECORD_BYTES), { requestId });
        for (const scalar of [resolution.rationale, resolution.implementation?.reference, resolution.implementation?.summary,
            resolution.verification?.reference, resolution.verification?.summary, resolution.release?.publicationReference]) {
            if (scalar !== undefined) check(Buffer.byteLength(scalar) <= limits.MAX_FIELD_BYTES, 'invalid-resolution');
        }
    }
    return resolution;
}

function createGithubTransport({ getToken, request: httpRequest = requestHttps, limits } = {}) {
    const bounds = limitsOf(limits);
    check(getToken === undefined || typeof getToken === 'function'); check(typeof httpRequest === 'function');
    async function token() {
        const value = getToken === undefined ? await acquireGithubToken({ limits: bounds }) : await bounded(getToken, bounds.OPERATION_TIMEOUT_MS, 'auth-unavailable');
        return tokenValue(value, bounds.MAX_RESPONSE_BYTES);
    }
    function destinationOf(value) {
        const destination = store.validateDestination(value);
        check(destination.maintainerIds.length <= bounds.MAX_MAINTAINERS);
        return destination;
    }
    function guard(beforeDispatch) {
        if (beforeDispatch === undefined) return;
        try {
            const returned = beforeDispatch();
            if (returned !== undefined) {
                try { Promise.prototype.then.call(returned, () => {}, () => {}); } catch { /* Never await a guard or inspect a then getter. */ }
                throw failure('invalid-input');
            }
        } catch (error) {
            const code = own(error, 'code');
            const refusal = failure(DISPATCH_REFUSALS.has(code) ? code : 'not-authorized');
            throw refusal;
        }
    }
    async function call(accessToken, method, url, body, beforeDispatch) {
        const possibleWrite = method === 'POST';
        const input = { method, url, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json',
            'User-Agent': 'Domdhi.Agents-learning-intake', 'X-GitHub-Api-Version': API_VERSION }, timeoutMs: bounds.OPERATION_TIMEOUT_MS, maxResponseBytes: bounds.MAX_RESPONSE_BYTES };
        if (body !== undefined) { input.body = body; input.headers['Content-Type'] = 'application/json'; }
        let result; let refusal;
        try {
            const dispatch = () => {
                try { guard(beforeDispatch); } catch (error) { refusal = error; throw error; }
                return httpRequest(input);
            };
            // Owned HTTPS terminates its stream on timeout. Caller-injected seams
            // are trusted and own cancellation; their promise is still bounded.
            result = httpRequest === requestHttps ? await dispatch() : await bounded(dispatch, bounds.OPERATION_TIMEOUT_MS, 'network-unavailable', possibleWrite);
            check(result && typeof result === 'object' && !Array.isArray(result) && Object.getPrototypeOf(result) === Object.prototype);
            for (const key of ['statusCode', 'headers', 'body']) check(Object.hasOwn(Object.getOwnPropertyDescriptor(result, key) || {}, 'value'));
            check(Number.isInteger(result.statusCode) && result.statusCode >= 100 && result.statusCode <= 599);
            store.canonicalHash(result.headers); check(result.headers && typeof result.headers === 'object' && !Array.isArray(result.headers));
            for (const name of ['link', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
                if (Object.hasOwn(result.headers, name)) check(typeof result.headers[name] === 'string');
            }
        } catch {
            if (refusal) throw refusal;
            throw failure(possibleWrite ? 'write-uncertain' : 'network-unavailable', possibleWrite);
        }
        if (Object.hasOwn(REJECTIONS, result.statusCode)) {
            let code = REJECTIONS[result.statusCode]; let nextAttemptAt;
            if (result.statusCode === 403 && (result.headers['x-ratelimit-remaining'] === '0' || result.headers['retry-after'] !== undefined)) code = 'throttled';
            if (code === 'throttled') {
                const delay = result.headers['retry-after']; const reset = result.headers['x-ratelimit-reset'];
                const now = Date.now();
                const ms = typeof delay === 'string' && /^(?:0|[1-9]\d{0,4})$/.test(delay) && Number(delay) <= 86400 ? now + Number(delay) * 1000 :
                    typeof reset === 'string' && /^\d{1,12}$/.test(reset) ? Number(reset) * 1000 : NaN;
                if (Number.isFinite(ms) && ms >= now && ms <= now + 86400000) nextAttemptAt = new Date(ms).toISOString();
            }
            throw failure(code, false, nextAttemptAt ? { nextAttemptAt } : undefined);
        }
        if (result.statusCode < 200 || result.statusCode >= 300) throw failure(possibleWrite ? 'write-uncertain' : 'network-unavailable', possibleWrite);
        return result;
    }
    async function validateDestination(value, beforeDispatch) {
        check(beforeDispatch === undefined || typeof beforeDispatch === 'function');
        const destination = destinationOf(value); const accessToken = await token();
        const result = await call(accessToken, 'GET', repoApi(destination), undefined, beforeDispatch);
        try {
            const repo = parseBody(result.body, bounds.MAX_RESPONSE_BYTES);
            check(repo && Number.isSafeInteger(repo.id) && repo.id > 0 && repo.owner?.login === destination.owner && repo.name === destination.repository &&
                repo.full_name === `${destination.owner}/${destination.repository}` && repo.html_url === `https://github.com/${destination.owner}/${destination.repository}` &&
                repo.has_issues === true && repo.archived === false && repo.disabled === false);
            return destination;
        } catch { throw failure('destination-unavailable'); }
    }
    async function create(input, beforeDispatch) {
        check(beforeDispatch === undefined || typeof beforeDispatch === 'function');
        object(input, ['destination', 'request', 'requestHash', 'marker']);
        const destination = destinationOf(input.destination);
        check(markerIdentity(input.marker) === input.request.requestId);
        const payload = buildIssuePayload(input.request, input.requestHash, bounds);
        const accessToken = await token();
        const result = await call(accessToken, 'POST', `${repoApi(destination)}/issues`, JSON.stringify(payload), beforeDispatch);
        try { return matchedIssue(parseBody(result.body, bounds.MAX_RESPONSE_BYTES), destination, { ...input, projectId: input.request.projectId }, bounds).receipt; }
        catch { throw failure('write-uncertain', true); }
    }
    async function findByMarker(input, beforeDispatch) {
        check(beforeDispatch === undefined || typeof beforeDispatch === 'function');
        object(input, ['destination', 'marker', 'requestHash', 'projectId']);
        const destination = destinationOf(input.destination);
        markerIdentity(input.marker); check(typeof input.requestHash === 'string' && SHA.test(input.requestHash) && typeof input.projectId === 'string' && UUID.test(input.projectId));
        const accessToken = await token();
        const query = new URLSearchParams({ q: `repo:${destination.owner}/${destination.repository} is:issue in:body "${input.marker}"`, per_page: String(bounds.MAX_RECONCILIATION_MATCHES + 1) });
        const result = await call(accessToken, 'GET', `https://api.github.com/search/issues?${query}`, undefined, beforeDispatch);
        let candidates;
        try {
            const report = parseBody(result.body, bounds.MAX_RESPONSE_BYTES);
            check(!hasNext(result.headers) && report && report.incomplete_results === false && Number.isSafeInteger(report.total_count) && report.total_count >= 0 &&
                Array.isArray(report.items) && report.items.length === report.total_count && report.items.length <= bounds.MAX_RECONCILIATION_MATCHES);
            if (report.items.length === 0) return { matches: [], inconclusive: true, observedEmpty: true };
            candidates = report.items.map((item) => matchedIssue(item, destination, input, bounds).receipt);
            check(new Set(candidates.map((candidate) => candidate.issueId)).size === candidates.length && new Set(candidates.map((candidate) => candidate.issueNumber)).size === candidates.length);
        } catch { return { matches: [], inconclusive: true }; }
        const matches = [];
        for (const candidate of candidates) {
            const observed = await call(accessToken, 'GET', `${repoApi(destination)}/issues/${candidate.issueNumber}`, undefined, beforeDispatch);
            try { matches.push(matchedIssue(parseBody(observed.body, bounds.MAX_RESPONSE_BYTES), destination, { ...input, issueId: candidate.issueId, issueNumber: candidate.issueNumber }, bounds).receipt); }
            catch { return { matches: [], inconclusive: true }; }
        }
        return { matches, inconclusive: matches.length !== 1 };
    }
    async function show(input, beforeDispatch) {
        check(beforeDispatch === undefined || typeof beforeDispatch === 'function');
        let destination; let receipt;
        try {
            object(input, ['destination', 'receipt']); destination = destinationOf(input.destination); receipt = store.validateReceipt(input.receipt);
            check(store.canonicalHash(destination) === store.canonicalHash(receipt.destination));
        } catch { throw failure('receipt-mismatch'); }
        const accessToken = await token();
        const result = await call(accessToken, 'GET', `${repoApi(destination)}/issues/${receipt.issueNumber}`, undefined, beforeDispatch);
        let item;
        try { item = matchedIssue(parseBody(result.body, bounds.MAX_RESPONSE_BYTES), destination, receipt, bounds); }
        catch { throw failure('receipt-mismatch'); }
        let resolution;
        if (destination.maintainerIds.length) {
            const comments = await call(accessToken, 'GET', `${repoApi(destination)}/issues/${receipt.issueNumber}/comments?per_page=${bounds.MAX_RESOLUTION_COMMENTS}`, undefined, beforeDispatch);
            try {
                check(!hasNext(comments.headers), 'invalid-resolution');
                resolution = commentResolution(parseBody(comments.body, bounds.MAX_RESPONSE_BYTES), markerIdentity(receipt.marker), destination, bounds);
            } catch { throw failure('invalid-resolution'); }
        }
        return { receipt, remoteState: item.remoteState, ...(resolution === undefined ? {} : { resolution }) };
    }
    return { validateDestination, findByMarker, create, show };
}

module.exports = { createGithubTransport, acquireGithubToken, requestHttps, buildIssuePayload };
