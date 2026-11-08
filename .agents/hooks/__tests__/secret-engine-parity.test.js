// Parity harness: the secret engine (Betterleaks + .agents/config/secret-engine.toml) against every
// fixture the retired regex scanner's tests exercised.
//
//   * CASES was captured from the scanner's own test suites: 298 inputs, each with the verdict the
//     retired scanner gave (163 secret shapes it detected, 135 shapes it kept clean). The engine
//     must agree on all but the ACCEPTED differences below, each pinned to the engine's actual
//     behaviour and a documented reason. No allowlist was widened to make a case pass.
//   * NAMED_SAMPLES holds one realistic, random-looking key per retired named-provider pattern.
//   * KNOWN_FALSE_ALARMS are the shapes the retired scanner still flagged by mistake.
//
// Fixture text is stored in parts that are joined at runtime, so this file never holds a complete
// key-shaped literal (the repository scans its own staged files). The text of a case is exactly
// what the retired suites fed the scanner; only the splits are new. These tests run the real
// engine binary (installed by secret-engine-install.js); there is no stub.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    scanContent,
    scanContentNamedProviders,
    NAMED_PROVIDER_PATTERNS,
} = require('../../../.agents/hooks/secret-patterns.cjs');

const REASONS = {
    'bare-identifier-in-source':
        'A bare identifier assigned in source code (apiKey = Winter2024Pass || fallback, a SQL string in a .py file) is a variable reference. The engine reads it as one; the retired scanner flagged any unquoted word that held a digit. A quoted literal in the same position is still detected.',
    'passphrase-without-digit-in-source':
        'A digit-free CamelCase word alone on a line of a source file looks the same as a TypeScript type member (password: SomeComponentResult). The engine keeps the type-member shape clean (a Cloudflare-generated .d.ts blocked every regeneration before) and so also lets the passphrase through in source files. In config, env, yaml and markdown files it is still detected.',
    'placeholder-literal-in-call':
        'hash("password"): the literal "password" is the placeholder word itself. The retired scanner flagged it as an exception to its own placeholder list; the engine applies the placeholder list uniformly.',
    'lookup-literal':
        'A lower-case word passed to a predicate (.includes("letmeinplease")) or a short name inside a malformed lookup (loadSecret("DB_PASS" ], ...)) is read as a name being looked up, not a credential being assigned.',
    'formdata-no-semicolon':
        'The same formData.get("currentPassword") ?? "" read as the clean case, written without the closing semicolon. The retired scanner failed closed on any grammar it could not prove; the engine has no grammar and reads the empty fallback as empty.',
    'code-reference-value':
        'The value is code, not a literal: a dotted reference (some.nested.reference, settings.ApiKeyValue), a call whose callee has no digits (String(body.password ?? ""), actionData.error.toLowerCase().includes(...)) with no long random run. The retired scanner flagged them; an adopter showed the same shapes block everyday code (typed parameters, zod schemas, env reads). A call shaped like Summer2024(!) or a value holding a 16+ character random run is still detected.',
    'docs-reference-shape':
        'password: env.HYPERDRIVE.password, in a markdown or text file outside a source-language fence. A dotted property chain is a reference to a binding, and in prose it documents code. In .env, yaml, json and ini files the same text is still detected.',
};

const j = (...p) => p.join('');
// Home-directory fixture built from parts so the shipped-content lint does not mistake it for a machine path.
const HOME_FIXTURE = ['', 'home', 'user'].join('/');
const printable = s => JSON.stringify(s.length > 56 ? s.slice(0, 56) + '...' : s);
const findingsOf = (text, path, named) =>
    scanContent(text, path, { namedProvidersOnly: named }).filter(f => f.type === 'SECRET_PATTERN');

// id, path, named (test/spec file: generic rules dropped), expect (engine verdict), text parts.
// was/accepted are present only where the engine differs from the retired scanner.
const CASES = [
    { id: 1, path: 'src/app.ts', named: false, expect: 'clean', text: ['const x = 42;\n'] },
    { id: 2, path: 'notes/memory.json', named: false, expect: 'detect', text: ['const k = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 3, path: '/some/file.js', named: false, expect: 'detect', text: ['export const key = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 4, path: 'config/server.key', named: false, expect: 'clean', text: ['plain notes, no credentials\n'] },
    { id: 5, path: 'certs/site.pem', named: false, expect: 'clean', text: ['plain notes, no credentials\n'] },
    { id: 6, path: '.env.local', named: false, expect: 'clean', text: ['plain notes, no credentials\n'] },
    { id: 7, path: '.env.local', named: false, expect: 'detect', text: ['token = "AKIAFAKE', 'TESTKEYXXXXX"'] },
    { id: 8, path: 'src/app.ts', named: false, expect: 'detect', text: ['const password = String(body.password ?? "");\nconst k = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 9, path: '/some/clean.js', named: false, expect: 'clean', text: ['const x = 42;\nconsole.log(x);\n'] },
    { id: 10, path: '<bash output>', named: false, expect: 'detect', text: ['AWS_KEY=AKIAFAKE', 'TESTKEYXXXXX'] },
    { id: 11, path: '<bash output>', named: false, expect: 'detect', text: ['curl: auth failed for token=AKIAFAKE', 'TESTKEYXXXXX'] },
    { id: 12, path: '<bash output>', named: false, expect: 'detect', text: ['out: AKIAFAKE', 'TESTKEYXXXXX\nerr: AKIAFAKE', 'TESTKEYXXXXX'] },
    { id: 13, path: '/repo/src/auth.test.ts', named: true, expect: 'detect', text: ['const key = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 14, path: '/repo/src/auth.test.ts', named: true, expect: 'clean', text: ['const fixture = { password: "correct-horse-battery" };'] },
    { id: 15, path: '/repo/src/app.ts', named: false, expect: 'detect', text: ['const password = String(body.password ?? "");\nconst k = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 16, path: 'config.js', named: false, expect: 'detect', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
    { id: 17, path: '/some/file.js', named: false, expect: 'detect', text: ['const k = "AKIAFAKE', 'TESTKEYXXXXX";'] },
    { id: 18, path: 'config.js', named: false, expect: 'detect', text: ['client_secret=GOCSPX-a', 'bcdefghij', 'klmnopqrstuvwxyz12'] },
    { id: 19, path: 'config.js', named: false, expect: 'clean', text: ['12345'] },
    { id: 20, path: '/x/.env', named: false, expect: 'clean', text: ['12345'] },
    { id: 21, path: 'config.js', named: false, expect: 'clean', text: ['null'] },
    { id: 22, path: 'config.js', named: false, expect: 'clean', text: ['undefined'] },
    { id: 23, path: 'config.js', named: false, expect: 'detect', text: ['OPENAI_API_KEY=sk-abcde', 'fghijklmnopqrs', 'tuvwxyz012345678901234'] },
    { id: 24, path: 'config.js', named: false, expect: 'detect', text: ['const apiKey = "sk-proj-', 'abcdefghijklmnopqrs', 'tuvwxyz01234567890ABCDEFGHIJ";'] },
    { id: 25, path: 'config.js', named: false, expect: 'detect', text: ['ANTHROPIC_API_KEY=sk-ant-a', 'bcdefghijklmnopq', 'rstuvwxyz01234567890ABCDE'] },
    { id: 26, path: 'config.yml', named: false, expect: 'detect', text: ['token: ghp_abcd', 'efghijklmnopq', 'rstuvwxyz0123456789AB'] },
    { id: 27, path: '.env', named: false, expect: 'detect', text: ['GH_TOKEN=github_p', 'at_abcdefghijkl', 'mnopqrstuvwxyz0123456789'] },
    { id: 28, path: 'id_rsa', named: false, expect: 'detect', text: ['-----BEG', 'IN RSA ', 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA...'] },
    { id: 29, path: 'request.http', named: false, expect: 'detect', text: ['Authorization: Bearer e', 'yJhbGci', 'OiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODk', 'wIi', 'wibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'] },
    { id: 30, path: '.env', named: false, expect: 'detect', text: ['STRIPE_SECRET_KEY=sk_live_', 'abcdefgh', 'ijklmnopqrstuvwx'] },
    { id: 31, path: '.npmrc', named: false, expect: 'detect', text: ['//registry.npmjs.org/:_authToken=npm_abcd', 'efghijklmnop', 'qrstuvwxyz0123456789'] },
    { id: 32, path: 'config.js', named: false, expect: 'detect', text: ['SLACK_TOKEN=xoxb-123', '456789012-123456789', '012-abcdefghijklmnopqrstuvwx'] },
    { id: 33, path: 'config.js', named: false, expect: 'detect', text: ['SENDGRID_API_KEY=SG.aaaaa', 'aaaaaaaaaaaaaaaaa.bbbbbbbb', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    { id: 34, path: 'config.js', named: false, expect: 'detect', text: ['postgres', '://user:mypasswo', 'rd123@db.example.com/mydb'] },
    { id: 35, path: 'docs/architecture/overview.md', named: false, expect: 'clean', text: ['Example: postgres', 'ql://us', 'er:pass@host/db'] },
    { id: 36, path: '.claude/agents/db-architect.md', named: false, expect: 'clean', text: ['mysql://', 'username:passw', 'ord@localhost:3306/mydb'] },
    { id: 37, path: 'README.md', named: false, expect: 'clean', text: ['postgres', '://<USER>:<P', 'ASSWORD>@host:5432/db'] },
    { id: 38, path: 'docs/backlog.md', named: false, expect: 'clean', text: ['DATABASE', '_URL=postgres', 'ql://us', 'er:pass@host/db'] },
    { id: 39, path: 'docs/architecture/overview.md', named: false, expect: 'clean', text: ['DATABASE', '_URL=postgresql', '://localhost:5432/appdb'] },
    { id: 40, path: 'config.js', named: false, expect: 'detect', text: ['postgres', '://user:Xk9mP2vQ7sLr4Tz@pr', 'od.abc123.rds.amazonaws.com/maindb'] },
    { id: 41, path: '.env.sh', named: false, expect: 'detect', text: ['export DB_PASSWORD=SuperSecretPass123'] },
    { id: 42, path: 'application.properties', named: false, expect: 'detect', text: ['db.password=SuperSecretPass123'] },
    { id: 43, path: 'config.ini', named: false, expect: 'detect', text: ['[database]\npassword=SuperSecretPass123'] },
    { id: 44, path: 'config.yaml', named: false, expect: 'detect', text: ['password: SuperSecretPass123'] },
    { id: 45, path: 'config.yaml', named: false, expect: 'detect', text: ['api_key: aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 46, path: '.env.sh', named: false, expect: 'detect', text: ['export CLIENT_SECRET=aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 47, path: 'app.properties', named: false, expect: 'clean', text: ['count=5'] },
    { id: 48, path: 'config.yaml', named: false, expect: 'clean', text: ['name: bob'] },
    { id: 49, path: 'app.ini', named: false, expect: 'clean', text: ['pwd=short'] },
    { id: 50, path: 'app.properties', named: false, expect: 'clean', text: ['password=changeme'] },
    { id: 51, path: 'env-dump.txt', named: false, expect: 'clean', text: [`pwd=${HOME_FIXTURE}/projects/deep/nested/dir`] },
    { id: 52, path: 'app.properties', named: false, expect: 'detect', text: ['password=Sup3rS3cretValue!'] },
    { id: 53, path: 'app.sh', named: false, expect: 'clean', text: ['password=$DB_PASSWORD'] },
    { id: 54, path: 'config.js', named: false, expect: 'detect', text: ['password="SuperSecretPass123"'] },
    { id: 55, path: 'app.properties', named: false, expect: 'clean', text: ['password=example'] },
    { id: 56, path: 'config.yaml', named: false, expect: 'clean', text: ['api_key=xxxxxxxx'] },
    { id: 57, path: 'config.local.json', named: false, expect: 'detect', text: ['{ "api_key": "CG-abcd1234efgh5678" }'] },
    { id: 58, path: 'config.local.json', named: false, expect: 'detect', text: ['{ "password": "hunter2hunter2" }'] },
    { id: 59, path: 'docs/.output/findings/reviews/audit.md', named: false, expect: 'detect', text: ['leaked key CG-abcDE', 'F1234', '56ghiJKL789mn in config'] },
    { id: 60, path: 'CHANGELOG.md', named: false, expect: 'clean', text: ['see CG-1 in the changelog'] },
    { id: 61, path: 'config.js', named: false, expect: 'detect', text: ['key = "AKIAIOSF', 'ODNN7EXAMPLE123456"'] },
    { id: 62, path: 'test.js', named: false, expect: 'detect', text: ['line1\nline2\nAKIAIOSF', 'ODNN7EXAMPLE123456'] },
    { id: 63, path: '/project/config.js', named: false, expect: 'detect', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
    { id: 64, path: 'clean.js', named: false, expect: 'clean', text: ['const x = 1;\nconsole.log(x);\n'] },
    { id: 65, path: 'src/account.tsx', named: false, expect: 'clean', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 66, path: 'src/account.tsx', named: false, expect: 'clean', text: ['const currentPassword = (formData.get(\'currentPassword\') as string | null) ?? \'\';'] },
    { id: 67, path: 'src/account.tsx', named: false, expect: 'clean', text: ['const currentPassword = (\nformData.get("currentPassword") as string | null\n) ?? "";'] },
    { id: 68, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? "Winter2024Pass";'] },
    { id: 69, path: '/project/hello.js', named: false, expect: 'clean', text: ['console.log("hello world");\n'] },
    { id: 70, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null)\n ?? "Winter2024Pass";'] },
    { id: 71, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null)\n ? "Winter2024Pass" : "";'] },
    { id: 72, path: '/project/settings.js', named: false, expect: 'detect', text: ['const token = "ghp_abcd', 'efghijklmnopq', 'rstuvwxyz0123456789AB";'] },
    { id: 73, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? "" + "Winter2024Pass";'] },
    { id: 74, path: '/project/settings.js', named: false, expect: 'clean', text: ['const x = 42;'] },
    { id: 75, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("Winter2024Pass") as string | null) ?? "";'] },
    { id: 76, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword", "Winter2024Pass") as string | null) ?? "";'] },
    { id: 77, path: '/project/config.js', named: false, expect: 'clean', text: ['const x = 1;'] },
    { id: 78, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? ""\n || "Winter2024Pass";'] },
    { id: 79, path: '/project/analysis.ipynb', named: false, expect: 'detect', text: ['token = "ghp_abcd', 'efghijklmnopq', 'rstuvwxyz0123456789AB"'] },
    { id: 80, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? ""\n\n\n\n\n\n\n\n\n|| "Winter2024Pass";'] },
    { id: 81, path: 'src/account.tsx', named: false, expect: 'clean', was: 'detect', accepted: 'formdata-no-semicolon', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? ""'] },
    { id: 82, path: '/project/config.js', named: false, expect: 'clean', text: ['line one\nline two\nline three'] },
    { id: 83, path: 'config.yaml', named: false, expect: 'detect', text: ['currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 84, path: '.env', named: false, expect: 'detect', text: ['currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 85, path: 'README.md', named: false, expect: 'detect', text: ['currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 86, path: 'config.json', named: false, expect: 'detect', text: ['currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 87, path: 'src/account.tsx', named: false, expect: 'detect', text: ['// currentPassword = (formData.get("currentPassword") as string | null) ?? "";'] },
    { id: 88, path: `${HOME_FIXTURE}/.ssh/id_rsa`, named: false, expect: 'clean', text: [' \n'] },
    { id: 89, path: 'src/account.tsx', named: false, expect: 'detect', text: ['`currentPassword = (formData.get("currentPassword") as string | null) ?? "";`'] },
    { id: 90, path: 'src/account.tsx', named: false, expect: 'detect', text: ['const currentPassword = (formData.get("currentPassword") as string | null) ?? "";\nconst password = "Winter2024Pass";\nconst token = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
    { id: 91, path: '/project/src/auth.test.js', named: true, expect: 'detect', text: ['const key = "AKIAQW3E', 'RTY7UIOPAS2D";'] },
    { id: 92, path: 'src/signup.tsx', named: false, expect: 'clean', text: ['const errors = {\npassword: actionData.error.toLowerCase().includes("password")\n ? actionData.error : undefined,\n};'] },
    { id: 93, path: '/project/src/auth.test.js', named: true, expect: 'clean', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
    { id: 94, path: '/project/src/auth.spec.ts', named: true, expect: 'detect', text: ['const token = "ghp_abcd', 'efghijklmnopq', 'rstuvwxyz0123456789AB";'] },
    { id: 95, path: 'src/signup.tsx', named: false, expect: 'clean', text: ['const errors = {\npassword: result.error.toLowerCase().includes(\'password\')\n ? result.error : undefined,\n};'] },
    { id: 96, path: '/project/src/__tests__/auth.js', named: true, expect: 'clean', text: ['const password = "hunter2hunter2";'] },
    { id: 97, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: actionData.error.toLowerCase().includes("Winter2024Pass")'] },
    { id: 98, path: 'src/signup.tsx', named: false, expect: 'clean', was: 'detect', accepted: 'lookup-literal', text: ['password: actionData.error.toLowerCase().includes("letmeinplease")'] },
    { id: 99, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: actionData.error.toLowerCase().includes("password") || "Winter2024Pass"'] },
    { id: 100, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: actionData.error.toLowerCase().includes("password") ? "Winter2024Pass" : undefined'] },
    { id: 101, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: getError("Winter2024Pass").toLowerCase().includes("password")'] },
    { id: 102, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: actionData.error.toLowerCase().includes("password", "Winter2024Pass")'] },
    { id: 103, path: 'src/signup.tsx', named: false, expect: 'clean', was: 'detect', accepted: 'placeholder-literal-in-call', text: ['password: hash("password")'] },
    { id: 104, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['password: "Winter2024Pass"'] },
    { id: 105, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['const errors = {\npassword: actionData.error.toLowerCase().includes("password")\n ? "Winter2024Pass" : undefined,\n};'] },
    { id: 106, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['const errors = {\npassword: actionData.error.toLowerCase().includes("password")\n || "Winter2024Pass",\n};'] },
    { id: 107, path: '/tmp/domdhi-test-BrHdle/clean.js', named: false, expect: 'clean', text: ['const x = 1;\nconsole.log(x);\n'] },
    { id: 108, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['const errors = {\npassword: actionData.error.toLowerCase().includes("password")\n ? load("Winter2024Pass") : undefined,\n};'] },
    { id: 109, path: 'src/signup.tsx', named: false, expect: 'detect', text: ['const errors = {\npassword: actionData.error.toLowerCase().includes("password")\n ? actionData.error : "Winter2024Pass",\n};'] },
    { id: 110, path: '/tmp/domdhi-test-ewVlZF/secrets.js', named: false, expect: 'detect', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";\n'] },
    { id: 111, path: 'config.yaml', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: actionData.error.toLowerCase().includes("password")'] },
    { id: 112, path: '.env', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: actionData.error.toLowerCase().includes("password")'] },
    { id: 113, path: 'README.md', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: actionData.error.toLowerCase().includes("password")'] },
    { id: 114, path: '/tmp/domdhi-test-wZzOSI/key.js', named: false, expect: 'detect', text: ['const token = "sk-abcde', 'fghijklmnopqrstuv', 'wxyz01234567890ABCDEFGHIJK";\n'] },
    { id: 115, path: 'README.md', named: false, expect: 'clean', text: ['// AKIA example in a comment — not a real key'] },
    { id: 116, path: 'docs.md', named: false, expect: 'clean', text: ['The API key format looks like `sk-...` or `sk-proj-...`'] },
    { id: 117, path: 'config.js', named: false, expect: 'clean', text: ['password = \'changeme\''] },
    { id: 118, path: 'config.js', named: false, expect: 'clean', text: ['api_key = "${API_KEY}"'] },
    { id: 119, path: 'config.toml', named: false, expect: 'clean', text: ['openai_api_key = "env(OPENAI_API_KEY)"'] },
    { id: 120, path: 'config.toml', named: false, expect: 'detect', text: ['api_key = "env(aB3xK9mP2qR7tY1wZ5nL8vC4)"'] },
    { id: 121, path: 'src/app.ts', named: false, expect: 'clean', text: ['coingeckoApiKey: env.COINGECKO_API_KEY,'] },
    { id: 122, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey: context.cloudflare.env.COINGECKO_API_KEY'] },
    { id: 123, path: 'src/app.ts', named: false, expect: 'clean', text: ['secret: process.env.STRIPE_WEBHOOK_SECRET;'] },
    { id: 124, path: 'src/app.ts', named: false, expect: 'clean', text: ['const apiKey = import.meta.env.VITE_API_KEY;'] },
    { id: 125, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey: process.env[\'COINGECKO_API_KEY\'],'] },
    { id: 126, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey: process.env["COINGECKO_API_KEY"]'] },
    { id: 127, path: 'src/app.ts', named: false, expect: 'clean', text: ['api_key = os.environ["COINGECKO_API_KEY"]'] },
    { id: 128, path: 'src/app.ts', named: false, expect: 'clean', text: ['api_key = os.environ.get(\'COINGECKO_API_KEY\')'] },
    { id: 129, path: 'src/app.ts', named: false, expect: 'clean', text: ['api_key = os.getenv(\'COINGECKO_API_KEY\')'] },
    { id: 130, path: 'src/app.ts', named: false, expect: 'clean', text: ['const apiKey = Deno.env.get("COINGECKO_API_KEY");'] },
    { id: 131, path: 'src/app.ts', named: false, expect: 'clean', text: ['String apiKey = System.getenv("COINGECKO_API_KEY");'] },
    { id: 132, path: 'src/app.ts', named: false, expect: 'clean', text: ['var apiKey = Environment.GetEnvironmentVariable("COINGECKO_API_KEY");'] },
    { id: 133, path: 'src/app.ts', named: false, expect: 'clean', text: ['var secret = builder.Configuration["Graph:ClientSecret"];'] },
    { id: 134, path: 'src/app.ts', named: false, expect: 'clean', text: ['var secret = config.GetValue<string>("Graph:ClientSecret");'] },
    { id: 135, path: 'src/app.ts', named: false, expect: 'clean', text: ['ClientSecret: ${{ secrets.GRAPH_CLIENT_SECRET }}'] },
    { id: 136, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey: $(CoinGeckoApiKey)'] },
    { id: 137, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey=%COINGECKO_API_KEY%'] },
    { id: 138, path: 'src/app.ts', named: false, expect: 'clean', text: ['"ApiKey": "@Microsoft.KeyVault(SecretUri=https://example.vault.azure.net/secrets/CoinGecko/)"'] },
    { id: 139, path: 'src/app.ts', named: false, expect: 'clean', text: ['password: `env.DB_PASS`'] },
    { id: 140, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey = `process.env.STRIPE_KEY`'] },
    { id: 141, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: "sk-live-aB3xK9mP2qR7tY1wZ5nL8vC4"'] },
    { id: 142, path: 'src/app.ts', named: false, expect: 'detect', text: ['secret: process.env.aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 143, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: env.COINGECKO_API_KEY_aB3xK9mP2qR7tY1w'] },
    { id: 144, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey = Foo.get("aB3xK9mP2qR7tY1wZ5nL8vC4")'] },
    { id: 145, path: 'src/app.ts', named: false, expect: 'detect', text: ['api_key = os.environ.get("COINGECKO_API_KEY","aB3xK9mP2qR7tY1wZ5nL8vC4")'] },
    { id: 146, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey = cache.get("SUPERSECRETTOKEN9")'] },
    { id: 147, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: process.env["aB3xK9mP2qR7tY1wZ5nL8vC4"]'] },
    { id: 148, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: some.thing.aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 149, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: `aB3xK9mP2qR7tY1wZ5nL8vC4`'] },
    { id: 150, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey: `env.COINGECKO_API_KEY_aB3xK9mP2qR7tY1w`'] },
    { id: 151, path: 'src/app.ts', named: false, expect: 'detect', text: ['"ApiKey": "@Microsoft.KeyVault(SecretUri=https://example.vault.azure.net/secrets/Cg/ aB3xK9mP2qR7tY1wZ5nL8vC4)"'] },
    { id: 152, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 153, path: '.env', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 154, path: 'src/app.ts', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 155, path: 'src/app.tsx', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 156, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 157, path: 'svc/app.py', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 158, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 159, path: 'src/app.ts', named: false, expect: 'clean', text: ['const secret = c.req.header("x-admin-secret");'] },
    { id: 160, path: 'src/app.tsx', named: false, expect: 'clean', text: ['const secret = c.req.header("x-admin-secret");'] },
    { id: 161, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['const secret = c.req.header("x-admin-secret");'] },
    { id: 162, path: 'svc/app.py', named: false, expect: 'clean', text: ['const secret = c.req.header("x-admin-secret");'] },
    { id: 163, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['const secret = c.req.header("x-admin-secret");'] },
    { id: 164, path: 'src/app.ts', named: false, expect: 'clean', text: ['apiKey: encryptedKey ?? (cfg.apiKey as string)'] },
    { id: 165, path: 'src/app.tsx', named: false, expect: 'clean', text: ['apiKey: encryptedKey ?? (cfg.apiKey as string)'] },
    { id: 166, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['apiKey: encryptedKey ?? (cfg.apiKey as string)'] },
    { id: 167, path: 'svc/app.py', named: false, expect: 'clean', text: ['apiKey: encryptedKey ?? (cfg.apiKey as string)'] },
    { id: 168, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['apiKey: encryptedKey ?? (cfg.apiKey as string)'] },
    { id: 169, path: 'src/app.tsx', named: false, expect: 'clean', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 170, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 171, path: 'svc/app.py', named: false, expect: 'clean', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 172, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['apiKey = settings.ApiKeyValue;'] },
    { id: 173, path: 'src/app.ts', named: false, expect: 'clean', text: ['const secret = c.req.header("authorization");'] },
    { id: 174, path: 'src/app.tsx', named: false, expect: 'clean', text: ['const secret = c.req.header("authorization");'] },
    { id: 175, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['const secret = c.req.header("authorization");'] },
    { id: 176, path: 'svc/app.py', named: false, expect: 'clean', text: ['const secret = c.req.header("authorization");'] },
    { id: 177, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['const secret = c.req.header("authorization");'] },
    { id: 178, path: 'src/app.ts', named: false, expect: 'clean', text: ['const apiKey = getenv("COINGECKO_API_KEY", k);'] },
    { id: 179, path: 'src/app.tsx', named: false, expect: 'clean', text: ['const apiKey = getenv("COINGECKO_API_KEY", k);'] },
    { id: 180, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['const apiKey = getenv("COINGECKO_API_KEY", k);'] },
    { id: 181, path: 'svc/app.py', named: false, expect: 'clean', text: ['const apiKey = getenv("COINGECKO_API_KEY", k);'] },
    { id: 182, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['const apiKey = getenv("COINGECKO_API_KEY", k);'] },
    { id: 183, path: 'src/app.ts', named: false, expect: 'clean', text: ['const adminPassword = loadAdminPassword(ctx);'] },
    { id: 184, path: 'src/app.tsx', named: false, expect: 'clean', text: ['const adminPassword = loadAdminPassword(ctx);'] },
    { id: 185, path: 'lib/app.mjs', named: false, expect: 'clean', text: ['const adminPassword = loadAdminPassword(ctx);'] },
    { id: 186, path: 'svc/app.py', named: false, expect: 'clean', text: ['const adminPassword = loadAdminPassword(ctx);'] },
    { id: 187, path: 'api/Handler.cs', named: false, expect: 'clean', text: ['const adminPassword = loadAdminPassword(ctx);'] },
    { id: 188, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['const password = encryptedKey;'] },
    { id: 189, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },'] },
    { id: 190, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['const options = { password: cfg.password, timeout: "10" };'] },
    { id: 191, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['const options = { password: decodeURIComponent(url.password), timeout: "10" };'] },
    { id: 192, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['const password = decodeURIComponent(url.password), retry = "10";'] },
    { id: 193, path: 'scripts/query-live.cjs', named: false, expect: 'clean', text: ['connect({ password: encryptedKey }, "ordinary literal");'] },
    { id: 194, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = decrypt(blob, "Winter2024Pass"), retry = "10";'] },
    { id: 195, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = cfg.password || "Winter2024Pass", retry = "10";'] },
    { id: 196, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = process.env.DB_PASSWORD || "Winter2024Pass";'] },
    { id: 197, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = process.env.DB_PASSWORD ?? "Winter2024Pass";'] },
    { id: 198, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = "placeholder" + "Winter2024Pass";'] },
    { id: 199, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = loadSecret({ fallback: "Winter2024Pass" }), retry = "10";'] },
    { id: 200, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = decrypt(nested("Winter2024Pass"), blob), retry = "10";'] },
    { id: 201, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = (encryptedKey, "Winter2024Pass");'] },
    { id: 202, path: 'scripts/query-live.cjs', named: false, expect: 'clean', was: 'detect', accepted: 'lookup-literal', text: ['const password = loadSecret("DB_PASS" ], retry = "10";'] },
    { id: 203, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = cfg.password, secret = "Winter2024Pass";'] },
    { id: 204, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = cfg.password; secret = "Winter2024Pass";'] },
    { id: 205, path: 'scripts/query-live.cjs', named: false, expect: 'detect', text: ['const password = cfg.password, providerValue = "sk-ant-a', 'bcdefghijklmnopq', 'rstuvwxyz01234567890ABCDE";'] },
    { id: 206, path: 'scripts/query.py', named: false, expect: 'detect', text: ['password = cfg.password, "Winter2024Pass"'] },
    { id: 207, path: '.env', named: false, expect: 'detect', text: ['API_KEY=aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 208, path: 'config.yaml', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: some.nested.reference'] },
    { id: 209, path: 'README.md', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: some.nested.reference'] },
    { id: 210, path: 'src/app.ts', named: false, expect: 'detect', text: ['apiKey = hunter2xyzSecret'] },
    { id: 211, path: 'src/app.ts', named: false, expect: 'detect', text: ['password: "hunter2Secret"'] },
    { id: 212, path: 'src/app.ts', named: false, expect: 'detect', text: ['const apiKey = Foo.get( "aB3xK9mP2qR7tY1wZ5nL8vC4" );'] },
    { id: 213, path: 'src/app.ts', named: false, expect: 'detect', text: ['const apiKey = decrypt(blob, "aB3xK9mP2qR7tY1wZ5nL8vC4");'] },
    { id: 214, path: 'svc/app.py', named: false, expect: 'detect', text: ['secret = decode(token, \'aB3xK9mP2qR7tY1wZ5nL8vC4\')'] },
    { id: 215, path: 'src/app.ts', named: false, expect: 'clean', was: 'detect', accepted: 'bare-identifier-in-source', text: ['authToken = cfg.value  aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 216, path: 'src/app.ts', named: false, expect: 'detect', text: ['const adminPassword = bcrypt.hashSync("Winter2024Pass", 10);'] },
    { id: 217, path: 'src/app.ts', named: false, expect: 'detect', text: ['const apiKey = getKey("Winter2024Pass");'] },
    { id: 218, path: 'svc/app.go', named: false, expect: 'detect', text: ['password = decrypt("hunter2abc", k)'] },
    { id: 219, path: 'src/app.ts', named: false, expect: 'detect', text: ['// password: Summer2024(!)'] },
    { id: 220, path: 'svc/app.py', named: false, expect: 'detect', text: ['# DB_PASSWORD=Hunter2(abc)x'] },
    { id: 221, path: 'src/app.js', named: false, expect: 'detect', text: ['execSync("export PGPASSWORD=Summer2024Pw && pg_dump db")'] },
    { id: 222, path: 'svc/app.py', named: false, expect: 'detect', text: ['os.system("API_KEY=tok_a1b2c3d4_e5f6g7h8 && run")'] },
    { id: 223, path: 'svc/app.py', named: false, expect: 'clean', was: 'detect', accepted: 'bare-identifier-in-source', text: ['CREATE USER app PASSWORD = Summer2024Pw && x'] },
    { id: 224, path: 'src/app.ts', named: false, expect: 'clean', was: 'detect', accepted: 'bare-identifier-in-source', text: ['const apiKey = Winter2024Pass || fallback;'] },
    { id: 225, path: 'src/seed.ts', named: false, expect: 'detect', text: ['const adminPassword = bcrypt.hashSync("letmeinplease", 10);'] },
    { id: 226, path: 'svc/app.py', named: false, expect: 'detect', text: ['const apiKey = getKey("hunterhunter");'] },
    { id: 227, path: 'src/app.ts', named: false, expect: 'clean', was: 'detect', accepted: 'placeholder-literal-in-call', text: ['const password = hash("password");'] },
    { id: 228, path: 'src/app.ts', named: false, expect: 'detect', text: ['const apiKey = getKey("HUNTERHUNTER");'] },
    { id: 229, path: '', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['password: some.nested.reference'] },
    { id: 230, path: 'SRC\\App.TS', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");'] },
    { id: 231, path: 'notes.TXT', named: false, expect: 'clean', was: 'detect', accepted: 'code-reference-value', text: ['const password = String(body.password ?? "");'] },
    { id: 232, path: 'worker-configuration.d.ts', named: false, expect: 'clean', text: ['interface Creds {\n    password: SomeComponentResult;\n    readonly secret?: Record<string, string>;\n}'] },
    { id: 233, path: 'src/types.ts', named: false, expect: 'clean', text: ['interface Creds {\n    password: SomeComponentResult;\n    readonly secret?: Record<string, string>;\n}'] },
    { id: 234, path: 'src/types.mts', named: false, expect: 'clean', text: ['interface Creds {\n    password: SomeComponentResult;\n    readonly secret?: Record<string, string>;\n}'] },
    { id: 235, path: 'src/types.ts', named: false, expect: 'detect', text: ['    password: 8f14e45fceea167a5a36dedd4bea2543;'] },
    { id: 236, path: 'src/infra.ts', named: false, expect: 'detect', text: ['password: Winter2024Pass'] },
    { id: 237, path: 'src/App.tsx', named: false, expect: 'clean', was: 'detect', accepted: 'passphrase-without-digit-in-source', text: ['  secret: CorrectHorseBatteryStaple'] },
    { id: 238, path: 'src/infra.mts', named: false, expect: 'detect', text: ['DB_PASSWORD: Winter2024Pass'] },
    { id: 239, path: 'src/infra.ts', named: false, expect: 'detect', text: ['    12\t  password: Winter2024Pass'] },
    { id: 240, path: 'src/types.ts', named: false, expect: 'detect', text: ['    password: "hunter2Secret";'] },
    { id: 241, path: 'src/types.ts', named: false, expect: 'detect', text: ['    secret: process.env.aB3xK9mP2qR7tY1wZ5nL8vC4;'] },
    { id: 242, path: 'notes.md', named: false, expect: 'detect', text: ['    password: SomeComponentResult;'] },
    { id: 243, path: 'config.yaml', named: false, expect: 'detect', text: ['    password: SomeComponentResult;'] },
    { id: 244, path: 'x.d.ts', named: false, expect: 'clean', text: ['interface A {\r\n  password: SomeType;\r\n}\r\n'] },
    { id: 245, path: 'x.ts', named: false, expect: 'clean', text: ['interface A {\r\n  password: SomeType;\r\n}\r\n'] },
    { id: 246, path: 'x.ts', named: false, expect: 'clean', text: ['     1\tinterface A {\n     2\t  password: SomeType;\n     3\t}'] },
    { id: 247, path: 'x.ts', named: false, expect: 'clean', text: ['const password = String(body.password ?? "");\r\n'] },
    { id: 248, path: 'a.ts', named: false, expect: 'detect', text: ['interface A {\n  a: "{";\n}\nconst t = `\npassword: Winter2024Pass\n`;'] },
    { id: 249, path: 'worker-configuration.d.ts', named: false, expect: 'clean', text: ['    password: SomeComponentResult;'] },
    { id: 250, path: 'x.ts', named: false, expect: 'detect', text: ['const a = (password = Winter2024Pass || fallback);\n\nconst t = `\npassword = Winter2024Pass\n`;'] },
    { id: 251, path: 'src/app.ts', named: false, expect: 'detect', text: ['const password = String(body.password ?? "");\nconst authToken = c.env.TWILIO_AUTH_TOKEN;\napiKey: encryptedKey ?? (cfg.apiKey as string)\nconst apiKey = decrypt(blob, "aB3xK9mP2qR7tY1wZ5nL8vC4");\nconst adminPassword = bcrypt.hashSync("Winter2024Pass", 10);\ninterface Creds {\n    password: SomeComponentResult;\n}\nconst rendered = `\npassword: Winter2024Pass\n`;'] },
    { id: 252, path: 'CLAUDE.md', named: false, expect: 'clean', text: ['apiKey: "test-123"'] },
    { id: 253, path: 'config.js', named: false, expect: 'clean', text: ['apiKey = "mock-key"'] },
    { id: 254, path: 'config.js', named: false, expect: 'detect', text: ['apiKey = "mock-aB3xK9mP2qR7tY1wZ5nL8vC4"'] },
    { id: 255, path: 'config.js', named: false, expect: 'detect', text: ['awsKey = "test-AKIAIOSF', 'ODNN7EXAMPLE"'] },
    { id: 256, path: 'empty.js', named: false, expect: 'clean', text: [''] },
    { id: 257, path: 'ref.md', named: false, expect: 'clean', text: ['export WEBHOOK_SECRET=your-webhook-secret'] },
    { id: 258, path: 'ref.md', named: false, expect: 'clean', text: ['TURN_KEY_SECRET=your_turn_key_secret'] },
    { id: 259, path: 'ref.md', named: false, expect: 'clean', text: ['export WRANGLER_R2_SQL_AUTH_TOKEN=YOUR_CATALOG_TOKEN'] },
    { id: 260, path: 'ref.md', named: false, expect: 'clean', text: ['const secret = \'your-turn-key-secret\';'] },
    { id: 261, path: 'ref.md', named: false, expect: 'clean', text: ['TURNSTILE_SECRET=your_secret_here'] },
    { id: 262, path: 'ref.md', named: false, expect: 'detect', text: ['WEBHOOK_SECRET=your_aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 263, path: '.env.sh', named: false, expect: 'detect', text: ['WEBHOOK_SECRET=your_aB3xK9mP2qR7tY1wZ5nL8vC4'] },
    { id: 264, path: 'ref.md', named: false, expect: 'detect', text: ['WEBHOOK_SECRET=yourself_aB3xK9mP2qR7tY1w'] },
    { id: 265, path: '.env.sh', named: false, expect: 'detect', text: ['WEBHOOK_SECRET=yourself_aB3xK9mP2qR7tY1w'] },
    { id: 266, path: 'ref.md', named: false, expect: 'clean', text: ['Password: [optional]'] },
    { id: 267, path: 'ref.md', named: false, expect: 'detect', text: ['password: [aB3xK9mP2qR7tY1w]'] },
    { id: 268, path: 'ref.md', named: false, expect: 'clean', text: ['{ "vars": { "API_KEY": "sk_live_abc123" } }'] },
    { id: 269, path: 'ref.md', named: false, expect: 'clean', text: ['API_KEY=sk-live-abc123...'] },
    { id: 270, path: 'ref.md', named: false, expect: 'clean', text: ['const apiKey = \'abc123\''] },
    { id: 271, path: 'ref.md', named: false, expect: 'detect', text: ['API_KEY=sk_', 'live_abc123aB3xK9mP2'] },
    { id: 272, path: 'ref.md', named: false, expect: 'detect', text: ['API_KEY=sk_', 'live_9f3aabc123'] },
    { id: 273, path: 'ref.md', named: false, expect: 'clean', text: ['TURNSTILE_SECRET=1x0000000000000000000000000000000AA'] },
    { id: 274, path: 'wrangler.sh', named: false, expect: 'clean', text: ['TURNSTILE_SECRET=1x0000000000000000000000000000000AA'] },
    { id: 275, path: 'ref.md', named: false, expect: 'clean', text: ['API_KEY=local-dev-key'] },
    { id: 276, path: 'wrangler.sh', named: false, expect: 'clean', text: ['API_KEY=local-dev-key'] },
    { id: 277, path: 'ref.md', named: false, expect: 'detect', text: ['TURNSTILE_SECRET=1x0000000000000000000000000000000AB'] },
    { id: 278, path: 'ref.md', named: false, expect: 'detect', text: ['API_KEY=local-dev-key2'] },
    { id: 279, path: 'ref.md', named: false, expect: 'clean', text: ['Setup:\n```typescript\nconst db = { password: env.HYPERDRIVE.password, };\n```'] },
    { id: 280, path: 'ref.md', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['```bash\npassword: env.HYPERDRIVE.password,\n```'] },
    { id: 281, path: 'ref.md', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['```hcl\npassword: env.HYPERDRIVE.password,\n```'] },
    { id: 282, path: 'ref.md', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['```\npassword: env.HYPERDRIVE.password,\n```'] },
    { id: 283, path: 'ref.md', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['password: env.HYPERDRIVE.password,'] },
    { id: 284, path: 'ref.md', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['```ts\nconst x = 1;\n```\npassword: env.HYPERDRIVE.password,'] },
    { id: 285, path: 'notes.txt', named: false, expect: 'clean', was: 'detect', accepted: 'docs-reference-shape', text: ['```ts\nconst db = { password: env.HYPERDRIVE.password, };\n```'] },
    { id: 286, path: 'ref.md', named: false, expect: 'clean', text: ['```ts\ninterface Env {\n  STRIPE_API_KEY: SecretsStoreSecret;\n}\n```'] },
    { id: 287, path: 'ref.md', named: false, expect: 'detect', text: ['```ts\nconst apiKey = \'aB3xK9mP2qR7tY1wZ5nL8vC4\';\n```'] },
    { id: 288, path: 'ref.md', named: false, expect: 'detect', text: ['```ts\nconst db = { secret: process.env.aB3xK9mP2qR7tY1wZ5nL8vC4 };\n```'] },
    { id: 289, path: 'ref.md', named: false, expect: 'detect', text: ['```ts\n// secret: aB3xK9mP2qR7tY1wZ5nL8vC4\n```'] },
    { id: 290, path: 'ref.md', named: false, expect: 'detect', text: ['```ts\ninterface Broken {\n```\n```ts\nsecret: aB3xK9mP2qR7tY1wZ5nL8vC4\n```'] },
    { id: 291, path: 'foo.test.js', named: true, expect: 'detect', text: ['const key = "AKIAQW3E', 'RTY7UIOPAS2D";'] },
    { id: 292, path: 'foo.test.js', named: true, expect: 'clean', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
    { id: 293, path: 'foo.test.js', named: true, expect: 'detect', text: ['ANTHROPIC_API_KEY=sk-ant-a', 'bcdefghijklmnopq', 'rstuvwxyz01234567890ABCDE'] },
    { id: 294, path: 'foo.test.js', named: true, expect: 'clean', text: ['password = "hunter2hunter2"'] },
    { id: 295, path: 'foo.spec.ts', named: true, expect: 'clean', text: ['apiKey = "aB3xK9mP2qR7tY1wZ5nL8vC4"'] },
    { id: 296, path: '__tests__/config.js', named: true, expect: 'clean', text: ['export DB_PASSWORD=SuperSecretPass123'] },
    { id: 297, path: 'config.js', named: false, expect: 'detect', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";\npassword = "hunter2hunter2"'] },
    { id: 298, path: '/project/.claude/skills/x/SKILL.md', named: false, expect: 'detect', text: ['const key = "AKIAIOSF', 'ODNN7EXAMPLE123456";'] },
];

// ── realistic keys, one per retired named-provider pattern ───────────────────

function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const A = {
    alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    lower: 'abcdefghijklmnopqrstuvwxyz0123456789',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    hex: '0123456789abcdef',
    letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
    digits: '0123456789',
};
function g(seed, n, alpha) { const r = prng(seed * 7919 + n); let o = ''; for (let i = 0; i < n; i++) o += alpha[Math.floor(r() * alpha.length)]; return o; }

const NAMED_SAMPLES = {
    'AWS Access Key': () => j('AKIA', g(1, 16, A.upper)),
    'AWS Secret Key': () => j('aws_secret_', 'access_key = "', g(2, 40, A.b64), '"'),
    'AWS Session Token': () => j('aws_session_', 'token=', g(3, 120, A.b64)),
    'Azure Storage Key': () => j('Account', 'Key=', g(4, 86, A.b64), '=='),
    'Azure Connection String': () => j('DefaultEndpoints', 'Protocol=https;AccountName=stgacct01;Account', 'Key=', g(5, 86, A.b64), '=='),
    'Azure SAS Token': () => j('https://stg.blob.core.windows.net/c/b?sv=2022-11-02&s', 'ig=', g(6, 43, A.b64).replace(/\//g, 'A'), '%3D&se=2030-01-01'),
    'GCP Service Account': () => j('{"private_', 'key": "-----BEGIN ', 'RSA PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0B\\n-----END ', 'RSA PRIVATE KEY-----\\n"}'),
    'GCP API Key': () => j('AIza', g(8, 35, A.url)),
    'Google OAuth Client Secret': () => j('GOCSPX-', g(9, 28, A.url)),
    'DigitalOcean PAT': () => j('dop_v1_', g(10, 64, A.hex)),
    'DigitalOcean OAuth': () => j('doo_v1_', g(11, 64, A.hex)),
    'GitHub Token': () => j('ghp_', g(12, 36, A.alnum)),
    'GitHub Fine-Grained PAT': () => j('github_pat_', g(13, 22, A.alnum), '_', g(14, 59, A.alnum)),
    'GitLab PAT': () => j('glpat-', g(15, 20, A.url)),
    'Bitbucket App Password': () => j('ATBB', g(16, 32, A.alnum)),
    'Atlassian API Token': () => j('ATATT3', g(17, 186, A.url)),
    'Slack Token': () => j('xoxb-', g(18, 12, A.digits), '-', g(19, 12, A.digits), '-', g(20, 24, A.alnum)),
    'Slack App Token': () => j('xapp-1-', g(21, 11, A.upper), '-', g(22, 13, A.digits), '-', g(23, 64, A.lower)),
    'Slack Webhook': () => j('https://hooks.slack.com/services/T', g(24, 8, A.upper), '/B', g(25, 10, A.upper), '/', g(26, 24, A.alnum)),
    'Discord Webhook': () => j('https://discord.com/api/webhooks/', g(27, 18, A.digits), '/', g(28, 68, A.url)),
    'OpenAI Key': () => j('sk-', g(29, 48, A.alnum)),
    'OpenAI Project Key': () => j('sk-proj-', g(30, 74, A.url)),
    'OpenAI Service Key': () => j('sk-svcacct-', g(31, 74, A.url)),
    'Anthropic Key': () => j('sk-ant-api03-', g(32, 93, A.url)),
    'HuggingFace Token': () => j('hf_', g(33, 34, A.letters)),
    'HuggingFace Org Token': () => j('api_org_', g(34, 34, A.letters)),
    'Stripe Key': () => j('sk_', 'live_', g(35, 24, A.alnum)),
    'Square Access Token': () => j('sq0atp-', g(36, 22, A.url)),
    'Square OAuth Secret': () => j('sq0csp-', g(37, 43, A.url)),
    'Shopify Token': () => j('shpat_', g(38, 32, A.hex)),
    'CoinGecko API Key': () => j('CG-', g(39, 24, A.alnum)),
    'npm Token': () => j('npm_', g(40, 36, A.alnum)),
    'PyPI Token': () => j('pypi-', g(41, 120, A.url)),
    'NuGet API Key': () => j('oy2', g(42, 43, A.lower)),
    'Docker Hub PAT': () => j('dckr_pat_', g(43, 27, A.url)),
    'Grafana API Key': () => j('eyJrIjoi', g(44, 80, A.alnum)),
    'Grafana Cloud Token': () => j('glc_', g(45, 40, A.alnum)),
    'Grafana Service Token': () => j('glsa_', g(46, 32, A.alnum), '_', g(47, 8, A.hex)),
    'Databricks Token': () => j('dapi', g(48, 32, A.hex)),
    'Doppler Token': () => j('dp.pt.', g(49, 43, A.alnum)),
    'CircleCI Token': () => j('ccipat_', g(50, 40, A.alnum)),
    'Hashicorp Vault Token': () => j('hvs.', g(51, 40, A.url)),
    'Hashicorp TF Token': () => j(g(52, 14, A.alnum), '.atlasv1.', g(53, 67, A.url)),
    'Cloudflare Origin CA': () => j('v1.0-', g(54, 24, A.hex), '-', g(55, 146, A.hex)),
    'Supabase Key': () => j('sbp_', g(56, 40, A.hex)),
    'Vercel Token': () => j('vercel_', g(57, 28, A.alnum)),
    'Linear API Key': () => j('lin_api_', g(58, 40, A.alnum)),
    'Postman API Key': () => j('PMAK-', g(59, 24, A.hex), '-', g(60, 34, A.hex)),
    'Telegram Bot Token': () => j(g(61, 9, A.digits), ':', g(62, 35, A.url)),
    'SendGrid Key': () => j('SG.', g(63, 22, A.url), '.', g(64, 43, A.url)),
    'Twilio Key': () => j('SK', g(65, 32, A.hex)),
    'Mailgun Key': () => j('key-', g(66, 32, A.alnum)),
    'JWT Token': () => j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', g(67, 43, A.url)),
    'Bearer Token': () => j('Authorization: Bearer ', g(68, 48, A.alnum)),
    'Private Key': () => j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA', g(69, 40, A.b64), '\n-----END ', 'RSA PRIVATE KEY-----'),
    'PGP Private Key': () => j('-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----\nlQdGBF', g(70, 40, A.b64), '\n-----END ', 'PGP PRIVATE KEY BLOCK-----'),
    'Connection String': () => j('postgres:', '//admin:', g(71, 14, A.alnum), '@db.internal.corp:5432/app'),
    'Database URL': () => j('DATABASE_', 'URL=mysql:', '//app:', g(72, 14, A.alnum), '@10.0.4.7/appdb'),
};

// Shapes the retired scanner still flagged by mistake. The engine keeps them all clean.
const KNOWN_FALSE_ALARMS = [
    ['a password built from a randomUUID() call inside a template', 'src/seed.ts', j('const password = `Test-$', '{crypto.randomUUID()}-Pw`;')],
    ['a password that is only a randomUUID() template', 'src/seed.ts', j('const password = `$', '{randomUUID()}`;')],
    ['a password property set from a randomUUID() template', 'src/seed.ts', j('  password: `pw-$', '{randomUUID()}`,')],
    ['a test password from randomBytes(16) converted to hex', 'src/seed.ts', "const testPassword = randomBytes(16).toString('hex');"],
    ['a password from randomBytes with double quotes', 'src/seed.ts', 'const password = randomBytes(16).toString("hex");'],
    ['an API key from crypto.randomBytes converted to base64', 'src/seed.ts', "const apiKey = crypto.randomBytes(24).toString('base64url');"],
    ['an error template that interpolates a scope after an API-key label', 'src/errors.ts', j('throw new Error(`API key: $', '{scope} is not configured`);')],
    ['an API key label followed by a scope interpolation in a message', 'src/errors.ts', j('const message = `apiKey for $', '{scope} is required`;')],
    ['the docs example: an API key set to a short test- value', 'docs/setup.md', 'API_KEY=test-key1'],
    ['a shell line that takes the host from a DB URL with parameter expansion', 'scripts/db.sh', j('DB_HOST="$', '{DATABASE_URL#*@}"')],
    ['a shell line that defaults a password variable', 'scripts/db.sh', j('export DB_PASSWORD="$', '{DB_PASSWORD:-}"')],
];

// ── tests ────────────────────────────────────────────────────────────────────

describe('secret engine parity: captured corpus', () => {
    const detect = CASES.filter(c => c.expect === 'detect' && !c.accepted);
    const clean = CASES.filter(c => c.expect === 'clean' && !c.accepted);

    it('covers the captured corpus and records every difference', () => {
        expect(CASES.length).toBe(298);
        expect(CASES.filter(c => c.accepted).length).toBe(23);
        expect(detect.length).toBe(140);
        expect(clean.length).toBe(135);
        // The retired scanner detected 163 and kept 135 clean; the 23 differences all went from detect to clean.
        expect(CASES.filter(c => c.accepted).every(c => c.was === 'detect' && c.expect === 'clean')).toBe(true);
    });

    describe('shapes detected by the retired scanner stay detected', () => {
        for (const c of detect) {
            it(`#${c.id} ${c.path || '(no path)'}${c.named ? ' [test file]' : ''}: ${printable(j(...c.text))}`, () => {
                expect(findingsOf(j(...c.text), c.path, c.named).length).toBeGreaterThan(0);
            });
        }
    });

    describe('shapes kept clean by the retired scanner stay clean', () => {
        for (const c of clean) {
            it(`#${c.id} ${c.path || '(no path)'}${c.named ? ' [test file]' : ''}: ${printable(j(...c.text))}`, () => {
                expect(findingsOf(j(...c.text), c.path, c.named)).toEqual([]);
            });
        }
    });

    describe('accepted differences (pinned to the engine behaviour, each with a reason)', () => {
        for (const c of CASES.filter(x => x.accepted)) {
            it(`#${c.id} [${c.accepted}] ${c.path}: ${printable(j(...c.text))}`, () => {
                expect(REASONS[c.accepted]).toBeTruthy();
                expect(findingsOf(j(...c.text), c.path, c.named)).toEqual([]);
            });
        }
        it('documents a reason for every code in use and no other', () => {
            const used = new Set(CASES.filter(c => c.accepted).map(c => c.accepted));
            expect([...used].sort()).toEqual(Object.keys(REASONS).sort());
        });
    });
});

describe('secret engine parity: named providers', () => {
    it('has a realistic sample for every retired named-provider pattern', () => {
        const names = NAMED_PROVIDER_PATTERNS.map(p => p.name).sort();
        expect(Object.keys(NAMED_SAMPLES).sort()).toEqual(names);
    });

    for (const [name, build] of Object.entries(NAMED_SAMPLES)) {
        it(`${name}: the engine detects it, under the same display name`, () => {
            const text = j('x = 1\n', build(), '\ny = 2\n');
            expect(findingsOf(text, 'src/app.txt', false).map(f => f.name)).toContain(name);
        });

        it(`${name}: still detected inside a test file (named providers always apply), under the same name`, () => {
            const text = j('x = 1\n', build(), '\ny = 2\n');
            expect(findingsOf(text, 'src/app.test.js', true).map(f => f.name)).toContain(name);
        });

        it(`${name}: the fallback list detects it too`, () => {
            const text = j('x = 1\n', build(), '\ny = 2\n');
            const names = scanContentNamedProviders(text, 'src/app.txt').map(f => f.name);
            expect(names).toContain(name);
        });
    }
});

describe('secret engine parity: shapes the retired scanner still flagged by mistake', () => {
    for (const [what, path, text] of KNOWN_FALSE_ALARMS) {
        it(`stays clean: ${what}`, () => {
            expect(findingsOf(text, path, false)).toEqual([]);
        });
    }
});

// ── added after the first review: built-in rules with a generic shape, hex digests, URLs ─────────────
// Each row: [what, path, text, expect ('detect'|'clean'), test-file mode]. None of these was in the
// captured corpus; the retired scanner's verdict on the same text is noted where it differs.

const HEX64 = j('9f8e7d6c5b4a3210fedcba98765432109f8e7d6c5b4a3210', 'fedcba9876543210');
const SLASH_PW = j('Zq8vL', '/m2Rt5Xw');
const PLAIN_PW = j('Zq8vLm2', 'Rt5Xw9d');

const REVIEW_CASES = [
    // built-in generic-shaped rules (the retired scanner was clean on every placeholder row)
    ['terraform placeholder password', 'infra/main.tf', 'password = "changeme"\n', 'clean'],
    ['terraform instructional password', 'infra/main.tf', 'password = "your-password"\n', 'clean'],
    ['terraform reference password', 'infra/main.tf', j('password = "$', '{var.db_password}"\n'), 'clean'],
    ['terraform literal password', 'infra/main.tf', j('password = "', PLAIN_PW, '"\n'), 'detect'],
    ['terraform administrator_login_password literal', 'infra/db.tf', j('administrator_login_password = "', PLAIN_PW, '"\n'), 'detect'],
    ['terraform literal in a test file (generic rules are dropped)', 'infra/db.test.js', j('const t = `password = "', PLAIN_PW, '"`;\n'), 'clean', true],
    ['curl with environment variables', 'scripts/call.sh', 'curl -u $API_USER:$API_PASS https://api.example.com/v1\n', 'clean'],
    ['curl with a braced reference', 'scripts/call.sh', j('curl -u "$', '{USER}:$', '{PASS}" https://api.example.com/v1\n'), 'clean'],
    ['curl with a literal user:password', 'scripts/call.sh', j('curl -u admin:', PLAIN_PW, ' https://api.example.com/v1\n'), 'detect'],
    ['curl literal in a docs page (the retired scanner was clean)', 'docs/a.md', j('curl -u admin:', PLAIN_PW, ' https://api.example.com/v1\n'), 'detect'],
    ['curl literal in a test file', 'scripts/call.test.js', j('const c = "curl -u admin:', PLAIN_PW, ' https://x.example/v1";\n'), 'clean', true],
    ['curl Authorization header with an environment variable', 'scripts/call.sh', 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1\n', 'clean'],
    // hex digests are exempt only where they are digests
    ['sha256 field', 'cfg/lock.yaml', j('sha256: "', HEX64, '"\n'), 'clean'],
    ['checksum assignment', 'cfg/lock.toml', j('checksum = "', HEX64, '"\n'), 'clean'],
    ['integrity-style digest', 'cfg/lock.json', j('{"digest": "', HEX64, '"}\n'), 'clean'],
    ['the toolkit render-state file', '.agents/render-state.json', j('  ".claude/agents/x.md": "', HEX64, '",\n'), 'clean'],
    ['SECRET_KEY set to hex', 'scripts/run.sh', j('SECRET_KEY=', HEX64, '\n'), 'detect'],
    ['a token field set to hex', 'cfg/app.json', j('{"token": "', HEX64, '"}\n'), 'detect'],
    ['access_token set to hex', 'cfg/app.yaml', j('access_token: ', HEX64, '\n'), 'detect'],
    ['api_key set to hex', 'cfg/app.env.txt', j('api_key = "', HEX64, '"\n'), 'detect'],
    ['a password set to hex', 'cfg/app.env.txt', j('DB_PASSWORD=', HEX64, '\n'), 'detect'],
    // the fixed UUID is exempt as a whole value, never as a suffix
    ['the exempt UUID alone', 'cfg/app.env.txt', 'DB_PASSWORD=014df517-39d1-4453-b7b3-9930c563627c\n', 'clean'],
    ['a password ending in the exempt UUID', 'cfg/app.env.txt', j('DB_PASSWORD=', PLAIN_PW, '014df517-39d1-4453-b7b3-9930c563627c\n'), 'detect'],
    // connection strings
    ['postgres password containing a slash', 'src/db.js', j('postgres:', '//admin:', SLASH_PW, '@db.corp:5432/app'), 'detect'],
    ['sqlalchemy driver scheme', 'src/db.py', j('postgresql+psycopg2:', '//u:', PLAIN_PW, '@db.corp/app'), 'detect'],
    ['rediss scheme', 'src/cache.js', j('rediss:', '//default:', PLAIN_PW, '@cache.corp:6380'), 'detect'],
    ['https user and password', 'scripts/clone.sh', j('git clone https:', '//deploy:', PLAIN_PW, '@git.corp/x.git'), 'detect'],
    ['mongodb+srv', 'src/db.js', j('mongodb+srv:', '//u:', PLAIN_PW, '@c0.mongodb.net/x'), 'detect'],
    ['https placeholder credentials', 'docs/a.md', 'git clone https://user:password@host/x.git\n', 'clean'],
    ['https template credentials', 'docs/a.md', 'git clone https://<user>:<token>@host/x.git\n', 'clean'],
    ['https port then a path with an @', 'docs/a.md', 'see https://example.com:8443/users/@me\n', 'clean'],
    ['postgres placeholder password', 'docs/a.md', 'postgres://user:password@localhost/db\n', 'clean'],
    ['postgres template credentials', 'docs/a.md', j('postgres:', '//<user>:<password>@localhost/db\n'), 'clean'],

    // The first adopter: real lines that are code shapes, not values. Each stays clean.
    ['OS: a secret parameter typed string', 'docs/patterns.md', j('async function signRequest(data: string, secret', ': string): Promise<string> {\n'), 'clean'],
    ['OS: a keySecret parameter typed string', 'docs/patterns.md', j('async getCredentials(keyId: string, keySecret', ': string): Promise<RTCIceServer[]> {\n'), 'clean'],
    ['OS: Uint8Array secret parameters', 'src/push/crypto.server.ts', j('  sharedSecret', ': Uint8Array,\n  authSecret', ': Uint8Array,\n'), 'clean'],
    ['OS: a password parameter in a plan', 'docs/plan.md', j('export async function lookupPwnedPassword(password', ': string): Promise<Result> {\n'), 'clean'],
    ['OS: config.requireSecret call', 'docs/pulumi.md', j('const apiKey', ' = config.requireSecret("apiKey"); // Encrypted in state\n'), 'clean'],
    ['OS: read of an env name', 'src/owned-principal.server.ts', j('const secret', ' = read("SUPABASE_JWT_SECRET");\n'), 'clean'],
    ['OS: a zod schema', 'docs/turn.md', j('TURN_KEY_SECRET', ': z.string().min(1)\n'), 'clean'],
    ['OS: a generated tunnel secret', 'docs/tunnel.md', j('tunnel_secret', ": Buffer.from(crypto.randomBytes(32)).toString('base64'),\n"), 'clean'],
    ['OS: an env reference in inline code', 'docs/plan.md', j('blocked on `coingeckoApiKey', ': env.COINGECKO_API_KEY`; the owner chose to reword\n'), 'clean'],
    ['OS: a constant reference', 'docs/research.md', j('  AGENT_API_KEY', ': TEST_KEY,\n'), 'clean'],
    ['OS: an error message after ||', 'src/routes/ai-settings.ts', j('  errors: { apiKey', ': validation.error || "Invalid API key" },\n'), 'clean'],
    ['OS: prose in a comment', 'src/schemas/coinbase.ts', j(' * - apiKey', ': plaintext API key (used for simple apikey auth)\n'), 'clean'],
    ['OS: a header object', 'docs/driver.mjs', j('const hdr = (b) => ({ apikey', ': ANON, Authorization: `Bearer $', '{b}`, "content-type": "application/json" });\n'), 'clean'],
    ['OS: a fetch call with headers and a body', 'docs/driver.mjs', j('const t = await fetch(`$', '{API}/token?grant_type=password`, { method: "POST", headers: { apikey', ': ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password', ': login }) });\n'), 'clean'],
    ['OS: a your_..._here placeholder', 'src/.dev.vars.example', j('STRIPE_WEBHOOK_SECRET', '=whsec_', 'your_secret_here\n'), 'clean'],
    ['OS: a ..._here dev placeholder', 'src/.dev.vars.example', j('AGENT_API_KEY', '=sk_dev_', 'test_key_here\n'), 'clean'],
    ['OS: a --password=dbpass doc flag', 'docs/hyperdrive.md', j('  --user=dbuser --password', '=dbpass --database=prod \\\n'), 'clean'],
    ['OS: a "secret" password in JSON', 'docs/secrets.md', j(`echo '{"username":"app","password"`, `:"secret"}' | \\\n`), 'clean'],
    ['OS: a test_ secret constant', 'src/scripts/verify-webhook.ts', j('const SECRET', ' = "test_secret_123";\n'), 'clean'],
    ['OS: PEM headers in JSDoc', 'src/coinbase.server.ts', j(' * ("-----BEGIN ', 'PRIVATE KEY-----") PEM format.\n * keys in SEC1 ("-----BEGIN ', 'EC PRIVATE KEY-----") format\n'), 'clean'],
    ['OS: a PEM placeholder with ... body', 'src/ConnectProviderForm.tsx', j('placeholder={"-----BEGIN ', 'EC PRIVATE KEY-----\\n...\\n-----END ', 'EC PRIVATE KEY-----"}\n'), 'clean'],
    ['OS: a PEM builder template', 'src/coinbase.server.ts', j('  return `-----BEGIN ', 'PRIVATE KEY-----\\n$', '{lines}\\n-----END ', 'PRIVATE KEY-----`;\n', '}\n/**\n * Accepts both PKCS8 ("-----BEGIN ', 'PRIVATE KEY-----") and SEC1\n'), 'clean'],
    ['OS: a Stripe placeholder in a test', 'src/stripe.events.test.ts', j('const env = { STRIPE_SECRET_KEY', ': "sk_', 'test_placeholder" };\n'), 'clean', true],

    // Controls for each loosening above: real-looking values in the same shapes stay detected.
    ['control: a real literal after a typed neighbour', 'src/a.ts', j('const cfg = { provider: X, apiKey', ': "', PLAIN_PW, '" };\n'), 'detect'],
    ['control: a fallback literal after a lookup', 'src/a.ts', j('const password', ' = get("DB_PW") ?? "', PLAIN_PW, '";\n'), 'detect'],
    ['control: a test_ prefix on a long random value', 'src/a.ts', j('const secret', ' = "test_', g(80, 20, A.alnum), '";\n'), 'detect'],
    ['control: an upper-case value without underscores', 'deploy/.env', j('API_KEY', '=', g(81, 20, A.alnum).toUpperCase(), '\n'), 'detect'],
    ['control: a dotted value with a long random run', 'docs/a.md', j('apiKey', ': cfg.', g(82, 24, A.alnum), '\n'), 'detect'],
    ['control: a real Stripe test key', 'src/a.ts', j('const k = "sk_', 'test_', g(83, 24, A.alnum), '";\n'), 'detect'],
    ['control: a PEM key with a real body', 'src/a.ts', j('const pem = `-----BEGIN ', 'PRIVATE KEY-----\n', g(84, 64, A.b64), '\n-----END ', 'PRIVATE KEY-----`;\n'), 'detect'],
];

describe('secret engine parity: after the first review', () => {
    for (const [what, path, text, want, named] of REVIEW_CASES) {
        it(`${want === 'detect' ? 'detects' : 'keeps clean'}: ${what}`, () => {
            const found = findingsOf(text, path, Boolean(named));
            if (want === 'detect') expect(found.length, JSON.stringify(found)).toBeGreaterThan(0);
            else expect(found).toEqual([]);
        });
    }

    it('names a built-in credential rule readably (Curl Credentials, Password Assignment)', () => {
        expect(findingsOf(j('curl -u admin:', PLAIN_PW, ' https://api.example.com/v1\n'), 'scripts/call.sh', false).map(f => f.name)).toContain('Curl Credentials');
        expect(findingsOf(j('password = "', PLAIN_PW, '"\n'), 'infra/main.tf', false).map(f => f.name)).toContain('Password Assignment');
    });
});
