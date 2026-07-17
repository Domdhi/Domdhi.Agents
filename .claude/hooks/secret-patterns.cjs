#!/usr/bin/env node

/**
 * Secret Patterns — Shared Module
 *
 * Provides secret detection patterns, scanning logic, and utility functions
 * shared between the pre-write secret scanner and the post-read scrubber.
 *
 * Used by:
 *   - secret-scanner.cjs (PreToolUse:Write/Edit + git pre-commit)
 *   - post-read-scrubber.cjs (PostToolUse:Read)
 */

const path = require('path');

// ============================================
// Secret Patterns (organized by category)
// ============================================

const PATTERNS = [

    // --- Cloud Providers ---
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|aws_secret)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
    { name: 'AWS Session Token', regex: /(?:aws_session_token|AWS_SESSION_TOKEN)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{100,}['"]?/g },
    { name: 'Azure Storage Key', regex: /AccountKey=[A-Za-z0-9+/=]{88}/g },
    { name: 'Azure Connection String', regex: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[^;]+/g },
    { name: 'Azure SAS Token', regex: /[?&]sig=[A-Za-z0-9%+/=]{43,}(?:&|$)/g },
    { name: 'GCP Service Account', regex: /"private_key":\s*"-----BEGIN [A-Z ]+ PRIVATE KEY-----/g },
    { name: 'GCP API Key', regex: /AIza[0-9A-Za-z_-]{35}/g },
    { name: 'Google OAuth Client Secret', regex: /GOCSPX-[A-Za-z0-9_-]{28}/g },
    { name: 'DigitalOcean PAT', regex: /dop_v1_[a-f0-9]{64}/g },
    { name: 'DigitalOcean OAuth', regex: /doo_v1_[a-f0-9]{64}/g },

    // --- Platform Tokens ---
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/g },
    { name: 'GitHub Fine-Grained PAT', regex: /github_pat_[A-Za-z0-9_]{22,255}/g },
    { name: 'GitLab PAT', regex: /glpat-[A-Za-z0-9\-_]{20,}/g },
    { name: 'Bitbucket App Password', regex: /ATBB[A-Za-z0-9]{32,}/g },
    { name: 'Atlassian API Token', regex: /ATATT3[A-Za-z0-9_\-=]{186}/g },
    { name: 'Slack Token', regex: /xox[bpors]-[0-9]+-[0-9]+-[A-Za-z0-9]+/g },
    { name: 'Slack App Token', regex: /xapp-[0-9]+-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]+/g },
    { name: 'Slack Webhook', regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
    { name: 'Discord Webhook', regex: /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g },

    // --- AI / LLM Keys ---
    { name: 'OpenAI Key', regex: /sk-(?!proj-|ant-)[A-Za-z0-9]{20,}/g },
    { name: 'OpenAI Project Key', regex: /sk-proj-[A-Za-z0-9_-]{40,}/g },
    { name: 'OpenAI Service Key', regex: /sk-svcacct-[A-Za-z0-9_-]{40,}/g },
    { name: 'Anthropic Key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g },
    { name: 'HuggingFace Token', regex: /hf_[A-Za-z]{34}/g },
    { name: 'HuggingFace Org Token', regex: /api_org_[A-Za-z]{34}/g },

    // --- Payment / SaaS ---
    { name: 'Stripe Key', regex: /[sr]k_(live|test)_[A-Za-z0-9]{24,}/g },
    { name: 'Square Access Token', regex: /sq0atp-[A-Za-z0-9_-]{22,}/g },
    { name: 'Square OAuth Secret', regex: /sq0csp-[A-Za-z0-9_-]{43,}/g },
    { name: 'Shopify Token', regex: /shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32,}/g },
    { name: 'CoinGecko API Key', regex: /\bCG-[A-Za-z0-9]{20,}\b/g },

    // --- CI/CD & DevOps ---
    { name: 'npm Token', regex: /npm_[A-Za-z0-9]{36}/g },
    { name: 'PyPI Token', regex: /pypi-[A-Za-z0-9_-]{100,}/g },
    { name: 'NuGet API Key', regex: /oy2[a-z0-9]{43}/g },
    { name: 'Docker Hub PAT', regex: /dckr_pat_[A-Za-z0-9_-]{27,}/g },
    { name: 'Grafana API Key', regex: /eyJrIjoi[A-Za-z0-9]{70,400}={0,3}/g },
    { name: 'Grafana Cloud Token', regex: /glc_[A-Za-z0-9+/]{32,400}={0,3}/g },
    { name: 'Grafana Service Token', regex: /glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}/g },
    { name: 'Databricks Token', regex: /dapi[a-f0-9]{32}/g },
    { name: 'Doppler Token', regex: /dp\.pt\.[A-Za-z0-9]{43}/g },
    { name: 'CircleCI Token', regex: /ccipat_[A-Za-z0-9]{40}/g },

    // --- Infrastructure & Monitoring ---
    { name: 'Hashicorp Vault Token', regex: /hvs\.[A-Za-z0-9_-]{24,}/g },
    { name: 'Hashicorp TF Token', regex: /[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9_-]{67}/g },
    { name: 'Cloudflare Origin CA', regex: /v1\.0-[a-f0-9]{24}-[a-f0-9]{146}/g },
    { name: 'Supabase Key', regex: /sbp_[a-f0-9]{40}/g },
    { name: 'Vercel Token', regex: /vercel_[A-Za-z0-9_-]{24,}/gi },
    { name: 'Linear API Key', regex: /lin_api_[A-Za-z0-9]{40}/g },
    { name: 'Postman API Key', regex: /PMAK-[a-f0-9]{24}-[a-f0-9]{34}/g },
    { name: 'Telegram Bot Token', regex: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g },

    // --- Communication ---
    { name: 'SendGrid Key', regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
    { name: 'Twilio Key', regex: /\bSK[0-9a-fA-F]{32}\b/g },
    { name: 'Mailgun Key', regex: /\bkey-[0-9a-zA-Z]{32}\b/g },

    // --- Auth Tokens ---
    { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: 'Bearer Token', regex: /[Bb]earer\s+[A-Za-z0-9_\-.~+/]{40,}=*/g },

    // --- Cryptographic Material ---
    { name: 'Private Key', regex: /-----BEGIN\s(?:RSA\s|EC\s|DSA\s|OPENSSH\s)?PRIVATE\sKEY-----/g },
    { name: 'PGP Private Key', regex: /-----BEGIN\sPGP\sPRIVATE\sKEY\sBLOCK-----/g },

    // --- Generic Credential Patterns ---
    { name: 'Password Assignment', regex: /(?:password|passwd|pwd)['"]?\s*[=:]\s*['"][^'"]{8,}['"]/gi },
    { name: 'Secret Assignment', regex: /(?:secret|api_?key|apikey|access_?key|auth_?token|client_?secret)['"]?\s*[=:]\s*['"][^'"]{8,}['"]/gi },
    // --- F76: Unquoted key=value / YAML key: value coverage ---
    // The quoted patterns above miss the most common real-world unquoted
    // forms: shell `export KEY=value`, .properties/.ini `key=value`, and
    // YAML `key: value`. Guarded against false-positive explosion by (1)
    // requiring a secret-ish key name (same keyword groups as above) and
    // (2) a minimum 8-char unquoted value (`\S{8,}`), so `count=5` / `name:
    // bob` never match. The negative lookahead excludes values that start
    // with a quote, `$`, `<`, or `{` — those are either already covered by
    // the quoted patterns above (avoids double-counting) or are a variable
    // reference / template placeholder, not a literal secret.
    // W2-3: the unquoted Password variant drops the `pwd` alias — an UNQUOTED
    // `pwd=/some/path` is the present-working-dir env var (an env-dump line),
    // never a password. `pwd` stays in the QUOTED Password Assignment above,
    // where `pwd='…8+…'` is unambiguously a credential. (No leading `\b` here:
    // a word boundary fails between `_` and the keyword, which would break the
    // extremely common `DB_PASSWORD=` / `MY_SECRET=` underscore-prefixed forms.)
    { name: 'Password Assignment (Unquoted)', regex: /(?:password|passwd)\s*[=:]\s*(?!['"$<{])(\S{8,})/gi },
    { name: 'Secret Assignment (Unquoted)', regex: /(?:secret|api_?key|apikey|access_?key|auth_?token|client_?secret)\s*[=:]\s*(?!['"$<{])(\S{8,})/gi },
    { name: 'Connection String', regex: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^\s'"]{1,256}:[^\s'"]{1,256}@[^\s'"]{1,2000}/gi },
    { name: 'Database URL', regex: /DATABASE_URL\s*=\s*['"]?[^\s'"]+:\/\/[^\s'"]+/gi },
];

// ============================================
// Placeholder / Dummy Value Allowlist
// ============================================

const PLACEHOLDER_PATTERNS = [
    /^['"]?(?:changeme|password|example|test(?:ing)?|dummy|placeholder|xxx+|sample|default)['"]?$/i,
    /^['"]?(?:your[_-]?(?:key|token|secret|password|api[_-]?key)|TODO|REPLACE[_-]?ME|INSERT[_-]?HERE)['"]?$/i,
    // Known dummy-word prefix + short suffix: test-123, mock-key, sample_abc, example-key.
    // This only suppresses the GENERIC Secret/Password Assignment findings — named-provider
    // secrets (AWS/Stripe/Anthropic/GitHub/GCP/private keys) have dedicated PATTERNS entries
    // that bypass this allowlist entirely, so they always block regardless of prefix.
    // The dummy-word prefix is a naming-convention gate, NOT an entropy control; the ≤8-char
    // suffix cap is what keeps a generic high-entropy secret from slipping through (every real
    // placeholder — test-123, mock-key, example-key — has a tiny suffix). Residual accepted
    // gap: a ≤8-char low-entropy generic value with a dummy prefix.
    /^['"]?(?:test(?:ing)?|mock|fake|sample|example|dummy|placeholder)[-_][a-z0-9][a-z0-9_-]{0,7}['"]?$/i,
    /^['"]?<[^>]+>['"]?$/,                  // <your-key-here>
    /^['"]?\{[^}]+\}['"]?$/,                // {placeholder}
    /^['"]?\$\{[^}]+\}['"]?$/,              // ${VARIABLE}
    /^['"]?\$[A-Z_]+['"]?$/,                // $ENV_VAR
    // VAULT:Provider:Key — a vault-reference placeholder (e.g. a config provider
    // that resolves it against an encrypted store at startup). The literal is a
    // POINTER to a secret, not the secret itself; config files are expected to
    // hold it. (Harvested from an adopter's SecretsVault convention, 2026-07.)
    /^['"]?VAULT:[A-Za-z0-9_]+:[A-Za-z0-9_]+['"]?$/,
];

function isPlaceholderValue(matched) {
    const valueMatch = matched.match(/[=:]\s*['"]?(.+?)['"]?\s*$/);
    if (!valueMatch) return false;
    const value = valueMatch[1];
    return PLACEHOLDER_PATTERNS.some(p => p.test(value));
}

// Known documented example/placeholder LITERALS for named-provider patterns —
// e.g. AWS's own `AKIAIOSFODNN7EXAMPLE`, published in AWS's docs and reused
// verbatim across countless SDK test fixtures. Unlike PLACEHOLDER_PATTERNS
// (a shape/prefix match), this is an EXACT-value allowlist: a plausible but
// different AWS-shaped key must still block. Consulted only in
// `namedProvidersOnly` (test-file) mode — see scanContent — so a real secret
// in application code is never exempted just for sharing a pattern name.
const NAMED_PROVIDER_PLACEHOLDER_VALUES = {
    'AWS Access Key': new Set(['AKIAIOSFODNN7EXAMPLE']),
};

function isNamedProviderPlaceholder(patternName, matched) {
    const known = NAMED_PROVIDER_PLACEHOLDER_VALUES[patternName];
    return !!known && known.has(matched);
}

// A connection-string / DATABASE_URL credential is a documentation example —
// not a leaked secret — when its PASSWORD is an obvious placeholder, the whole
// userinfo is a template (`<USER>:<PASSWORD>`, `${VAR}`, `{x}`), or there are no
// embedded credentials at all (`sqlite:///path`, `redis://localhost:6379`).
// Keyed on the password (the secret) — a real-looking password still blocks even
// next to a placeholder username, so this can't be used to smuggle a credential.
const CONN_PLACEHOLDER_TOKEN = /^(?:user(?:name)?|pass(?:word|wd)?|pwd|secret|changeme|example|test(?:ing)?|dummy|placeholder|sample|default|xxx+|<[^>]+>|\{[^}]+\}|\$\{[^}]+\}|\$[A-Z_]+)$/i;
const CONN_USERINFO_TEMPLATE = /^(?:<[^>]+>|\{[^}]+\}|\$\{[^}]+\})(?::(?:<[^>]+>|\{[^}]+\}|\$\{[^}]+\}))?$/;

function isPlaceholderConnString(matched) {
    const creds = matched.match(/:\/\/([^@\s'"]*)@/);
    if (!creds) return true;                 // no embedded credentials → nothing to leak
    const userinfo = creds[1];
    if (CONN_USERINFO_TEMPLATE.test(userinfo)) return true;
    const ci = userinfo.indexOf(':');
    const password = ci >= 0 ? userinfo.slice(ci + 1) : '';
    return CONN_PLACEHOLDER_TOKEN.test(password);
}

// ============================================
// High-Risk File Detection
// ============================================

const HIGH_RISK_BASENAMES = [
    /^\.env$/,
    /^\.env\..+$/,
    /^credentials\.json$/,
    /^service[_-]?account\.json$/,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
    /\.jks$/,
    /^id_rsa$/,
    /^id_ed25519$/,
    /\.keystore$/,
    /^\.htpasswd$/,
    /^\.npmrc$/,
    /^\.pypirc$/,
    /^\.netrc$/,
    /^\.pgpass$/,
    /^\.my\.cnf$/,
    /^\.s3cfg$/,
    /^\.boto$/,
    /^terraform\.tfvars$/,
    /^\.terraform\.tfvars$/,
    /^credentials$/,
];

const HIGH_RISK_PATHS = [
    /\.docker\/config\.json$/,
    /\.kube\/config$/,
];

// HARD_SKIP_PATTERNS — never scanned, full stop. These are the scanner's own
// source, git/package-manager internals, and lockfiles: paths where a "secret"
// match is either the scanner's own pattern literals or noise, never a real
// credential worth gating on.
const HARD_SKIP_PATTERNS = [
    /secret-scanner\.cjs$/,
    /secret-patterns\.cjs$/,
    /post-read-scrubber\.cjs$/,
    // NOTE: .claude/skills/ and .claude/templates/ are deliberately NOT skipped.
    // .claude/ is exactly what publishes to every fleet adopter, so a secret
    // authored into a SKILL.md, a skill asset, or a template config must be
    // scanned — the same blind-spot class as the removed docs/.output/ skip
    // (a live key once leaked through that hole). A secret-authoring skill whose
    // example text trips a generic pattern should rely on the placeholder
    // allowlist, NOT a subtree-wide exemption.
    /node_modules\//,
    /\.git\//,
    // NOTE: docs/.output/ is deliberately NOT skipped. It holds generated
    // reviews/digests/handoffs that routinely quote config — the single most
    // likely place to echo a real secret (a /review:security report writing
    // into docs/.output/findings/reviews/ is exactly how a live CoinGecko key once
    // leaked past this scanner). Hook-internal writes (telemetry, memories)
    // go through fs, not the Write tool, so they bypass the PreToolUse scan
    // regardless; only Claude-authored Write/Edit + staged-commit content is
    // scanned here, which is precisely what we want covered.
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
];

// TEST_FILE_PATTERNS — test/spec fixtures. These are NOT hard-skipped: a real
// provider secret (AWS/Anthropic/GitHub/Stripe/private key/etc.) pasted into a
// test file is exactly as leaked as one in application code, so it must still
// be caught. What test files legitimately contain is GENERIC fixture noise —
// `password = "hunter2"`, `apiKey = "test-secret-value"` — that trips the
// generic Password/Secret Assignment patterns as false positives. Callers use
// `isTestFilePath` to run scanContent in `namedProvidersOnly` mode for these
// paths (named-provider patterns still fire; only the generic-assignment
// patterns are suppressed), rather than skipping the file wholesale.
const TEST_FILE_PATTERNS = [
    /__test__\//,
    /__tests__\//,
    /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
    /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
];

// Backward-compatible union — existing consumers (post-read-scrubber.cjs) that
// only need a single "skip or not" boolean keep their current behavior.
const SKIP_PATHS = [...HARD_SKIP_PATTERNS, ...TEST_FILE_PATTERNS];

// GENERIC_PATTERN_NAMES — the fixture-prone generic assignment patterns (as
// opposed to a named-provider pattern like 'AWS Access Key' or 'Anthropic
// Key', which has a distinctive-enough shape that a false positive in a test
// file is vanishingly unlikely). Shared by the test-file scan mode (which
// suppresses only these) and by `redact` (which locks down real bytes harder
// for everything NOT in this set).
const GENERIC_PATTERN_NAMES = new Set([
    'Password Assignment',
    'Secret Assignment',
    'Password Assignment (Unquoted)',
    'Secret Assignment (Unquoted)',
]);

function isGenericPatternName(name) {
    return GENERIC_PATTERN_NAMES.has(name);
}

// ============================================
// Scanner Core
// ============================================

function shouldSkipPath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return SKIP_PATHS.some(pattern => pattern.test(normalized));
}

// Hard-skip only (scanner internals, VCS/package-manager plumbing, lockfiles).
// Unlike shouldSkipPath, this deliberately excludes test/spec files — a caller
// checks isTestFilePath separately to decide the named-providers-only mode.
function isHardSkipPath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return HARD_SKIP_PATTERNS.some(pattern => pattern.test(normalized));
}

function isTestFilePath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return TEST_FILE_PATTERNS.some(pattern => pattern.test(normalized));
}

function isHighRiskFile(filePath) {
    const basename = path.basename(filePath);
    const normalized = filePath.replace(/\\/g, '/');
    return HIGH_RISK_BASENAMES.some(p => p.test(basename))
        || HIGH_RISK_PATHS.some(p => p.test(normalized));
}

/**
 * @param {string} content
 * @param {string} filePath
 * @param {{ namedProvidersOnly?: boolean }} [options] - when `namedProvidersOnly`
 *   is true (test/spec files — see isTestFilePath), the generic Password/Secret
 *   Assignment patterns are skipped entirely (they false-positive on fixture
 *   noise like `password = "hunter2"`); every named-provider pattern (AWS,
 *   Anthropic, GitHub, Stripe, private keys, etc.) still runs unchanged, except
 *   for an exact-value match against a documented example literal (see
 *   NAMED_PROVIDER_PLACEHOLDER_VALUES, e.g. AWS's `AKIAIOSFODNN7EXAMPLE`) —
 *   those are exempted here too, since SDK test fixtures routinely reuse the
 *   provider's own published example key. Optional and defaults to false —
 *   existing callers (post-read-scrubber.cjs, commit.js) are unaffected.
 */
function scanContent(content, filePath, options) {
    const { namedProvidersOnly = false } = options || {};
    const findings = [];

    // Coerce non-string content so a legitimate but non-string payload (a numeric
    // or object `content` / `new_string` in a tool event) still gets scanned
    // instead of throwing `content.split is not a function`. Uncaught, that throw
    // failed the hook OPEN (exit 1 = non-blocking) and let the write through
    // unscanned. The scanner's runClaudeHook also fail-closes on any throw; this
    // coercion means legitimate non-string content is scanned rather than blocked.
    if (typeof content !== 'string') content = String(content ?? '');

    if (filePath && isHighRiskFile(filePath)) {
        findings.push({
            type: 'HIGH_RISK_FILE',
            name: 'Sensitive file type',
            file: filePath,
            line: 0,
            match: path.basename(filePath),
        });
    }

    // NOTE (documented limitation, matches secret-scanner.cjs's header):
    // matching is line-by-line against `content.split('\n')`, so a secret that
    // is split across multiple lines/concatenated strings, or that is
    // base64/hex-encoded (and therefore doesn't match a pattern's literal
    // shape), will not be detected. Left as-is — not fixed here.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of PATTERNS) {
            if (namedProvidersOnly && isGenericPatternName(pattern.name)) continue;

            const matches = line.matchAll(pattern.regex);
            for (const match of matches) {
                if (isGenericPatternName(pattern.name) && isPlaceholderValue(match[0])) {
                    continue;
                }
                if (namedProvidersOnly && !isGenericPatternName(pattern.name) &&
                    isNamedProviderPlaceholder(pattern.name, match[0])) {
                    continue;
                }
                if ((pattern.name === 'Connection String' ||
                    pattern.name === 'Database URL') &&
                    isPlaceholderConnString(match[0])) {
                    continue;
                }

                findings.push({
                    type: 'SECRET_PATTERN',
                    name: pattern.name,
                    file: filePath || '<stdin>',
                    line: i + 1,
                    match: redact(match[0], pattern.name),
                });
            }
        }
    }

    return findings;
}

/**
 * @param {string} value - the matched secret text
 * @param {string} [patternName] - the PATTERNS entry name that matched. When
 *   given and it's a named-provider pattern (i.e. NOT one of
 *   GENERIC_PATTERN_NAMES), the real secret bytes are never emitted — only the
 *   provider name and length — since a named-provider match (AWS/Anthropic/
 *   GitHub/Stripe/private key/etc.) is a real, valuable credential where even a
 *   partial leak (the previous first-8+last-4) is worth avoiding. Omitting
 *   patternName (or passing a generic name) preserves the original
 *   head+mask/head+tail behavior for backward compatibility.
 */
function redact(value, patternName) {
    if (patternName && !isGenericPatternName(patternName)) {
        return `[REDACTED:${patternName} len=${value.length}]`;
    }
    if (value.length <= 12) return value.substring(0, 4) + '***';
    return value.substring(0, 8) + '...' + value.substring(value.length - 4);
}

/**
 * Replace every detected secret in `content` with a `<REDACTED:PatternName>`
 * marker. Used by post-read-scrubber.cjs to rewrite tool output before Claude
 * sees it (PostToolUse `hookSpecificOutput.updatedToolOutput`).
 *
 * Same placeholder filter as scanContent — Password/Secret Assignment matches
 * whose value is a known placeholder (changeme, ${VAR}, etc.) are NOT redacted.
 *
 * Pattern ordering: PATTERNS is iterated in declaration order; each pattern
 * does a global replaceAll. Once a match is wrapped in `<REDACTED:...>`, later
 * patterns won't re-match the marker text. Test case
 * `redactSecretsInText_multipleSecrets_allReplaced` pins this.
 *
 * @param {string} content - Original tool output to scan and redact
 * @returns {string} Content with detected secrets replaced; unchanged if no findings
 */
function redactSecretsInText(content) {
    if (!content) return content;

    let result = content;
    for (const pattern of PATTERNS) {
        // Reset regex state — patterns are declared with /g, which carries
        // lastIndex across calls if reused. Use replaceAll with a fresh regex
        // built from the source to avoid lastIndex pitfalls.
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        result = result.replace(re, (match) => {
            // Same placeholder filter scanContent uses for these patterns
            if (isGenericPatternName(pattern.name) && isPlaceholderValue(match)) {
                return match;
            }
            if ((pattern.name === 'Connection String' ||
                 pattern.name === 'Database URL') &&
                isPlaceholderConnString(match)) {
                return match;
            }
            return `<REDACTED:${pattern.name}>`;
        });
    }
    return result;
}

function formatFindings(findings) {
    if (findings.length === 0) return null;

    const lines = [
        '',
        '========================================',
        '  SECRET SCANNER — FINDINGS',
        '========================================',
        '',
    ];

    for (const f of findings) {
        const loc = f.line > 0 ? `:${f.line}` : '';
        lines.push(`  [${f.type}] ${f.name}`);
        lines.push(`    File:  ${f.file}${loc}`);
        lines.push(`    Match: ${f.match}`);
        lines.push('');
    }

    lines.push('----------------------------------------');
    lines.push(`  ${findings.length} potential secret(s) detected.`);
    lines.push('  Remove secrets before proceeding.');
    lines.push('  Use environment variables or a secret manager instead.');
    lines.push('========================================');

    return lines.join('\n');
}

// ============================================
// Stdin reader (shared utility)
// ============================================

// Wave 5 (F1): both consumers previously read stdin with NO timeout at all —
// a wedged pipe would hang the blocking Write/Edit tool call forever. Every
// other blocking hook was bounded at 5000ms in this same wave, but that fix
// can't be copy-pasted here: those hooks fail OPEN on a timeout (resolve with
// whatever partial data arrived, proceed as best-effort), which is fine for
// advisory/logic hooks but wrong for a secret scanner — a truncated payload
// must never be silently treated as "nothing to scan" and allowed through.
//
// `failClosedOnTimeout` (used only by secret-scanner.cjs's PreToolUse gate)
// makes a timeout or stream error REJECT instead of resolving with partial
// data, so the caller can block the write (exit 2) rather than risk scanning
// truncated content. post-read-scrubber.cjs (a best-effort POST-hook that
// can't block the tool call that already ran) keeps the default resolve-with-
// partial-data behavior — same as before, just now bounded instead of
// unbounded. 10000ms (not the 5000ms ceiling used elsewhere) because these
// two hooks scan whole file contents, which can be larger than a typical
// hook payload. Env override exists ONLY so tests can shrink the wait for a
// real spawned-process timeout test without changing production behavior —
// same pattern as MEMORY_MAX_PER_CATEGORY (static-constants-env-override-at-callsite).
const DEFAULT_STDIN_TIMEOUT_MS = parseInt(process.env.SECRET_SCANNER_STDIN_TIMEOUT_MS, 10) || 10000;
function readStdin({ failClosedOnTimeout = false, timeoutMs = DEFAULT_STDIN_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) { resolve(''); return; }

        let data = '';
        let settled = false;
        const finish = (ok, value) => {
            if (settled) return;
            settled = true;
            ok ? resolve(value) : reject(value);
        };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => finish(true, data));
        process.stdin.on('error', (err) => {
            if (failClosedOnTimeout) finish(false, err instanceof Error ? err : new Error(String(err)));
            else finish(true, '');
        });

        setTimeout(() => {
            if (failClosedOnTimeout) {
                finish(false, new Error(`stdin read did not complete within ${timeoutMs}ms`));
            } else {
                finish(true, data);
            }
        }, timeoutMs);
    });
}

module.exports = {
    PATTERNS,
    PLACEHOLDER_PATTERNS,
    SKIP_PATHS,
    HARD_SKIP_PATTERNS,
    TEST_FILE_PATTERNS,
    GENERIC_PATTERN_NAMES,
    HIGH_RISK_BASENAMES,
    HIGH_RISK_PATHS,
    isPlaceholderValue,
    isPlaceholderConnString,
    NAMED_PROVIDER_PLACEHOLDER_VALUES,
    isNamedProviderPlaceholder,
    isGenericPatternName,
    shouldSkipPath,
    isHardSkipPath,
    isTestFilePath,
    isHighRiskFile,
    scanContent,
    redact,
    redactSecretsInText,
    formatFindings,
    readStdin,
};
