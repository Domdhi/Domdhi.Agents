/**
 * Secret-safe write guard for LLM output (sec-hardening, Wave 3 Story 3A).
 *
 * The memory LLM utilities embed UNTRUSTED sub-agent memory/daily-log text in
 * their prompts. A prompt-injection payload could make the model echo a live
 * secret into its JSON output, which is then persisted via a RAW node
 * `writeFileSync` — a path that bypasses BOTH the Claude Code `PreToolUse:Write`
 * secret-scanner hook AND (unless the file is git-staged) `commit.js`'s
 * pre-commit scan (see constraint `raw-node-writes-bypass-secret-scanner-hook`).
 *
 * This guard closes that gap: scan the model output for secrets and, on a hit,
 * REDACT before writing + warn on stderr. Curation/extraction are best-effort,
 * so we never throw (that would drop the whole batch) — redact-and-warn is the
 * right posture: a poisoned run can't persist a live secret, but the rest of the
 * (benign) payload still lands.
 *
 * Layer note: this lives in `core/` (NOT `_lib/`) precisely because it depends on
 * a `hooks/` module (secret-patterns.cjs). `_lib/` is a leaf layer restricted to
 * `../constants` (enforced by adr-parser.test.js's layering check); a module that
 * composes a hook belongs in `core/`, matching the existing core→hooks require in
 * memory-stability.js.
 */

const { scanContent, redactSecretsInText } = require('../hooks/secret-patterns.cjs');

/**
 * Scan `content` for secrets; if any are found, return a redacted copy and emit
 * a stderr warning naming the findings. Returns the content unchanged when clean.
 *
 * @param {string} content   The text about to be written (LLM output).
 * @param {string} filePath  Destination path (for finding messages / high-risk check).
 * @param {string} [logTag]  Prefix for the stderr warning; pass null to silence.
 * @returns {string}         Redacted content on a hit, else the original content.
 */
function redactSecretsForWrite(content, filePath, logTag = 'secret-safe-write') {
    // CONTENT findings only. `scanContent` also emits a `HIGH_RISK_FILE` finding
    // derived from the FILENAME alone (a `.key`/`.pem`/`.env*` destination), which
    // says nothing about the bytes being written — acting on it made every write to
    // such a path print "redacted N secret finding(s)" over provably clean content,
    // and `redactSecretsInText` (which is content-only) then changed nothing anyway.
    const findings = (scanContent(content, filePath) || []).filter(f => f.type === 'SECRET_PATTERN');
    if (findings.length === 0) return content;
    if (logTag) {
        const names = findings.map(f => f.name || f.type).join(', ');
        process.stderr.write(
            `[${logTag}] SECURITY: redacted ${findings.length} secret finding(s) from ` +
            `LLM output before writing ${filePath}: ${names}\n`
        );
    }
    // Same path as the scan above, so scan and redact apply the same source-file exemptions.
    return redactSecretsInText(content, filePath);
}

module.exports = { redactSecretsForWrite };
