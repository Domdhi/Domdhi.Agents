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

// Value shapes that are a lookup of a runtime binding, written WITHOUT anchors
// or quote wrappers (PLACEHOLDER_PATTERNS below anchors and quote-wraps each).
// `IDENT` is a dotted receiver chain (`process.`, `context.cloudflare.`,
// `import.meta.`); `UPPER` is an env-var name; `KEY` is a configuration key
// (`Graph:ClientSecret`). Trailing `,` `;` `)` come from the surrounding code.
const REFERENCE_IDENT = String.raw`(?:[A-Za-z_$][\w$]*\.)*`;
const REFERENCE_UPPER = String.raw`[A-Z][A-Z0-9_]*`;
const REFERENCE_KEY = String.raw`[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*`;
const REFERENCE_TAIL = String.raw`[,;)]*`;
const REFERENCE_VALUE_SHAPES = [
    // env.X, process.env.X, import.meta.env.X, context.cloudflare.env.X
    new RegExp(REFERENCE_IDENT + String.raw`env\.` + REFERENCE_UPPER + REFERENCE_TAIL),
    // process.env['X'], os.environ["X"]
    new RegExp(REFERENCE_IDENT + String.raw`(?:env|environ)\[['"]` + REFERENCE_UPPER + String.raw`['"]\]` + REFERENCE_TAIL),
    // Deno.env.get("X"), os.environ.get('X') — one argument only, no default
    new RegExp(REFERENCE_IDENT + String.raw`(?:env|environ)\.get\(['"]` + REFERENCE_UPPER + String.raw`['"]\)` + REFERENCE_TAIL),
    // os.getenv("X"), System.getenv("X"), getenv("X")
    new RegExp(String.raw`(?:(?:os|System)\.)?getenv\(['"]` + REFERENCE_UPPER + String.raw`['"]\)` + REFERENCE_TAIL),
    // Environment.GetEnvironmentVariable("X")
    new RegExp(REFERENCE_IDENT + String.raw`GetEnvironmentVariable\(['"][A-Za-z_][A-Za-z0-9_]*['"]\)` + REFERENCE_TAIL),
    // builder.Configuration["Section:Key"]
    new RegExp(REFERENCE_IDENT + String.raw`(?:Configuration|configuration|config|Config)\[['"]` + REFERENCE_KEY + String.raw`['"]\][,;)!]*`),
    // config.GetValue<string>("Section:Key"), configuration.GetRequiredValue<T>("K")
    new RegExp(REFERENCE_IDENT + String.raw`(?:Configuration|configuration|config|Config)\.(?:GetValue|GetRequiredValue)(?:<[\w.?]+>)?\(['"]` + REFERENCE_KEY + String.raw`['"]\)[,;)!]*`),
    // GitHub Actions expression: ${{ secrets.X }}, ${{ vars.X }}, ${{ env.X }}
    new RegExp(String.raw`\$\{\{\s*(?:secrets|vars|env)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}`),
    // Azure DevOps macro: $(VariableName)
    new RegExp(String.raw`\$\([A-Za-z_][A-Za-z0-9_.]*\)`),
    // Windows batch / MSBuild-style: %VAR%
    new RegExp(String.raw`%[A-Za-z_][A-Za-z0-9_]*%`),
    // App Service / Functions Key Vault reference: @Microsoft.KeyVault(SecretUri=https://...)
    new RegExp(String.raw`@Microsoft\.KeyVault\((?:SecretUri|VaultName)=[^()\s'"]+(?:;[A-Za-z]+=[^()\s'"]+)*\)`),
];

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
    // env(VAR_NAME) — Supabase's config.toml variable-indirection syntax, e.g.
    // `openai_api_key = "env(OPENAI_API_KEY)"`. Same class as ${VAR} and VAULT:
    // above: the literal is the NAME of an environment variable, and the actual
    // secret is resolved from the environment at startup — so the file is
    // EXPECTED to contain it, and flagging it trains people to bypass the
    // scanner on a file that legitimately needs to change.
    // Charset is deliberately [A-Z0-9_] only (env-var naming convention, and it
    // matches every real occurrence in supabase/config.toml): a real credential
    // is mixed-case/high-entropy, so it cannot be smuggled through this shape.
    // (Harvested 2026-07-19 — this fired 4× on supabase/config.toml during a
    // ports-only change where none of the 4 lines were even modified.)
    /^['"]?env\([A-Z0-9_]+\)['"]?$/,
    // --- Runtime-binding REFERENCES (the whole value is a lookup, never a literal) ---
    // `coingeckoApiKey: env.COINGECKO_API_KEY,`, `secret: process.env.X;`,
    // `apiKey: Environment.GetEnvironmentVariable("X")`, `Configuration["A:B"]`,
    // `${{ secrets.X }}`, `$(X)`, `%X%`. The value only NAMES where the secret is
    // read from at runtime, so flagging it fires on every helper that forwards a
    // binding and trains people to bypass the scanner. Each shape is anchored to
    // the WHOLE value and takes at most ONE string argument that must itself be a
    // plain variable/key name (no default value, no second argument), so a
    // literal credential cannot ride them: `os.environ.get("X", "literal")`,
    // `Foo.get("<secret>")`, `env.X_<secret-suffix>` and every quoted literal
    // still block. (Harvested 2026-10-11 from an adopter project where the
    // `env.X` form fired on three server files; the other shapes are the same
    // class in supported stacks: Node/Cloudflare, Python, .NET, GitHub
    // Actions, Azure DevOps and App Service Key Vault references.)
    // A reference may also sit in inline code (`password: \`env.DB_PASS\``), as it does in
    // markdown prose and config docs, so the wrapper accepts backticks as well as quotes.
    ...REFERENCE_VALUE_SHAPES.map(shape => new RegExp('^[\'"`]?(?:' + shape.source + ')[\'"`]?$')),
];

function isPlaceholderValue(matched) {
    const valueMatch = matched.match(/[=:]\s*['"]?(.+?)['"]?\s*$/);
    if (!valueMatch) return false;
    const value = valueMatch[1];
    return PLACEHOLDER_PATTERNS.some(p => p.test(value));
}

// ============================================
// Source-Code Reference Allowlist
// ============================================
//
// The UNQUOTED Password/Secret Assignment patterns exist to catch opaque
// credentials in .env / shell / config files (`API_KEY=sk_live_9f3a…`). In
// application SOURCE, the same `name = value` shape is overwhelmingly a READ of
// a secret rather than a literal — and a read is the correct, desired way to
// handle one:
//
//     const password  = String(body.password ?? "");   // request body
//     const authToken = c.env.TWILIO_AUTH_TOKEN;       // binding
//     const secret    = c.req.header("x-admin-secret");// request header
//     apiKey: encryptedKey ?? (cfg.apiKey as string)   // identifier / expression
//
// Flagging these tells a developer to "remove the secret" from code that
// contains no secret, and — worse — fires on every commit that merely STAGES
// the file, on lines the commit never touched. That trains people to reach for
// --no-scan, which is how a real finding eventually gets waved through. Killing
// this false-positive class is a security improvement, not a relaxation.
//
// SCOPE, deliberately narrow (each rule closes a hole found by adversarial review):
//   - Consulted ONLY for the generic Password/Secret Assignment patterns
//     (see isGenericPatternName). Every named-provider pattern — AWS, Stripe,
//     Anthropic, GitHub, GCP, private-key blocks — bypasses this entirely.
//   - SOURCE-CODE files only (CODE_SOURCE_PATH). In a `.env`, `.yaml`, `.ini`,
//     `.json` or `.md` file an unquoted `name = value` carries a real value.
//   - The unquoted regexes capture `\S{8,}`, which stops at the first space, so a
//     guard that looks only at the capture is blind to the rest of the line
//     (`decrypt(blob, "aB3x…")`, `Foo.get( "aB3x…" )`). Every check therefore runs on
//     complete assigned expression from the match offset (never `indexOf(matched)`,
//     which finds an earlier identical text on an exempt line). Top-level siblings
//     are separate assignments, but commas inside calls or objects remain in scope.
//   - Formatter-style assignments only (`name = value`, `name: value`, with
//     whitespace). `NAME=value && cmd` is shell syntax, so a command string in a
//     source file cannot borrow the expression-context proof.
//   - Never inside a string or a comment: an odd quote count before the match, or a
//     `//`, `/*`, `#` before it, means the line is data or prose, not an expression.
//   - Never an opaque token: a 16+ character alphanumeric run with a digit anywhere in
//     the expression (hasOpaqueRun), or a quoted literal in it that is not an
//     identifier-like name (`""`, `x-admin-secret`, `TWILIO_AUTH_TOKEN`). So
//     `bcrypt.hashSync("Winter2024Pass", 10)` and `Foo.get("aB3x…")` still block.
//   - A bare identifier (`encryptedKey`) is not self-evidently code: a real credential
//     has the same character class. It is accepted only when the line proves it is an
//     expression (a following `??`, `||`, `&&`, `;`, `,`, `)`, `]`, `}` or `as`) and it contains
//     no digit.
const CODE_REFERENCE_PATTERNS = [
    // Property access / namespaced read: c.env.X, process.env.X, cfg.apiKey. Every
    // segment starts with a letter, so `Summer.2024.x` and a dotted token do not match.
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+[;,)]?$/,
    // Function call: String(...), c.req.header("…"), getSecret(). The callee has no
    // digit, so `Summer2024(!)` (a password that ends in a parenthesis) is not a call.
    /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$]+)*\(/,
];

const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXPRESSION_CONTINUATION = /^\s*(?:\?\?|\|\||&&|[;,)\]}]|as\s)/;

// Source-code file types, where an unquoted value is a language expression.
const CODE_SOURCE_PATH = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|cs|php|swift|scala|c|cc|cpp|h|hpp)$/i;
const SCRIPT_SOURCE_PATH = /\.[cm]?[jt]sx?$/i;
const TS_SOURCE_PATH = /\.[cm]?tsx?$/i;
const TS_DECLARATION_PATH = /\.d\.[cm]?ts$/i;

function normalizePath(filePath) {
    return typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : '';
}

// A 16+ character alphanumeric run containing a digit looks like a credential, not an
// identifier or a header name (`x-admin-secret`, `TWILIO_AUTH_TOKEN`: every run is short).
function hasOpaqueRun(value) {
    return (value.match(/[A-Za-z0-9]{16,}/g) || []).some(run => /\d/.test(run));
}

// Callees whose quoted argument is a NAME looked up at runtime (a header, an environment
// variable, a module), never a value. A lower-case word with no separator is accepted only
// directly inside one of these: `bcrypt.hashSync("letmeinplease", 10)` and `hash("password")`
// have the same shape as `x-admin-secret` and must still block.
const NAME_LOOKUP_CALLEE = /\b(?:header|headers|get|getenv|getSecret|env|environ|require|import|param|query|cookie)\s*\(\s*$/;

// Every quoted literal in `text` (the complete assigned expression) must be empty or a
// plain name: a kebab/snake header or key name (`x-admin-secret`), an UPPER_SNAKE environment
// name (`TWILIO_AUTH_TOKEN`), or a separator-free lower-case word directly inside a
// name-lookup callee. Anything else (a mixed-case or digit-bearing word, a bare word passed to
// an arbitrary function) is credential-shaped and defeats the exemption.
function quotedLiteralsAreNames(text) {
    for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
        const body = m[2];
        if (body === '') continue;
        if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(body) && !/\d/.test(body)) continue;
        if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(body)) continue;
        if (/^[a-z][a-z-]*$/.test(body) && NAME_LOOKUP_CALLEE.test(text.slice(0, m.index))) continue;
        return false;
    }
    return true;
}

// The text before the match is inside a string literal or a comment. The test is per line,
// so a multi-line template literal or docstring is invisible to it: a dotted lower-case
// reference inside one is still exempt. That residual is accepted (the value must be a
// digit-free identifier or a property access, never an opaque token).
function insideStringOrComment(before) {
    if (/\/\/|\/\*|^\s*\*|(?:^|\s)#/.test(before)) return true;
    for (const quote of ["'", '"', '`']) {
        if ((before.split(quote).length - 1) % 2 === 1) return true;
    }
    return false;
}

// Locate one complete RHS without borrowing text from a sibling property, argument or
// statement. The regex capture alone stops at whitespace and can include the delimiter
// (`password,`), while the entire line includes unrelated literals such as a timeout.
// Only balanced delimiters are accepted; an incomplete call/string or unknown slash
// syntax keeps the finding. Nested commas and quoted delimiters never terminate an RHS.
function assignedExpression(tail) {
    const stack = [];
    const pairs = { ')': '(', ']': '[', '}': '{' };
    let quote = null;
    for (let i = 0; i < tail.length; i++) {
        const char = tail[i];
        if (quote !== null) {
            if (char === '\\') { i++; continue; }
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        // Regex literals and comments need their own grammar; never guess an exemption.
        if (char === '/') return null;
        if (char === '(' || char === '[' || char === '{') {
            stack.push(char);
        } else if (Object.hasOwn(pairs, char)) {
            if (stack.length === 0) return { text: tail.slice(0, i), boundary: char };
            if (stack.pop() !== pairs[char]) return null;
        } else if (stack.length === 0 && (char === ',' || char === ';')) {
            return { text: tail.slice(0, i), boundary: char };
        }
    }
    return quote === null && stack.length === 0 ? { text: tail, boundary: '' } : null;
}

function sourceAssignedExpression(tail, filePath) {
    // A comma can be part of an unparenthesized tuple in other supported languages.
    // Only JavaScript/TypeScript receive the sibling-boundary exemption; retain the
    // previous conservative full-line check for other source grammars.
    return SCRIPT_SOURCE_PATH.test(normalizePath(filePath))
        ? assignedExpression(tail)
        : { text: tail, boundary: '' };
}

/**
 * True when the assigned VALUE is a source-code expression (a read of a secret)
 * rather than a literal credential. Only ever consulted for the generic
 * Password/Secret Assignment patterns — every named-provider pattern bypasses
 * this entirely.
 *
 * @param matched  the regex match (e.g. `authToken = c.env.TWILIO_AUTH_TOKEN;`)
 * @param line     the full source line containing the match
 * @param filePath path of the file being scanned; anything but a source-code path (or an
 *                 unknown one) is never exempted
 * @param offset   index of the match within `line`
 */
function isCodeReferenceValue(matched, line, filePath, offset) {
    if (!CODE_SOURCE_PATH.test(normalizePath(filePath))) return false;
    if (typeof matched !== 'string' || typeof line !== 'string' || !Number.isInteger(offset)) return false;
    if (insideStringOrComment(line.slice(0, offset))) return false;

    // The assignment operator, in formatter style: `name = value` or `name: value`.
    const sep = matched.search(/[=:]/);
    if (sep === -1) return false;
    const spaced = matched[sep] === ':'
        ? /\s/.test(matched[sep + 1] || '')
        : /\s/.test(matched[sep - 1] || '') && /\s/.test(matched[sep + 1] || '');
    if (!spaced) return false;

    const expression = sourceAssignedExpression(line.slice(offset + sep + 1), filePath);
    if (!expression) return false;
    const value = expression.text.trim();
    if (!value || /^['"`]/.test(value)) return false;
    if (hasOpaqueRun(value) || !quotedLiteralsAreNames(value)) return false;

    const firstToken = value.match(/^\S+/)[0];
    if (CODE_REFERENCE_PATTERNS.some(p => p.test(firstToken))) return true;
    if (BARE_IDENTIFIER.test(firstToken) && !/\d/.test(firstToken)) {
        return EXPRESSION_CONTINUATION.test(value.slice(firstToken.length) + expression.boundary);
    }
    return false;
}

// ============================================
// TypeScript Type-Annotation Allowlist
// ============================================
//
// A TypeScript type-member DECLARATION holds no value:
//
//     interface Creds { password: SomeComponentResult; }
//
// The unquoted generic patterns read `name: value` as an assignment, so any
// interface/type member whose name contains a secret keyword matches — and the
// value it "leaks" is a type name. This is not hypothetical noise: Cloudflare's
// `wrangler types` emits a URL-component interface with exactly this shape, so
// EVERY regeneration of a generated .d.ts blocks the commit. Worse, the scanner
// reads whole staged files rather than diffs, so a pre-existing declaration
// re-flags on any commit that merely restages the file at a new line number.
//
// SCOPE, deliberately narrow:
//   - Consulted ONLY for the generic Password/Secret Assignment patterns.
//   - Declaration context only. In a `.d.ts` every member is a declaration; in a
//     `.ts`/`.tsx`/`.mts` file the line must sit inside an `interface` or `type`
//     block (typeBlockMask). A `key: value` line elsewhere in TypeScript source can be
//     a template literal that renders YAML or an env file, which carries real values.
//   - The type expression must START with an identifier character and holds no quote
//     or digit-led token, and plain words must not be separated by whitespace alone
//     (`password: correct horse battery staple` is a passphrase, not a type).
//   - Never a credential-shaped run (hasOpaqueRun), and lines over 400 characters are
//     never type members.
const TS_TYPE_MEMBER =
    /^\s*(?:(?:readonly|declare|export|public|private|protected|static|abstract)\s+)*(?:\[[^\]]+\]|['"`][^'"`]+['"`]|[A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>.,[\]|&\s]*[;,]?[ \t\r]*$/;
const TYPE_KEYWORDS = /\b(?:keyof|typeof|extends|infer|readonly|unique|new|in|is|as)\b/g;
const TYPE_BLOCK_OPENER = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s|type\s+[A-Za-z_$])/;

// Marks the lines that sit inside an `interface`/`type` block (the opener line itself
// is not marked). Brace counting is crude by design: string literals and `//` comments are
// blanked first so a brace inside one cannot leave a block open, and a miss only ever means
// "not exempt". The `cat -n` gutter is stripped so Read output is judged like the file.
function typeBlockMask(lines) {
    const mask = new Array(lines.length).fill(false);
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/^\s*\d+\t/, '');
        if (depth > 0) mask[i] = true;
        else if (!TYPE_BLOCK_OPENER.test(line)) continue;
        const code = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
        depth = Math.max(0, depth + (code.split('{').length - 1) - (code.split('}').length - 1));
    }
    return mask;
}

/**
 * True when `line` is a TypeScript type-member declaration — a declaration, not an
 * assignment, and therefore incapable of carrying a credential.
 *
 * @param line        the full source line
 * @param filePath    path of the file being scanned; a non-TypeScript path (or an
 *                    unknown one) is never exempted
 * @param inTypeBlock the line sits inside an interface/type block (not needed in `.d.ts`)
 */
function isTypeAnnotationLine(line, filePath, inTypeBlock) {
    if (typeof line !== 'string' || line.length > 400) return false;
    const normalized = normalizePath(filePath);
    if (!TS_SOURCE_PATH.test(normalized)) return false;
    if (!TS_DECLARATION_PATH.test(normalized) && inTypeBlock !== true) return false;
    // A credential-shaped run is never a type name: `secret: process.env.aB3xK9mP2qR7tY1w`
    // satisfies the member grammar but is a value, so it falls through to the scan.
    if (hasOpaqueRun(line)) return false;
    // Read tool output arrives `cat -n` style (line number + tab), which would otherwise
    // defeat the anchor; strip that gutter before matching.
    const member = line.replace(/^\s*\d+\t/, '');
    if (!TS_TYPE_MEMBER.test(member)) return false;
    const typeExpression = member.slice(member.indexOf(':', member.search(/[A-Za-z_$\]'"`]/)) + 1).replace(TYPE_KEYWORDS, ' ');
    return !/[A-Za-z0-9_$>\]]\s+[A-Za-z_$]/.test(typeExpression.trim());
}

// Per-content context for the source exemptions: the split lines, the offset of each
// line and the interface/type-block mask. Built only when the path can be exempt at all.
function sourceExemptionContext(content, filePath) {
    const normalized = normalizePath(filePath);
    const code = CODE_SOURCE_PATH.test(normalized);
    const typed = TS_SOURCE_PATH.test(normalized);
    if (!code && !typed) return null;
    const lines = content.split('\n');
    const starts = new Array(lines.length);
    let at = 0;
    for (let i = 0; i < lines.length; i++) { starts[i] = at; at += lines[i].length + 1; }
    return { lines, starts, mask: typed && !TS_DECLARATION_PATH.test(normalized) ? typeBlockMask(lines) : null };
}

function lineIndexAt(context, offset) {
    let lo = 0;
    let hi = context.starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (context.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// Known, deliberate asymmetries (all fail closed; do not "fix" them by widening an exemption):
// a prettier-wrapped assignment (`const apiKey =\n  encryptedKey ?? fallback;`) is still masked
// by the redactor when another finding triggers redaction, because its regex crosses the
// newline while the scanner is per-line; and PEP 8 keyword arguments
// (`connect(host, password=db_password)`) stay flagged by the formatter-spacing rule.
//
// One decision for both the scanner (per line) and the redactor (whole text), so the two
// can never disagree about a match: `lineIndex` and `offsetInLine` locate THIS occurrence.
function isSourceExemption(context, filePath, matched, lineIndex, offsetInLine) {
    if (!context) return false;
    const line = context.lines[lineIndex];
    return isCodeReferenceValue(matched, line, filePath, offsetInLine) ||
        isTypeAnnotationLine(line, filePath, context.mask ? context.mask[lineIndex] : false);
}

function isGenericAssignmentExemption(context, filePath, matched, lineIndex, offsetInLine) {
    if (isPlaceholderValue(matched)) {
        if (!context) return true;
        // The generic regex can stop before a fallback or concatenation. A runtime
        // lookup/placeholder prefix must not hide a literal in the same assignment.
        const sep = matched.search(/[=:]/);
        const expression = sourceAssignedExpression(context.lines[lineIndex].slice(offsetInLine + sep + 1), filePath);
        if (expression && isPlaceholderValue(matched.slice(0, sep + 1) + expression.text.trim())) return true;
    }
    return isSourceExemption(context, filePath, matched, lineIndex, offsetInLine);
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
    const exemptionContext = namedProvidersOnly ? null : sourceExemptionContext(content, filePath);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of PATTERNS) {
            if (namedProvidersOnly && isGenericPatternName(pattern.name)) continue;

            const matches = line.matchAll(pattern.regex);
            for (const match of matches) {
                if (isGenericPatternName(pattern.name) &&
                    isGenericAssignmentExemption(exemptionContext, filePath, match[0], i, match.index)) {
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
 * @param {string} [filePath] - path the output came from, when known. Only used
 *   to apply the source-code and TypeScript type-member exemptions (see
 *   isSourceExemption, the decision scanContent shares); omitting it simply means no
 *   exemption, so existing callers stay conservative.
 * @returns {string} Content with detected secrets replaced; unchanged if no findings
 */
function redactSecretsInText(content, filePath) {
    if (!content) return content;

    let result = content;
    for (const pattern of PATTERNS) {
        // Reset regex state — patterns are declared with /g, which carries
        // lastIndex across calls if reused. Use replaceAll with a fresh regex
        // built from the source to avoid lastIndex pitfalls.
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        // Offsets refer to the text BEFORE this pattern's replacements, so the exemption
        // context is built from that same text, once, and only if a generic match needs it.
        const source = result;
        let context;
        const replacements = [];
        for (const occurrence of source.matchAll(re)) {
            const match = occurrence[0];
            let end = occurrence.index + match.length;
            // Same placeholder filter scanContent uses for these patterns. `redact` works
            // on the whole text, so the shared decision is fed this occurrence's own line
            // and offset. A short regex match must not leave a later literal fallback
            // behind after replacing only its runtime-reference/placeholder prefix.
            if (isGenericPatternName(pattern.name)) {
                if (context === undefined) context = sourceExemptionContext(source, filePath);
                const offset = occurrence.index;
                const lineIndex = context ? lineIndexAt(context, offset) : 0;
                // A match that runs across lines (the unquoted regexes allow `\s*` between
                // name and value) is judged by its first line; fail closed otherwise.
                if (isGenericAssignmentExemption(context, filePath, match, lineIndex,
                    context ? offset - context.starts[lineIndex] : 0)) continue;
                if (context) {
                    const sep = match.search(/[=:]/);
                    const valueStart = offset + sep + 1;
                    const lineEnd = context.starts[lineIndex] + context.lines[lineIndex].length;
                    const expression = sourceAssignedExpression(source.slice(valueStart, lineEnd), filePath);
                    // Unknown or incomplete syntax retains the conservative line tail.
                    end = Math.max(end, expression ? valueStart + expression.text.length : lineEnd);
                }
            }
            if ((pattern.name === 'Connection String' ||
                 pattern.name === 'Database URL') &&
                isPlaceholderConnString(match)) {
                continue;
            }
            replacements.push({ start: occurrence.index, end });
        }
        let cursor = 0;
        const parts = [];
        for (const replacement of replacements) {
            // An outer flagged assignment can contain a second generic match. Its
            // replacement already removes that value, so never reinsert nested bytes.
            if (replacement.start < cursor) continue;
            parts.push(source.slice(cursor, replacement.start), `<REDACTED:${pattern.name}>`);
            cursor = replacement.end;
        }
        result = parts.join('') + source.slice(cursor);
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
    isCodeReferenceValue,
    isTypeAnnotationLine,
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
