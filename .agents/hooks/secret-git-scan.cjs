'use strict';

/**
 * Secret git scan — what the managed git hooks scan, and how they read it from git.
 *
 *   listStaged / scanStaged   the staged set of the commit being made (pre-commit, pre-merge-commit, pre-applypatch)
 *   scanPush                  every object a push would publish that the remote does not vouch for (pre-push)
 *
 * Both hand blobs to the engine in as few runs as the size allows (secret-engine.cjs scanFiles: one
 * `betterleaks dir` over a private 0700 staging directory), with the rules of a one-file scan: test files
 * scan named providers only, the allow-marker rule, `.betterleaksignore` fingerprints and value-sha256 entries, archive-signature
 * skips failing closed. A file that cannot be staged faithfully is scanned on its own.
 *
 * BLOBS ARE ADDRESSED BY ID, NEVER BY PATH. `git show :<path>` reads `:0:README` as "stage 0 of README", so
 * a staged file literally named `0:README` had the clean README scanned in its place. The raw diff
 * (`diff --cached --raw -z`, `diff-tree --raw -z`) hands over mode, blob id and path as bytes; the id is
 * what `cat-file --batch` reads. Paths are only labels and policy input (hard-skip, test files, fingerprints).
 *
 * NOTHING IS SKIPPED BECAUSE IT IS LARGE OR LOOKS BINARY. A blob of any size is read whole and scanned (the
 * engine takes 100 MB in about half a second); only a mode-160000 entry (a submodule pointer: a commit id,
 * no content) is skipped, and a blob git cannot resolve fails the scan closed.
 *
 * ROOT. The repository root is whatever git says it is for the process's working directory, exactly as git
 * resolves it for the commit or push that started this process. No environment variable redirects it.
 */

const { spawnSync } = require('child_process');
const patterns = require('./secret-patterns.cjs');
const engine = require('./secret-engine.cjs');

const CHUNK_BYTES = 128 * 1024 * 1024;        // blob content held in memory at once; a bigger blob is a chunk of its own
const IGNORE_NAMES = new Set(['.betterleaksignore', '.gitleaksignore']);
const ZEROS = /^0+$/;
const SYMLINK_AND_FILE_MODES = new Set(['100644', '100755', '120000']);

class GitScanError extends Error {
    constructor(message) { super(message); this.name = 'GitScanError'; }
}

function git(args, cwd, input) {
    return spawnSync('git', args, { cwd, input, windowsHide: true, maxBuffer: Infinity });
}

function gitOut(args, cwd, input) {
    const r = git(args, cwd, input);
    if (r.error || r.status !== 0) {
        const why = r.error ? r.error.message : String(r.stderr || '').trim().split('\n')[0];
        throw new GitScanError(`git ${args[0]} failed${why ? ` (${why})` : ''}`);
    }
    return r.stdout;
}

function gitOk(args, cwd) {
    const r = git(args, cwd);
    return !r.error && r.status === 0;
}

/** The work tree root git resolves for `cwd`. Throws GitScanError outside a work tree. */
function toplevel(cwd = process.cwd()) {
    try {
        return gitOut(['rev-parse', '--show-toplevel'], cwd).toString('utf8').trim();
    } catch {
        throw new GitScanError('not inside a git work tree');
    }
}

// ── raw diff entries ──────────────────────────────────────────────────────────

/**
 * Entries of `git diff --raw -z --no-abbrev --no-renames` / `diff-tree --stdin ... -z`:
 * `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`, with a bare `<commit>\0` header before the
 * entries of each commit in the diff-tree form.
 */
function parseRaw(buf) {
    const toks = Buffer.from(buf).toString('utf8').split('\0');
    const entries = [];
    let commit = null;
    for (let i = 0; i < toks.length;) {
        const t = toks[i];
        if (t === '') { i++; continue; }
        if (t[0] === ':') {
            const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(t);
            if (!m || toks[i + 1] === undefined) throw new GitScanError('git printed a diff entry that could not be read');
            entries.push({ commit, mode: m[2], sha: m[4], status: m[5], path: toks[i + 1] });
            i += 2;
        } else {
            commit = t;
            i++;
        }
    }
    return entries;
}

/** The staged changes of the commit in progress (honors GIT_INDEX_FILE, so `commit -a` / `--only` see their temp index). */
function listStaged(root) {
    const all = parseRaw(gitOut(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--diff-filter=ACMRT'], root));
    return {
        entries: all.filter(e => SYMLINK_AND_FILE_MODES.has(e.mode)),
        gitlinks: all.filter(e => e.mode === '160000').map(e => e.path),
    };
}

// ── blobs ─────────────────────────────────────────────────────────────────────

/**
 * `git cat-file --batch` over `specs` (object ids or `<rev>:<path>`): one result per spec, in order:
 * { type, content: Buffer } or { missing: true }. Throws GitScanError when the stream stops making sense.
 */
function catBatch(root, specs) {
    if (!specs.length) return [];
    const out = gitOut(['cat-file', '--batch'], root, specs.map(s => `${s}\n`).join(''));
    const results = [];
    let pos = 0;
    for (let i = 0; i < specs.length; i++) {
        const eol = out.indexOf(0x0a, pos);
        if (eol < 0) throw new GitScanError('git cat-file output ended early');
        const header = out.subarray(pos, eol).toString('utf8');
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (m) {
            const size = Number(m[2]);
            if (eol + 1 + size > out.length) throw new GitScanError('git cat-file output ended early');
            results.push({ type: m[1], content: out.subarray(eol + 1, eol + 1 + size) });
            pos = eol + 1 + size + 1;
        } else if (/ (missing|ambiguous)$/.test(header)) {
            results.push({ missing: true });
            pos = eol + 1;
        } else {
            throw new GitScanError('git cat-file printed a header that could not be read');
        }
    }
    return results;
}

/** Sizes without content: Map sha -> { size } | { error }. */
function checkBlobs(root, shas) {
    const unique = [...new Set(shas)];
    const meta = new Map();
    if (!unique.length) return meta;
    const lines = gitOut(['cat-file', '--batch-check'], root, unique.map(s => `${s}\n`).join('')).toString('utf8').split('\n');
    unique.forEach((sha, i) => {
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(lines[i] || '');
        if (!m) meta.set(sha, { error: 'the object is missing from the repository' });
        else if (m[1] !== 'blob') meta.set(sha, { error: `the object is a ${m[1]}, not a file` });
        else meta.set(sha, { size: Number(m[2]) });
    });
    return meta;
}

/** Map sha -> Buffer | { error }. A stream that stops making sense is re-read one object at a time. */
function readBlobs(root, shas) {
    const unique = [...new Set(shas)];
    const out = new Map();
    let batch = null;
    try { batch = catBatch(root, unique); } catch { batch = null; }
    unique.forEach((sha, i) => {
        let got = batch && batch[i];
        if (!got || got.missing) {
            try { got = catBatch(root, [sha])[0]; } catch { got = null; }
        }
        if (!got || got.missing || got.type !== 'blob') out.set(sha, { error: 'git could not read the blob' });
        else out.set(sha, got.content);
    });
    return out;
}

// ── scanning blob entries ─────────────────────────────────────────────────────

/** A path the staging directory cannot hold faithfully on every platform (reserved names, odd characters). */
function stagingUnsafe(rel) {
    return /[<>:"|?*\\\x00-\x1f]/.test(rel)
        || /(^|\/)(con|prn|aux|nul|com\d|lpt\d)(\.|\/|$)/i.test(rel)
        || /[. ](\/|$)/.test(rel);
}

const baseName = p => p.slice(p.lastIndexOf('/') + 1);

/**
 * Scan entries { rel, path, sha } (a git blob) or { rel, path, content } (text held in memory): Map rel ->
 * { findings } | { error, unreadable? }. `rel` names the entry in the staging directory and in findings;
 * `path` is the repository path used for policy (hard-skip happens in the caller; test files scan named
 * providers only; an ignore file among the entries is scanned on its own). Engine faults throw.
 *
 * @param {{ ignore?: Set<string>|Function, batch?: boolean }} [options]  batch: false forces one engine
 *   process per file (the parity tests compare the two)
 */
function scanEntries(root, entries, { ignore = null, batch = true } = {}) {
    const results = new Map();
    const meta = checkBlobs(root, entries.filter(e => e.sha).map(e => e.sha));
    const sizeOf = e => (e.content ? e.content.length : meta.get(e.sha).size);

    const readable = [];
    for (const e of entries) {
        const m = e.sha ? meta.get(e.sha) : null;
        if (m && m.error) results.set(e.rel, { error: m.error, unreadable: true });
        else readable.push(e);
    }

    for (let i = 0; i < readable.length;) {
        const chunk = [];
        let bytes = 0;
        while (i < readable.length && (chunk.length === 0 || bytes + sizeOf(readable[i]) <= CHUNK_BYTES)) {
            bytes += sizeOf(readable[i]);
            chunk.push(readable[i++]);
        }
        scanChunk(root, chunk, readBlobs(root, chunk.filter(e => e.sha).map(e => e.sha)), results, { ignore, batch });
    }
    return results;
}

function scanChunk(root, chunk, blobs, results, { ignore, batch }) {
    const byRel = new Map(chunk.map(e => [e.rel, e]));
    const bytesOf = e => (e.content ? e.content : blobs.get(e.sha));
    const readableChunk = [];
    for (const e of chunk) {
        const b = bytesOf(e);
        if (b && b.error) results.set(e.rel, { error: b.error, unreadable: true });
        else readableChunk.push(e);
    }
    const textOf = e => Buffer.from(bytesOf(e)).toString('utf8');
    const optionsFor = rel => ({ namedProvidersOnly: patterns.isTestFilePath(byRel.get(rel).path) });
    const scanOne = e => {
        results.set(e.rel, { findings: patterns.scanContent(textOf(e), e.rel, { ...optionsFor(e.rel), wholeFile: true, ignore }) });
    };

    const folded = new Map();
    for (const e of readableChunk) {
        const key = e.rel.normalize('NFC').toLowerCase();
        folded.set(key, (folded.get(key) || 0) + 1);
    }
    const viaBatch = [];
    for (const e of readableChunk) {
        // Scanned on their own: case-colliding names (one would overwrite the other in the staging dir), names the
        // staging dir cannot hold, and an ignore file (the engine reads one it finds among the files it scans).
        if (!batch || folded.get(e.rel.normalize('NFC').toLowerCase()) > 1 || stagingUnsafe(e.rel) || IGNORE_NAMES.has(baseName(e.path))) scanOne(e);
        else viaBatch.push(e);
    }
    if (viaBatch.length) {
        const found = engine.scanFiles(root, viaBatch.map(e => e.rel), optionsFor, {
            ignore,
            contentFor: rel => engine.utf8Bytes(bytesOf(byRel.get(rel))), // the same decoded text a one-file scan feeds the engine (no copy when it is valid UTF-8)
            reportSuppressed: true,
        });
        for (const e of viaBatch) results.set(e.rel, found.get(e.rel) || { error: 'not scanned' });
    }
}

// ── the commit being made ─────────────────────────────────────────────────────

/**
 * Blob ids already committed at HEAD. A staged file whose exact content is one of them adds nothing new to the
 * repository: a rename, a move or a copy of committed content. Without HEAD (the first commit) or if git cannot
 * list it, the set is empty and everything staged is scanned: over-scan, never under-scan.
 */
function committedBlobs(root) {
    let out;
    try { out = gitOut(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], root); } catch { return new Set(); }
    const ids = new Set();
    for (const rec of Buffer.from(out).toString('utf8').split('\0')) {
        const m = /^\d+ blob ([0-9a-f]+)\t/.exec(rec);
        if (m) ids.add(m[1]);
    }
    return ids;
}

/**
 * Scan the staged set. Returns { order, results, gitlinks }: `order` the scanned paths in diff order.
 * The ignore list is the INDEX version of `.betterleaksignore`, so an entry counts once it is itself staged.
 * Content already committed at HEAD is not rescanned (see committedBlobs): moving a folder of old files must not
 * re-raise findings on bytes the repository already holds. Any changed byte is a new blob and is scanned.
 */
function scanStaged(root, { batch = true } = {}) {
    const { entries, gitlinks } = listStaged(root);
    const committed = committedBlobs(root);
    const todo = entries.filter(e => !patterns.isHardSkipPath(e.path) && !committed.has(e.sha)).map(e => ({ rel: e.path, path: e.path, sha: e.sha }));
    const results = scanEntries(root, todo, { ignore: engine.projectIgnoreSet(root), batch });
    return { order: todo.map(e => e.rel), results, gitlinks };
}

// ── the commits a push would publish ──────────────────────────────────────────

/** Parse pre-push's stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
function parsePushLines(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
        return { localRef, localSha, remoteRef, remoteSha };
    });
}

const PUSHABLE_TYPES = new Set(['commit', 'tag', 'tree', 'blob']);
const OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Type and size of each object id, in one `cat-file --batch-check`: Map sha -> { type, size } | { missing: true }. */
function typesOf(root, shas) {
    const unique = [...new Set(shas)];
    const out = new Map();
    if (!unique.length) return out;
    const lines = gitOut(['cat-file', '--batch-check'], root, unique.map(x => `${x}\n`).join('')).toString('utf8').split('\n');
    unique.forEach((sha, i) => {
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(lines[i] || '');
        out.set(sha, m ? { type: m[1], size: Number(m[2]) } : { missing: true });
    });
    return out;
}

/**
 * The object ids the remote itself advertises (`git ls-remote`, run once per push, no prompts). Only a remote's
 * own answer is trusted to say what it already has: a local `refs/remotes/*` is a file any command can write.
 *
 * It is the remote the PUSH goes to that must answer. `ls-remote` applies `url.<base>.insteadOf` rewriting that
 * the push can sidestep (an identity `pushInsteadOf` sends the push to the real URL while `insteadOf` sends
 * `ls-remote` to a decoy repository that holds the secret commit and so "vouches" for it). So the advertisement
 * is used only when git itself says that asking `<url>` contacts exactly `<url>`:
 * `git ls-remote --get-url -- <url>` must print `<url>` unchanged. Any mismatch, any failure, no URL (a remote
 * NAME is not enough: its fetch URL may differ from where the push goes): no advertisement, and the caller
 * scans everything new relative to the remote ids git passed on stdin. Over-scan, never under-scan.
 *
 * Returns the advertised ids, or null when the remote was not (or could not be) asked.
 */
function remoteAdvertised(root, url) {
    if (!url || typeof url !== 'string') return null;
    const opts = { cwd: root, windowsHide: true, timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
    const resolved = spawnSync('git', ['ls-remote', '--get-url', '--', url], opts);
    if (resolved.error || resolved.status !== 0 || resolved.stdout.replace(/\r?\n$/, '') !== url) return null;
    const r = spawnSync('git', ['ls-remote', '--', url], opts);
    if (r.error || r.status !== 0) return null;
    return r.stdout.split('\n').map(l => l.split('\t')[0].trim()).filter(x => OBJECT_NAME.test(x));
}

/**
 * The `value-sha256:` entries listed by the `.betterleaksignore` of EVERY pushed tip (`<tip>:.betterleaksignore`,
 * a tag peeled to its commit). A tip whose tree has no such file, or that is not a commit or tag of one, lists
 * nothing, so the result is empty. Location fingerprints are never taken from here.
 */
function tipValueAllows(root, tips) {
    const unique = [...new Set(tips)];
    if (!unique.length) return new Set();
    let common = null;
    catBatch(root, unique.map(t => `${t}:.betterleaksignore`)).forEach(obj => {
        const values = new Set();
        if (obj && !obj.missing && obj.type === 'blob') {
            for (const entry of engine.parseIgnore(obj.content.toString('utf8'))) if (entry.startsWith('value-sha256:')) values.add(entry);
        }
        common = common === null ? values : new Set([...common].filter(v => values.has(v)));
    });
    return common || new Set();
}

/** The body of a tag object: everything after the header's blank line. */
function tagMessage(content) {
    const text = content.toString('utf8');
    const cut = text.indexOf('\n\n');
    return cut < 0 ? '' : text.slice(cut + 2);
}

/**
 * Scan everything a push would publish, as OBJECTS: `git rev-list --objects <pushed ids> --not <ids the remote
 * vouches for>` lists every commit, tree, blob and annotated tag the push would send, whatever each ref points
 * at (a commit, a tag, even a tag on a bare blob or tree). Every new blob is scanned under whole-file rules at
 * its path from that listing, every commit message and every tag message too. This is the backstop for every
 * way of making a commit that ran no hook: `commit-tree` + `update-ref`, cherry-pick, rebase, stash merges, a
 * bypassed commit, a tag.
 *
 * WHAT THE REMOTE VOUCHES FOR: the remote ids git hands pre-push on stdin, plus the ids the remote advertises to
 * `git ls-remote` (asked once, and only when `ls-remote` provably contacts the URL the push goes to; otherwise nothing
 * extra is excluded). Never a local `refs/remotes/*`, which a
 * `git fetch . main:refs/remotes/origin/x` rewrites in one line. Any object type other than commit, tag, tree or
 * blob fails the scan closed.
 *
 * The ignore list for a blob is the `.betterleaksignore` of the commit that introduced it, and a blob
 * introduced by several commits is ignored only where every one of them lists it. A blob no pushed commit
 * introduces (a tag on a blob, a tree) has no list. That holds for location fingerprints (path:rule:line) and
 * for `value-sha256:` entries alike.
 *
 * REVIEWED VALUES ALREADY IN HISTORY. A `value-sha256:<hex>` entry (one exact value, never a location; see
 * secret-engine parseIgnore) in the `.betterleaksignore` of the pushed TIP also covers that value in every
 * blob the push publishes, whichever commit introduced it: the tip is what is being published now, so an
 * owner who reviews a non-secret that sits in older unpushed commits can pin it without rewriting history.
 * Several pushed refs: only an entry EVERY tip lists counts (a tip with no list, or a tip that is not a commit
 * or tag of one, lists nothing). Location fingerprints in the tip list still do not reach older commits, and
 * nothing ignores a finding in a commit or tag message.
 *
 * @param {string} remote   pre-push's first argument (remote name or URL)
 * @param {string} url      pre-push's second argument (where the push goes); what `ls-remote` is asked
 * @returns {{ commits: string[], tags: string[], order: string[], results: Map, label: (rel: string) => string }}
 */
function scanPush(root, remote, url, updates, { batch = true } = {}) {
    const tips = [];
    const vouched = new Set();
    for (const u of updates) {
        if (u.remoteSha && !ZEROS.test(u.remoteSha)) vouched.add(u.remoteSha);
        if (u.localSha && !ZEROS.test(u.localSha)) tips.push(u.localSha); // a deletion publishes nothing
    }
    const empty = { commits: [], tags: [], order: [], results: new Map(), label: rel => rel };
    if (!tips.length) return empty;

    for (const sha of remoteAdvertised(root, url) || []) vouched.add(sha);
    const known = typesOf(root, [...tips, ...vouched]);
    for (const sha of tips) {
        const k = known.get(sha);
        if (!k || k.missing) throw new GitScanError(`a pushed object (${sha.slice(0, 12)}) is not in this repository`);
        if (!PUSHABLE_TYPES.has(k.type)) throw new GitScanError(`a pushed ref points at a ${k.type} object, which is not scanned`);
    }
    const exclusions = [...vouched].filter(sha => known.get(sha) && !known.get(sha).missing);

    const listing = gitOut(['rev-list', '--objects', '--stdin'], root,
        [...new Set(tips)].map(x => `${x}\n`).join('') + exclusions.map(x => `^${x}\n`).join('')).toString('utf8');
    const names = new Map();           // object id -> first path the listing gives it
    for (const line of listing.split('\n')) {
        const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)(?: (.*))?$/.exec(line);
        if (m && !names.has(m[1])) names.set(m[1], m[2] || '');
    }
    const types = typesOf(root, [...names.keys()]);
    const commits = [];
    const tags = [];
    const blobs = [];
    for (const sha of names.keys()) {
        const t = types.get(sha);
        if (!t || t.missing) throw new GitScanError(`a pushed object (${sha.slice(0, 12)}) is not in this repository`);
        if (!PUSHABLE_TYPES.has(t.type)) throw new GitScanError(`a pushed object (${sha.slice(0, 12)}) is a ${t.type}, which is not scanned`);
        if (t.type === 'commit') commits.push(sha);
        else if (t.type === 'tag') tags.push(sha);
        else if (t.type === 'blob') blobs.push(sha);
    }
    if (!commits.length && !tags.length && !blobs.length) return empty;

    // Which pushed commit introduced which blob at which path: the ignore list that applies to it.
    const byKey = new Map();
    const introduced = new Set();
    const ignoreByCommit = new Map();
    if (commits.length) {
        const raw = parseRaw(gitOut(['diff-tree', '--stdin', '-r', '--raw', '-z', '-m', '--root', '--no-renames', '--no-ext-diff', '--diff-filter=AMT'], root, commits.map(c => `${c}\n`).join('')));
        const ignoreText = catBatch(root, commits.map(c => `${c}:.betterleaksignore`));
        commits.forEach((c, i) => ignoreByCommit.set(c, ignoreText[i].missing || ignoreText[i].type !== 'blob' ? new Set() : engine.parseIgnore(ignoreText[i].content.toString('utf8'))));
        for (const e of raw) {
            if (!SYMLINK_AND_FILE_MODES.has(e.mode) || patterns.isHardSkipPath(e.path)) continue;
            // A blob the listing does not send is already on the remote (a renamed or moved file): the push does not publish it.
            if (!names.has(e.sha)) continue;
            const key = `${e.sha}\0${e.path}`;
            if (!byKey.has(key)) byKey.set(key, { sha: e.sha, path: e.path, commits: [] });
            byKey.get(key).commits.push(e.commit);
            introduced.add(e.sha);
        }
    }
    // Blobs the listing sends that no pushed commit introduces (a tag on a blob, a tree) are scanned at the path the listing names.
    for (const sha of blobs) {
        if (introduced.has(sha)) continue;
        const path = names.get(sha) || `tagged-blob-${sha.slice(0, 12)}`;
        if (patterns.isHardSkipPath(path)) continue;
        byKey.set(`${sha}\0${path}`, { sha, path, commits: [] });
    }

    const entries = [];
    const info = new Map();
    const usedRel = new Set();
    let n = 0;
    for (const e of byKey.values()) {
        // The entry is staged at its own path (path-based rules read it). A second blob at the SAME path gets one
        // numbered directory directly above its file name: every rule that reads a directory name or the file name
        // still sees them, and it costs one mkdir (a whole numbered tree per entry cost 60,000 mkdirs, four seconds,
        // on a 19,000-blob history).
        const slash = e.path.lastIndexOf('/');
        const rel = usedRel.has(e.path) ? `${e.path.slice(0, slash + 1)}~${n}/${e.path.slice(slash + 1)}` : e.path;
        n++;
        usedRel.add(rel);
        usedRel.add(e.path);
        entries.push({ rel, path: e.path, sha: e.sha });
        info.set(rel, e);
    }
    const addMessage = (kind, sha, text) => {
        const rel = `msg/${kind}-${sha}`;
        entries.push({ rel, path: `${kind}-message-${sha.slice(0, 12)}.txt`, content: Buffer.from(text, 'utf8') });
        info.set(rel, { message: kind, sha, commits: [] });
    };
    catBatch(root, commits).forEach((obj, i) => {
        if (!obj || obj.missing || obj.type !== 'commit') throw new GitScanError(`git could not read commit ${commits[i].slice(0, 12)}`);
        const text = obj.content.toString('utf8');
        const cut = text.indexOf('\n\n');
        addMessage('commit', commits[i], cut < 0 ? '' : text.slice(cut + 2));
    });
    catBatch(root, tags).forEach((obj, i) => {
        if (!obj || obj.missing || obj.type !== 'tag') throw new GitScanError(`git could not read tag ${tags[i].slice(0, 12)}`);
        addMessage('tag', tags[i], tagMessage(obj.content));
    });

    // The reviewed values every pushed tip pins (value-sha256 entries only; see the doc comment).
    const tipValues = tipValueAllows(root, tips);

    // Ignored only where every introducing commit lists it (its location or its value), or where every pushed tip
    // pins its value; an object with no introducing commit has no per-commit list (Array.every on an empty list is
    // true, so that case is spelled out). Messages are never ignored.
    const ignore = (attr, ruleId, line, f) => {
        const e = info.get(attr);
        if (!e || e.message) return false;
        const valueKey = f && typeof f.Secret === 'string' && engine.isGenericRule(ruleId) ? engine.valueAllowKey(f.Secret) : null;
        if (valueKey && tipValues.has(valueKey)) return true;
        return e.commits.length > 0 && e.commits.every(c => {
            const list = ignoreByCommit.get(c);
            return list.has(`${e.path}:${ruleId}:${line}`) || Boolean(valueKey && list.has(valueKey));
        });
    };
    const results = scanEntries(root, entries, { ignore, batch });
    const label = rel => {
        const e = info.get(rel);
        if (!e) return rel;
        if (e.message) return `<${e.message} message of ${e.sha.slice(0, 12)}>`;
        return e.commits.length ? `${e.path} (commit ${e.commits[0].slice(0, 12)})` : `${e.path} (pushed object ${e.sha.slice(0, 12)})`;
    };
    return { commits, tags, order: entries.map(e => e.rel), results, label };
}

module.exports = {
    GitScanError, toplevel, parseRaw, listStaged, committedBlobs, catBatch, checkBlobs, readBlobs, scanEntries, scanStaged,
    parsePushLines, scanPush, tipValueAllows, remoteAdvertised, typesOf, stagingUnsafe, CHUNK_BYTES,
};
