import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
    PATTERNS,
    scanContent,
    shouldSkipPath,
    isHardSkipPath,
    isTestFilePath,
    formatFindings,
    redact,
    redactSecretsInText,
    isTypeAnnotationLine,
} = require('../../../.agents/hooks/secret-patterns.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build secret fixtures at runtime (string concatenation) to avoid tripping
 * the repo's own pre-commit secret-scanner hook.
 */
function fakeAwsKey() {
    return 'AKIA' + 'IOSFODNN7' + 'EXAMPLE123456';   // 16 chars after AKIA
}

// A syntactically valid AWS-shaped key that is NOT AWS's documented example
// (AKIAIOSFODNN7EXAMPLE, which fakeAwsKey() above happens to produce once the
// regex trims it to 16 chars) — used to prove the placeholder exemption
// doesn't overreach to a plausible-but-different key.
function fakeAwsKeyNotPlaceholder() {
    return 'AKIA' + 'QW3ERTY7UIOP' + 'AS2D';   // 16 chars after AKIA
}

function fakeOpenAiKey() {
    return 'sk-' + 'abcdefghij' + 'klmnopqrstu' + 'vwxyz01234' + '5678901234';
}

function fakeOpenAiProjectKey() {
    return 'sk-proj-' + 'abcdefghijklmnopqrstuvwxyz01234567890ABCDEFGHIJ';
}

function fakeAnthropicKey() {
    return 'sk-ant-' + 'abcdefghijklmnopqrstuvwxyz01234567890ABCDE';
}

function fakeGitHubPAT() {
    return 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
}

function fakeGitHubFineGrainedPAT() {
    return 'github_pat_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
}

function fakeStripeKey() {
    return 'sk_live_' + 'abcdefghijklmnopqrstuvwx';   // 24 chars after prefix
}

function fakeNpmToken() {
    return 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
}

function fakeJWT() {
    return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
        '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
        '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
}

function fakePrivateKeyHeader() {
    // Built at runtime so the repo's own secret-scanner pre-commit doesn't flag
    // this literal in the test file. The scanner is the thing under test.
    return '-----BEGIN ' + 'RSA' + ' PRIVATE ' + 'KEY-----';
}

function fakeSlackToken() {
    return 'xoxb-' + '123456789012' + '-' + '123456789012' + '-' + 'abcdefghijklmnopqrstuvwx';
}

function fakeSendGridKey() {
    // Pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/
    // Needs SG + . + 22 chars + . + 43 chars. Built at runtime.
    return 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43);
}

// ─── PATTERNS array ───────────────────────────────────────────────────────────

describe('PATTERNS', () => {
    it('PATTERNS_array_hasAtLeast50Entries', () => {
        expect(Array.isArray(PATTERNS)).toBe(true);
        expect(PATTERNS.length).toBeGreaterThanOrEqual(50);
    });

    it('PATTERNS_eachEntry_hasNameAndRegex', () => {
        for (const p of PATTERNS) {
            expect(typeof p.name).toBe('string');
            expect(p.name.length).toBeGreaterThan(0);
            expect(p.regex).toBeInstanceOf(RegExp);
        }
    });

    it('PATTERNS_names_areUnique', () => {
        const names = PATTERNS.map(p => p.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
    });
});

// ─── scanContent — secret detections ─────────────────────────────────────────

describe('scanContent', () => {

    describe('scanContent_awsKey', () => {
        it('scanContent_awsAccessKey_detected', () => {
            const content = `const key = "${fakeAwsKey()}";`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('AWS Access Key');
        });
    });

    describe('scanContent_googleOauthClientSecret', () => {
        it('scanContent_googleOauthClientSecret_detected', () => {
            // GOCSPX- + 28 chars. Built at runtime to avoid tripping the repo's
            // own pre-commit scanner on this test file.
            const secret = 'GOCSPX-' + 'abcdefghijklmnopqrstuvwxyz12';
            const findings = scanContent(`client_secret=${secret}`, 'config.js');
            expect(findings.map(f => f.name)).toContain('Google OAuth Client Secret');
        });
    });

    describe('scanContent_nonStringContent', () => {
        // Non-string content once threw `content.split is not a function`. It is
        // now coerced so it still scans (rather than throwing, which failed the
        // hook OPEN). A numeric payload has no secret → no SECRET_PATTERN finding,
        // but the high-risk-filename check still fires from the path alone.
        it('scanContent_numericContent_doesNotThrow', () => {
            expect(() => scanContent(12345, 'config.js')).not.toThrow();
            expect(scanContent(12345, 'config.js')).toEqual([]);
        });

        it('scanContent_numericContentToHighRiskFile_stillFlagsPath', () => {
            const findings = scanContent(12345, '/x/.env');
            expect(findings.map(f => f.type)).toContain('HIGH_RISK_FILE');
        });

        it('scanContent_nullAndUndefinedContent_doNotThrow', () => {
            expect(() => scanContent(null, 'config.js')).not.toThrow();
            expect(() => scanContent(undefined, 'config.js')).not.toThrow();
        });
    });

    describe('scanContent_openaiKey', () => {
        it('scanContent_openAiKey_detected', () => {
            const content = `OPENAI_API_KEY=${fakeOpenAiKey()}`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('OpenAI Key');
        });

        it('scanContent_openAiProjectKey_detected', () => {
            const content = `const apiKey = "${fakeOpenAiProjectKey()}";`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('OpenAI Project Key');
        });
    });

    describe('scanContent_anthropicKey', () => {
        it('scanContent_anthropicKey_detected', () => {
            const content = `ANTHROPIC_API_KEY=${fakeAnthropicKey()}`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('Anthropic Key');
        });
    });

    describe('scanContent_githubPAT', () => {
        it('scanContent_githubPAT_detected', () => {
            const content = `token: ${fakeGitHubPAT()}`;
            const findings = scanContent(content, 'config.yml');
            const names = findings.map(f => f.name);
            expect(names).toContain('GitHub Token');
        });

        it('scanContent_githubFineGrainedPAT_detected', () => {
            const content = `GH_TOKEN=${fakeGitHubFineGrainedPAT()}`;
            const findings = scanContent(content, '.env');
            const names = findings.map(f => f.name);
            expect(names).toContain('GitHub Fine-Grained PAT');
        });
    });

    describe('scanContent_sshPrivateKey', () => {
        it('scanContent_sshPrivateKeyHeader_detected', () => {
            const content = fakePrivateKeyHeader() + '\nMIIEowIBAAKCAQEA...';
            const findings = scanContent(content, 'id_rsa');
            const names = findings.map(f => f.name);
            expect(names).toContain('Private Key');
        });
    });

    describe('scanContent_jwt', () => {
        it('scanContent_jwtToken_detected', () => {
            const content = `Authorization: Bearer ${fakeJWT()}`;
            const findings = scanContent(content, 'request.http');
            const names = findings.map(f => f.name);
            expect(names).toContain('JWT Token');
        });
    });

    describe('scanContent_stripeKey', () => {
        it('scanContent_stripeLiveKey_detected', () => {
            const content = `STRIPE_SECRET_KEY=${fakeStripeKey()}`;
            const findings = scanContent(content, '.env');
            const names = findings.map(f => f.name);
            expect(names).toContain('Stripe Key');
        });
    });

    describe('scanContent_npmToken', () => {
        it('scanContent_npmToken_detected', () => {
            const content = `//registry.npmjs.org/:_authToken=${fakeNpmToken()}`;
            const findings = scanContent(content, '.npmrc');
            const names = findings.map(f => f.name);
            expect(names).toContain('npm Token');
        });
    });

    describe('scanContent_slackToken', () => {
        it('scanContent_slackBotToken_detected', () => {
            const content = `SLACK_TOKEN=${fakeSlackToken()}`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('Slack Token');
        });
    });

    describe('scanContent_sendgridKey', () => {
        it('scanContent_sendgridKey_detected', () => {
            const content = `SENDGRID_API_KEY=${fakeSendGridKey()}`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('SendGrid Key');
        });
    });

    describe('scanContent_connectionString', () => {
        it('scanContent_postgresConnectionString_detected', () => {
            const content = 'postgres://user:' + 'mypassword123' + '@db.example.com/mydb';
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('Connection String');
        });

        // Placeholder connection strings in docs/agents are examples, not secrets.
        it('scanContent_placeholderConnString_userPass_noDetection', () => {
            const content = 'Example: postgresql://user:pass@host/db';
            const names = scanContent(content, 'docs/architecture/overview.md').map(f => f.name);
            expect(names).not.toContain('Connection String');
        });
        it('scanContent_placeholderConnString_usernamePassword_noDetection', () => {
            const content = 'mysql://username:password@localhost:3306/mydb';
            const names = scanContent(content, '.claude/agents/db-architect.md').map(f => f.name);
            expect(names).not.toContain('Connection String');
        });
        it('scanContent_placeholderConnString_templateUserinfo_noDetection', () => {
            const content = 'postgres://<USER>:<PASSWORD>@host:5432/db';
            const names = scanContent(content, 'README.md').map(f => f.name);
            expect(names).not.toContain('Connection String');
        });
        it('scanContent_databaseUrl_placeholder_noDetection', () => {
            const content = 'DATABASE_URL=postgresql://user:pass@host/db';
            const names = scanContent(content, 'docs/backlog.md').map(f => f.name);
            expect(names).not.toContain('Database URL');
        });
        it('scanContent_databaseUrl_noCredentials_noDetection', () => {
            const content = 'DATABASE_URL=postgresql://localhost:5432/appdb';
            const names = scanContent(content, 'docs/architecture/overview.md').map(f => f.name);
            expect(names).not.toContain('Database URL');
        });
        // A real-looking password STILL blocks, even with a placeholder username —
        // the guard keys on the password, so it can't smuggle a credential.
        it('scanContent_realPassword_placeholderUsername_stillDetected', () => {
            const content = 'postgres://user:' + 'Xk9mP2vQ7sLr4Tz' + '@prod.abc123.rds.amazonaws.com/maindb';
            const names = scanContent(content, 'config.js').map(f => f.name);
            expect(names).toContain('Connection String');
        });
    });

    // F76 — unquoted key=value / YAML key: value coverage. The generic
    // Password/Secret Assignment fallback previously required a QUOTED value
    // (['"][^'"]{8,}['"]), missing the most common real-world unquoted forms:
    // shell `export KEY=value`, .properties/.ini `key=value`, and YAML
    // `key: value`. Guarded against false-positive explosion by requiring a
    // secret-ish key name AND a minimum unquoted value length (8 chars).
    describe('scanContent_unquotedAssignment', () => {
        it('scanContent_shellExportPassword_detected', () => {
            const content = 'export DB_PASSWORD=SuperSecretPass123';
            const findings = scanContent(content, '.env.sh');
            expect(findings.map(f => f.name)).toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_propertiesFilePassword_detected', () => {
            const content = 'db.password=SuperSecretPass123';
            const findings = scanContent(content, 'application.properties');
            expect(findings.map(f => f.name)).toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_iniFilePassword_detected', () => {
            const content = '[database]\npassword=SuperSecretPass123';
            const findings = scanContent(content, 'config.ini');
            expect(findings.map(f => f.name)).toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_yamlPassword_detected', () => {
            const content = 'password: SuperSecretPass123';
            const findings = scanContent(content, 'config.yaml');
            expect(findings.map(f => f.name)).toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_yamlApiKey_detected', () => {
            const content = 'api_key: aB3xK9mP2qR7tY1wZ5nL8vC4';
            const findings = scanContent(content, 'config.yaml');
            expect(findings.map(f => f.name)).toContain('Secret Assignment (Unquoted)');
        });

        it('scanContent_shellExportSecret_detected', () => {
            const content = 'export CLIENT_SECRET=aB3xK9mP2qR7tY1wZ5nL8vC4';
            const findings = scanContent(content, '.env.sh');
            expect(findings.map(f => f.name)).toContain('Secret Assignment (Unquoted)');
        });

        it('scanContent_benignCountAssignment_noDetection', () => {
            const content = 'count=5';
            const findings = scanContent(content, 'app.properties');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
            expect(findings.map(f => f.name)).not.toContain('Secret Assignment (Unquoted)');
        });

        it('scanContent_benignYamlName_noDetection', () => {
            const content = 'name: bob';
            const findings = scanContent(content, 'config.yaml');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
            expect(findings.map(f => f.name)).not.toContain('Secret Assignment (Unquoted)');
        });

        it('scanContent_unquotedShortValue_belowMinLength_noDetection', () => {
            // "short" is 5 chars — below the 8-char minimum
            const content = 'pwd=short';
            const findings = scanContent(content, 'app.ini');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedPlaceholderValue_changeme_noDetection', () => {
            const content = 'password=changeme';
            const findings = scanContent(content, 'app.properties');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedPwdPresentWorkingDir_noDetection_W2_3', () => {
            // W2-3: an UNQUOTED `pwd=/path` is the present-working-dir env var
            // (an env-dump line), never a password — `pwd` was dropped from the
            // unquoted Password variant (it stays in the QUOTED one). The value
            // here is long enough (≥8 chars) that the pre-fix pattern, which
            // included `pwd`, WOULD have flagged it as a false positive.
            const content = `pwd=${['', 'home', 'user', 'projects', 'deep', 'nested', 'dir'].join('/')}`;
            const findings = scanContent(content, 'env-dump.txt');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedRealPassword_stillDetected_W2_3_regressionGuard', () => {
            // The W2-3 tightening must not weaken real detection: a genuine
            // unquoted `password=<secret>` still blocks.
            const content = 'password=Sup3rS3cretValue!';
            const findings = scanContent(content, 'app.properties');
            expect(findings.map(f => f.name)).toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedEnvVarReference_noDetection', () => {
            // A shell variable reference used as the value, not a literal secret
            const content = 'password=$DB_PASSWORD';
            const findings = scanContent(content, 'app.sh');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedValue_doesNotDoubleMatchQuotedForm', () => {
            // A quoted value must not ALSO trip the unquoted pattern
            const content = 'password="SuperSecretPass123"';
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('Password Assignment');
            expect(names).not.toContain('Password Assignment (Unquoted)');
        });

        // Placeholder/false-positive guard — "example" and "xxx" style dummy
        // values are recognized dummy words (PLACEHOLDER_PATTERNS), same
        // allowlist the quoted patterns already rely on.
        it('scanContent_unquotedPlaceholderValue_exampleWord_noDetection', () => {
            const content = 'password=example';
            const findings = scanContent(content, 'app.properties');
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_unquotedPlaceholderValue_xxxRepeated_noDetection', () => {
            const content = 'api_key=xxxxxxxx';
            const findings = scanContent(content, 'config.yaml');
            expect(findings.map(f => f.name)).not.toContain('Secret Assignment (Unquoted)');
        });
    });

    describe('scanContent_jsonQuotedAssignment', () => {
        // Regression: JSON config writes the key name in quotes ("api_key": "…"),
        // which put a quote between the key and the `:` separator and slipped the
        // Secret/Password assignment patterns — the most common place a key lives.
        it('scanContent_jsonQuotedApiKey_detected', () => {
            const content = '{ "api_key": "CG-abcd1234efgh5678" }';
            const findings = scanContent(content, 'config.local.json');
            expect(findings.map(f => f.name)).toContain('Secret Assignment');
        });

        it('scanContent_jsonQuotedPassword_detected', () => {
            const content = '{ "password": "hunter2hunter2" }';
            const findings = scanContent(content, 'config.local.json');
            expect(findings.map(f => f.name)).toContain('Password Assignment');
        });
    });

    describe('scanContent_coinGeckoKey', () => {
        // Regression: a bare CG-… token in prose (e.g. inside a security report)
        // slipped every pattern — only the "api_key": "…" assignment forms caught
        // it. A live CoinGecko key leaked this exact way.
        it('scanContent_coinGeckoBareToken_detected', () => {
            const content = 'leaked key CG-' + 'abcDEF123456ghiJKL789mn' + ' in config';
            const findings = scanContent(content, 'docs/.output/findings/reviews/audit.md');
            expect(findings.map(f => f.name)).toContain('CoinGecko API Key');
        });

        it('scanContent_coinGeckoShortRef_noDetection', () => {
            // A changelog reference like "CG-1" must not false-positive.
            const findings = scanContent('see CG-1 in the changelog', 'CHANGELOG.md');
            expect(findings.filter(f => f.name === 'CoinGecko API Key')).toHaveLength(0);
        });
    });

    describe('scanContent_findings_structure', () => {
        it('scanContent_finding_hasRequiredFields', () => {
            const content = `key = "${fakeAwsKey()}"`;
            const findings = scanContent(content, 'config.js');
            expect(findings.length).toBeGreaterThan(0);
            const f = findings[0];
            expect(f).toHaveProperty('type');
            expect(f).toHaveProperty('name');
            expect(f).toHaveProperty('file');
            expect(f).toHaveProperty('line');
            expect(f).toHaveProperty('match');
        });

        it('scanContent_finding_lineNumberIsOneBased', () => {
            const content = 'line1\nline2\n' + fakeAwsKey();
            const findings = scanContent(content, 'test.js');
            const awsFinding = findings.find(f => f.name === 'AWS Access Key');
            expect(awsFinding.line).toBe(3);
        });

        it('scanContent_cleanContent_returnsEmptyArray', () => {
            const findings = scanContent('const x = 1;\nconsole.log(x);\n', 'clean.js');
            expect(findings).toEqual([]);
        });
    });

    // ─── False-positive boundary tests ───────────────────────────────────────

    describe('scanContent_falsePositives', () => {
        it('scanContent_akiaInComment_withNonCredentialChars_noDetection', () => {
            // AKIA followed by lowercase / mixed-case that won't match [0-9A-Z]{16}
            const content = '// AKIA example in a comment — not a real key';
            const findings = scanContent(content, 'README.md');
            const awsFindings = findings.filter(f => f.name === 'AWS Access Key');
            expect(awsFindings).toHaveLength(0);
        });

        it('scanContent_skDashDocumentation_noDetection', () => {
            // A documentation mention "pattern like sk-..." with only a few chars
            const content = 'The API key format looks like `sk-...` or `sk-proj-...`';
            const findings = scanContent(content, 'docs.md');
            const openAiFindings = findings.filter(f =>
                f.name === 'OpenAI Key' || f.name === 'OpenAI Project Key'
            );
            expect(openAiFindings).toHaveLength(0);
        });

        it('scanContent_passwordPlaceholder_changeme_noDetection', () => {
            const content = "password = 'changeme'";
            const findings = scanContent(content, 'config.js');
            const passwordFindings = findings.filter(f => f.name === 'Password Assignment');
            expect(passwordFindings).toHaveLength(0);
        });

        it('scanContent_secretPlaceholder_templateVariable_noDetection', () => {
            const content = 'api_key = "${API_KEY}"';
            const findings = scanContent(content, 'config.js');
            const secretFindings = findings.filter(f => f.name === 'Secret Assignment');
            expect(secretFindings).toHaveLength(0);
        });

        it('scanContent_supabaseEnvironmentReference_noDetection', () => {
            const findings = scanContent('openai_api_key = "env(OPENAI_API_KEY)"', 'config.toml');
            expect(findings.filter(f => f.name === 'Secret Assignment')).toHaveLength(0);
        });

        it('scanContent_mixedCaseEnvironmentValue_stillDetected', () => {
            const findings = scanContent('api_key = "env(aB3xK9mP2qR7tY1wZ5nL8vC4)"', 'config.toml');
            expect(findings.filter(f => f.name === 'Secret Assignment').length).toBeGreaterThan(0);
        });

        // Runtime-binding references: the value is a LOOKUP of the secret, not the
        // secret. Each row used to fire "Secret Assignment (Unquoted)" or the
        // quoted variant on code that merely forwards an env binding.
        it.each([
            ['envDotAccess', 'coingeckoApiKey: env.COINGECKO_API_KEY,'],
            ['cloudflareContextEnv', 'apiKey: context.cloudflare.env.COINGECKO_API_KEY'],
            ['processEnvSemicolon', 'secret: process.env.STRIPE_WEBHOOK_SECRET;'],
            ['importMetaEnv', 'const apiKey = import.meta.env.VITE_API_KEY;'],
            ['processEnvBracketSingleQuote', "apiKey: process.env['COINGECKO_API_KEY'],"],
            ['processEnvBracketDoubleQuote', 'apiKey: process.env["COINGECKO_API_KEY"]'],
            ['pythonEnvironIndex', 'api_key = os.environ["COINGECKO_API_KEY"]'],
            ['pythonEnvironGet', "api_key = os.environ.get('COINGECKO_API_KEY')"],
            ['pythonGetenv', "api_key = os.getenv('COINGECKO_API_KEY')"],
            ['denoEnvGet', 'const apiKey = Deno.env.get("COINGECKO_API_KEY");'],
            ['javaGetenv', 'String apiKey = System.getenv("COINGECKO_API_KEY");'],
            ['dotnetGetEnvironmentVariable', 'var apiKey = Environment.GetEnvironmentVariable("COINGECKO_API_KEY");'],
            ['dotnetConfigurationIndex', 'var secret = builder.Configuration["Graph:ClientSecret"];'],
            ['dotnetGetValue', 'var secret = config.GetValue<string>("Graph:ClientSecret");'],
            ['githubActionsSecrets', 'ClientSecret: ${{ secrets.GRAPH_CLIENT_SECRET }}'],
            ['azureDevOpsMacro', 'apiKey: $(CoinGeckoApiKey)'],
            ['windowsPercentVariable', 'apiKey=%COINGECKO_API_KEY%'],
            ['keyVaultReference', '"ApiKey": "@Microsoft.KeyVault(SecretUri=https://example.vault.azure.net/secrets/CoinGecko/)"'],
            ['inlineCodeEnvDot', 'password: `env.DB_PASS`'],
            ['inlineCodeProcessEnv', 'apiKey = `process.env.STRIPE_KEY`'],
        ])('scanContent_runtimeBindingReference_%s_noDetection', (_name, content) => {
            const findings = scanContent(content, 'src/app.ts');
            expect(findings.filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
        });

        // The exemption is anchored to the WHOLE value and takes a single plain
        // name, so a literal cannot ride a reference shape.
        it.each([
            ['quotedLiteral', 'apiKey: "sk-live-aB3xK9mP2qR7tY1wZ5nL8vC4"'],
            ['literalAfterEnvDot', 'secret: process.env.aB3xK9mP2qR7tY1wZ5nL8vC4'],
            ['envNameWithLiteralSuffix', 'apiKey: env.COINGECKO_API_KEY_aB3xK9mP2qR7tY1w'],
            ['getWithLiteralArgument', 'apiKey = Foo.get("aB3xK9mP2qR7tY1wZ5nL8vC4")'],
            // No space after the comma, so the whole call is one unquoted token
            // and only the one-argument rule can keep it from being exempt.
            ['environGetWithDefaultLiteral', 'api_key = os.environ.get("COINGECKO_API_KEY","aB3xK9mP2qR7tY1wZ5nL8vC4")'],
            // An upper-case name is allowed only behind an environment receiver.
            ['unrelatedReceiverGetUpperName', 'apiKey = cache.get("SUPERSECRETTOKEN9")'],
            ['envIndexWithLowercaseLiteral', 'apiKey: process.env["aB3xK9mP2qR7tY1wZ5nL8vC4"]'],
            ['dottedLiteralPath', 'apiKey: some.thing.aB3xK9mP2qR7tY1wZ5nL8vC4'],
            ['inlineCodeLiteral', 'apiKey: `aB3xK9mP2qR7tY1wZ5nL8vC4`'],
            ['inlineCodeEnvWithLiteralSuffix', 'apiKey: `env.COINGECKO_API_KEY_aB3xK9mP2qR7tY1w`'],
            // A Key Vault reference is one URI with no spaces; text after a space
            // is not part of the reference.
            ['keyVaultWithTrailingLiteral', '"ApiKey": "@Microsoft.KeyVault(SecretUri=https://example.vault.azure.net/secrets/Cg/ aB3xK9mP2qR7tY1wZ5nL8vC4)"'],
        ])('scanContent_runtimeBindingLookalike_%s_stillDetected', (_name, content) => {
            const findings = scanContent(content, 'src/app.ts');
            expect(findings.filter(f => /Secret|Password/.test(f.name)).length).toBeGreaterThan(0);
        });

        // A typed options object access (`settings.ApiKeyValue`) is a reference too. It
        // was a pinned known gap while the exemption only knew env/config lookups; in a
        // SOURCE file the grammar makes an unquoted dotted value an expression, so the
        // source-code allowlist below now covers it. The same line in a config or
        // env-style file is still a finding.
        it('scanContent_typedOptionsAccess_inSourceFile_noDetection', () => {
            const findings = scanContent('apiKey = settings.ApiKeyValue;', 'src/app.ts');
            expect(findings.filter(f => /Secret/.test(f.name))).toHaveLength(0);
        });

        it('scanContent_typedOptionsAccess_inEnvStyleFile_stillDetected', () => {
            const findings = scanContent('apiKey = settings.ApiKeyValue;', '.env');
            expect(findings.filter(f => /Secret/.test(f.name)).length).toBeGreaterThan(0);
        });

        // Source-code reference allowlist: a READ of a secret in application source is not
        // a secret. Each row used to block a commit that merely restaged the file.
        it.each([
            ['requestBodyField', 'const password = String(body.password ?? "");'],
            ['requestHeader', 'const secret = c.req.header("x-admin-secret");'],
            ['identifierWithFallback', 'apiKey: encryptedKey ?? (cfg.apiKey as string)'],
            ['propertyAccess', 'apiKey = settings.ApiKeyValue;'],
            ['lowerCaseHeaderName', 'const secret = c.req.header("authorization");'],
            ['environmentName', 'const apiKey = getenv("COINGECKO_API_KEY", k);'],
            ['callToHelper', 'const adminPassword = loadAdminPassword(ctx);'],
        ])('scanContent_sourceCodeReference_%s_noDetection', (_name, content) => {
            for (const file of ['src/app.ts', 'src/app.tsx', 'lib/app.mjs', 'svc/app.py', 'api/Handler.cs']) {
                const findings = scanContent(content, file);
                expect(findings.filter(f => /Secret|Password/.test(f.name)), file).toHaveLength(0);
            }
        });

        it.each([
            ['bareIdentifierTerminated', 'const password = encryptedKey;'],
            ['environmentObjectWithSibling', 'env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },'],
            ['propertyWithSibling', 'const options = { password: cfg.password, timeout: "10" };'],
            ['callWithSibling', 'const options = { password: decodeURIComponent(url.password), timeout: "10" };'],
            ['multipleDeclarations', 'const password = decodeURIComponent(url.password), retry = "10";'],
            ['outerCallSibling', 'connect({ password: encryptedKey }, "ordinary literal");'],
        ])('scanContent_sourceAssignmentBoundary_%s_noDetection', (_name, content) => {
            const file = 'scripts/query-live.cjs';
            expect(scanContent(content, file)).toHaveLength(0);
            expect(redactSecretsInText(content, file)).toBe(content);
        });

        it.each([
            ['callArgument', 'const password = decrypt(blob, "Winter2024Pass"), retry = "10";'],
            ['fallbackBeforeBoundary', 'const password = cfg.password || "Winter2024Pass", retry = "10";'],
            ['environmentFallback', 'const password = process.env.DB_PASSWORD || "Winter2024Pass";'],
            ['environmentNullishFallback', 'const password = process.env.DB_PASSWORD ?? "Winter2024Pass";'],
            ['quotedPlaceholderConcatenation', 'const password = "placeholder" + "Winter2024Pass";'],
            ['nestedObjectArgument', 'const password = loadSecret({ fallback: "Winter2024Pass" }), retry = "10";'],
            ['nestedCallArgument', 'const password = decrypt(nested("Winter2024Pass"), blob), retry = "10";'],
            ['parenthesizedCommaOperator', 'const password = (encryptedKey, "Winter2024Pass");'],
            ['mismatchedDelimiter', 'const password = loadSecret("DB_PASS" ], retry = "10";'],
        ])('scanContent_sourceAssignmentBoundary_%s_stillDetectsLiteral', (_name, content) => {
            const file = 'scripts/query-live.cjs';
            expect(scanContent(content, file).filter(f => /Secret|Password/.test(f.name)).length).toBeGreaterThan(0);
            expect(redactSecretsInText(content, file)).not.toBe(content);
            if (['environmentFallback', 'environmentNullishFallback', 'quotedPlaceholderConcatenation'].includes(_name)) {
                expect(redactSecretsInText(content, file)).not.toContain('Winter2024Pass');
            }
        });

        it.each([',', ';'])('scanContent_sourceAssignmentBoundary_%s_doesNotHideSiblingSecret', separator => {
            const prefix = 'const password = cfg.password';
            const source = `${prefix}${separator} secret = "Winter2024Pass";`;
            const file = 'scripts/query-live.cjs';
            const findings = scanContent(source, file).filter(f => /Secret|Password/.test(f.name));
            expect(findings).toHaveLength(1);
            expect(redactSecretsInText(source, file)).toContain(prefix);
            expect(redactSecretsInText(source, file)).not.toContain('Winter2024Pass');
        });

        it('scanContent_sourceAssignmentBoundary_namedProviderSiblingStillDetected', () => {
            const content = `const password = cfg.password, providerValue = "${fakeAnthropicKey()}";`;
            expect(scanContent(content, 'scripts/query-live.cjs').some(f => f.name === 'Anthropic Key')).toBe(true);
        });

        it('scanContent_sourceAssignmentBoundary_pythonTupleRemainsOneValue', () => {
            const content = 'password = cfg.password, "Winter2024Pass"';
            expect(scanContent(content, 'scripts/query.py').length).toBeGreaterThan(0);
            expect(redactSecretsInText(content, 'scripts/query.py')).not.toBe(content);
        });

        // The exemption must not become a way to hide a credential. Each row below is
        // credential-shaped, in the wrong file type, or has no expression context.
        it.each([
            ['envFileLiteral', 'API_KEY=aB3xK9mP2qR7tY1wZ5nL8vC4', '.env'],
            ['envFileDottedReference', 'apiKey = settings.ApiKeyValue;', '.env'],
            ['yamlDottedReference', 'password: some.nested.reference', 'config.yaml'],
            ['markdownReference', 'password: some.nested.reference', 'README.md'],
            ['bareLiteralAtEndOfLine', 'apiKey = hunter2xyzSecret', 'src/app.ts'],
            ['callWithCredentialArgument', 'apiKey = Foo.get("aB3xK9mP2qR7tY1wZ5nL8vC4")', 'src/app.ts'],
            ['dottedCredentialSegment', 'apiKey: some.thing.aB3xK9mP2qR7tY1wZ5nL8vC4', 'src/app.ts'],
            ['quotedLiteral', 'password: "hunter2Secret"', 'src/app.ts'],
            // Adversarial review: the unquoted regexes capture \S{8,}, which stops at the first space,
            // so every guard must judge the rest of the line, not just the capture.
            ['spacedCallArgument', 'const apiKey = Foo.get( "aB3xK9mP2qR7tY1wZ5nL8vC4" );', 'src/app.ts'],
            ['laterCallArgument', 'const apiKey = decrypt(blob, "aB3xK9mP2qR7tY1wZ5nL8vC4");', 'src/app.ts'],
            ['pythonLaterCallArgument', "secret = decode(token, 'aB3xK9mP2qR7tY1wZ5nL8vC4')", 'svc/app.py'],
            ['credentialAfterDottedToken', 'authToken = cfg.value  aB3xK9mP2qR7tY1wZ5nL8vC4', 'src/app.ts'],
            ['shortLiteralCallArgument', 'const adminPassword = bcrypt.hashSync("Winter2024Pass", 10);', 'src/app.ts'],
            ['shortLiteralSingleArgument', 'const apiKey = getKey("Winter2024Pass");', 'src/app.ts'],
            ['goLiteralArgument', 'password = decrypt("hunter2abc", k)', 'svc/app.go'],
            ['passwordEndingInParenthesisInComment', '// password: Summer2024(!)', 'src/app.ts'],
            ['hashCommentCredential', '# DB_PASSWORD=Hunter2(abc)x', 'svc/app.py'],
            ['shellExportInString', 'execSync("export PGPASSWORD=Summer2024Pw && pg_dump db")', 'src/app.js'],
            ['shellAssignmentInString', 'os.system("API_KEY=tok_a1b2c3d4_e5f6g7h8 && run")', 'svc/app.py'],
            ['sqlPasswordWithContinuation', 'CREATE USER app PASSWORD = Summer2024Pw && x', 'svc/app.py'],
            ['bareIdentifierWithDigits', 'const apiKey = Winter2024Pass || fallback;', 'src/app.ts'],
            // A separator-free lower-case word has the same shape as a header name, so it is a name
            // only directly inside a name-lookup callee (header/get/getenv/...), never in any call.
            ['lowerCaseWordToHasher', 'const adminPassword = bcrypt.hashSync("letmeinplease", 10);', 'src/seed.ts'],
            ['lowerCaseWordToGetKey', 'const apiKey = getKey("hunterhunter");', 'svc/app.py'],
            ['lowerCasePasswordToHash', 'const password = hash("password");', 'src/app.ts'],
            ['upperCaseWordWithoutSeparator', 'const apiKey = getKey("HUNTERHUNTER");', 'src/app.ts'],
        ])('scanContent_sourceCodeLookalike_%s_stillDetected', (_name, content, file) => {
            const findings = scanContent(content, file);
            expect(findings.filter(f => /Secret|Password/.test(f.name)).length).toBeGreaterThan(0);
        });

        it('scanContent_sourceCodeReference_withoutFilePath_isNotExempt', () => {
            const unknown = scanContent('password: some.nested.reference', undefined);
            expect(unknown.filter(f => /Secret|Password/.test(f.name)).length).toBeGreaterThan(0);
        });

        it('scanContent_sourceCodeReference_pathCaseAndSeparators_followTheSameRule', () => {
            const line = 'const password = String(body.password ?? "");';
            expect(scanContent(line, 'SRC\\App.TS').filter(f => /Password/.test(f.name))).toHaveLength(0);
            expect(scanContent(line, 'notes.TXT').filter(f => /Password/.test(f.name)).length).toBeGreaterThan(0);
        });

        // A TypeScript type-member declaration holds no value (Cloudflare's generated
        // `wrangler types` output has exactly this shape).
        it('scanContent_typeMemberDeclaration_inTypeScript_noDetection', () => {
            const content = ['interface Creds {', '    password: SomeComponentResult;', '    readonly secret?: Record<string, string>;', '}'].join('\n');
            for (const file of ['worker-configuration.d.ts', 'src/types.ts', 'src/types.mts']) {
                expect(scanContent(content, file).filter(f => /Secret|Password/.test(f.name)), file).toHaveLength(0);
            }
        });

        it.each([
            ['hexValue', '    password: 8f14e45fceea167a5a36dedd4bea2543;', 'src/types.ts'],
            // Outside an interface/type block this is a template literal rendering config, not a type.
            ['outsideTypeBlock', 'password: Winter2024Pass', 'src/infra.ts'],
            ['outsideTypeBlockTsx', '  secret: CorrectHorseBatteryStaple', 'src/App.tsx'],
            ['outsideTypeBlockMts', 'DB_PASSWORD: Winter2024Pass', 'src/infra.mts'],
            ['catNGutterOutsideBlock', '    12\t  password: Winter2024Pass', 'src/infra.ts'],
            ['quotedValue', '    password: "hunter2Secret";', 'src/types.ts'],
            ['dottedCredential', '    secret: process.env.aB3xK9mP2qR7tY1wZ5nL8vC4;', 'src/types.ts'],
            ['markdownProse', '    password: SomeComponentResult;', 'notes.md'],
            ['yamlValue', '    password: SomeComponentResult;', 'config.yaml'],
        ])('scanContent_typeMemberLookalike_%s_stillDetected', (_name, content, file) => {
            const findings = scanContent(content, file);
            expect(findings.filter(f => /Secret|Password/.test(f.name)).length).toBeGreaterThan(0);
        });

        // CRLF working copies, and Read output with a `cat -n` gutter, are judged like the LF file.
        it('scanContent_typeMemberDeclaration_crlfAndGutter_noDetection', () => {
            const crlf = 'interface A {\r\n  password: SomeType;\r\n}\r\n';
            expect(scanContent(crlf, 'x.d.ts').filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
            expect(scanContent(crlf, 'x.ts').filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
            const gutter = ['     1\tinterface A {', '     2\t  password: SomeType;', '     3\t}'].join('\n');
            expect(scanContent(gutter, 'x.ts').filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
            const codeCrlf = 'const password = String(body.password ?? "");\r\n';
            expect(scanContent(codeCrlf, 'x.ts').filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
        });

        it('scanContent_braceInsideAStringInATypeBlock_doesNotLeaveTheBlockOpen', () => {
            const content = ['interface A {', '  a: "{";', '}', 'const t = `', 'password: Winter2024Pass', '`;'].join('\n');
            const lines = scanContent(content, 'a.ts').filter(f => /Secret|Password/.test(f.name)).map(f => f.line);
            expect(lines).toEqual([5]);
        });

        // A `.d.ts` holds only declarations, so a member needs no enclosing block there.
        it('scanContent_typeMemberDeclaration_inDeclarationFile_noBlockNeeded', () => {
            const findings = scanContent('    password: SomeComponentResult;', 'worker-configuration.d.ts');
            expect(findings.filter(f => /Secret|Password/.test(f.name))).toHaveLength(0);
        });

        it('isTypeAnnotationLine_rejectsProseAndOversizedLines_acceptsGenericsAndUnions', () => {
            expect(isTypeAnnotationLine('password: correct horse battery staple;', 'types.d.ts')).toBe(false);
            expect(isTypeAnnotationLine('password: ' + 'a'.repeat(500) + ';', 'types.d.ts')).toBe(false);
            expect(isTypeAnnotationLine('secret?: Record<string, string> | undefined;', 'types.d.ts')).toBe(true);
            expect(isTypeAnnotationLine('secret: keyof Creds;', 'types.d.ts')).toBe(true);
            expect(isTypeAnnotationLine('secret: SomeType;', 'types.js')).toBe(false);
            expect(isTypeAnnotationLine('secret: SomeType;', 'src/types.ts')).toBe(false);
            expect(isTypeAnnotationLine('secret: SomeType;', 'src/types.ts', true)).toBe(true);
        });

        it('isTypeAnnotationLine_longWhitespaceRun_isLinear', () => {
            const started = Date.now();
            isTypeAnnotationLine('password: aaaaaaaa' + ' '.repeat(40000) + '#', 'types.d.ts');
            expect(Date.now() - started).toBeLessThan(100);
        });

        // The scanner and the redactor share one decision per occurrence. An identical text on an
        // earlier EXEMPT line must not exempt a later line that the scanner flags.
        const agreementFixture = [
            'const a = (password = Winter2024Pass || fallback);',
            '',
            'const t = `',
            'password = Winter2024Pass',
            '`;',
        ].join('\n');

        it('redactSecretsInText_identicalTextOnAnEarlierExemptLine_doesNotExemptTheLaterOne', () => {
            const flagged = scanContent(agreementFixture, 'x.ts').filter(f => /Password/.test(f.name));
            expect(flagged.map(f => f.line)).toContain(4);
            const redacted = redactSecretsInText(agreementFixture, 'x.ts').split('\n');
            expect(redacted[3]).toContain('<REDACTED:');
        });

        it('scannerAndRedactor_agreeOnEveryLineOfAMixedSourceFile', () => {
            const content = [
                'const password = String(body.password ?? "");',
                'const authToken = c.env.TWILIO_AUTH_TOKEN;',
                'apiKey: encryptedKey ?? (cfg.apiKey as string)',
                'const apiKey = decrypt(blob, "aB3xK9mP2qR7tY1wZ5nL8vC4");',
                'const adminPassword = bcrypt.hashSync("Winter2024Pass", 10);',
                'interface Creds {',
                '    password: SomeComponentResult;',
                '}',
                'const rendered = `',
                'password: Winter2024Pass',
                '`;',
            ].join('\n');
            const flaggedLines = new Set(scanContent(content, 'src/app.ts').filter(f => /Secret|Password/.test(f.name)).map(f => f.line));
            const redacted = redactSecretsInText(content, 'src/app.ts').split('\n');
            const original = content.split('\n');
            original.forEach((line, i) => {
                const changed = redacted[i] !== line;
                expect(changed, `line ${i + 1}: ${line}`).toBe(flaggedLines.has(i + 1));
            });
        });

        it('redactSecretsInText_manyGenericMatches_staysLinear', () => {
            const text = Array.from({ length: 20000 }, (_, i) => `db_password=Winter${i}Pass${i}x`).join('\n');
            for (const file of ['<bash output>', 'src/app.ts']) {
                const started = Date.now();
                redactSecretsInText(text, file);
                expect(Date.now() - started, file).toBeLessThan(1500);
            }
        });

        // redactSecretsInText gets the path so the read-output scrubber agrees with the scanner.
        it('redactSecretsInText_sourceReference_leftIntactForSourceFile', () => {
            const text = 'const authToken = c.env.TWILIO_AUTH_TOKEN;';
            expect(redactSecretsInText(text, 'src/app.ts')).toBe(text);
        });

        it('redactSecretsInText_sameLineWithoutPath_isRedacted', () => {
            const text = 'password: some.nested.reference';
            expect(redactSecretsInText(text)).not.toBe(text);
            expect(redactSecretsInText(text, 'config.yaml')).not.toBe(text);
        });

        it('scanContent_dummyPrefixValue_test123_noDetection', () => {
            // Documented dummy fixture (e.g. the secret-scanner protocol example) — not a real key
            const content = 'apiKey: "test-123"';
            const findings = scanContent(content, 'CLAUDE.md');
            const secretFindings = findings.filter(f => f.name === 'Secret Assignment');
            expect(secretFindings).toHaveLength(0);
        });

        it('scanContent_dummyPrefixValue_mockKey_noDetection', () => {
            const content = 'apiKey = "mock-key"';
            const findings = scanContent(content, 'config.js');
            expect(findings.filter(f => f.name === 'Secret Assignment')).toHaveLength(0);
        });

        it('scanContent_dummyPrefixGenericHighEntropy_stillDetected', () => {
            // F2 regression: pins the suffix cap INDEPENDENT of any named-provider pattern.
            // A dummy-prefixed value whose suffix exceeds the cap and matches NO dedicated
            // pattern (pure alnum, no `sk_live_`/`AKIA`/etc.) must still block as a generic
            // Secret Assignment. The prior probe used `test-sk_live_…`, which blocked via the
            // Stripe pattern — so it stayed green even when the cap was removed (false confidence).
            const content = 'apiKey = "mock-aB3xK9mP2qR7tY1wZ5nL8vC4"';
            const findings = scanContent(content, 'config.js');
            expect(findings.filter(f => f.name === 'Secret Assignment').length).toBeGreaterThan(0);
        });

        it('scanContent_dummyPrefixNamedSecret_stillDetected', () => {
            // The allowlist never suppresses a named-provider secret — dedicated patterns
            // bypass PLACEHOLDER_PATTERNS entirely, so a dummy prefix can't smuggle one through.
            // Key assembled from fragments so no whole AWS-example literal exists in
            // THIS source file — story 3C now scans test files with the named-provider
            // patterns, and a contiguous literal here would trip the repo's own
            // pre-commit scan and block committing this file. Runtime value unchanged,
            // so detection is still asserted below.
            const content = 'awsKey = "test-' + 'AKIA' + 'IOSFODNN7EXAMPLE"';
            const findings = scanContent(content, 'config.js');
            expect(findings.length).toBeGreaterThan(0);
        });

        it('scanContent_emptyString_returnsEmptyArray', () => {
            const findings = scanContent('', 'empty.js');
            expect(findings).toEqual([]);
        });
    });

    // ─── namedProvidersOnly mode (test-file scanning) ────────────────────────
    // Test/spec files are no longer wholesale-skipped: a real provider secret
    // pasted there is still a leak. Callers pass { namedProvidersOnly: true }
    // for these paths, which suppresses ONLY the generic Password/Secret
    // Assignment patterns (fixture false-positive noise) while every
    // named-provider pattern keeps firing.
    describe('scanContent_namedProvidersOnly', () => {
        it('scanContent_namedProvidersOnly_awsKeyInTestFile_stillDetected', () => {
            const content = `const key = "${fakeAwsKeyNotPlaceholder()}";`;
            const findings = scanContent(content, 'foo.test.js', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).toContain('AWS Access Key');
        });

        it('scanContent_namedProvidersOnly_awsDocumentedExampleKey_exempted', () => {
            // AWS's own published example access key (AKIAIOSFODNN7EXAMPLE) is
            // extremely common in SDK test fixtures/READMEs — it must not block
            // a commit when it shows up in a test file. fakeAwsKey() happens to
            // produce this exact literal once the regex trims it to 16 chars.
            const content = `const key = "${fakeAwsKey()}";`;
            const findings = scanContent(content, 'foo.test.js', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).not.toContain('AWS Access Key');
        });

        it('scanContent_namedProvidersOnly_awsDocumentedExampleKey_notExemptedOutsideTestFileMode', () => {
            // The exemption is scoped to namedProvidersOnly (test-file) mode only —
            // default-mode scanning of a non-test file still flags it.
            const content = `const key = "${fakeAwsKey()}";`;
            const findings = scanContent(content, 'config.js');
            expect(findings.map(f => f.name)).toContain('AWS Access Key');
        });

        it('scanContent_namedProvidersOnly_anthropicKeyInTestFile_stillDetected', () => {
            const content = `ANTHROPIC_API_KEY=${fakeAnthropicKey()}`;
            const findings = scanContent(content, 'foo.test.js', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).toContain('Anthropic Key');
        });

        it('scanContent_namedProvidersOnly_genericPasswordAssignment_suppressed', () => {
            const content = 'password = "hunter2hunter2"';
            const findings = scanContent(content, 'foo.test.js', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).not.toContain('Password Assignment');
        });

        it('scanContent_namedProvidersOnly_genericSecretAssignment_suppressed', () => {
            const content = 'apiKey = "aB3xK9mP2qR7tY1wZ5nL8vC4"';
            const findings = scanContent(content, 'foo.spec.ts', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).not.toContain('Secret Assignment');
        });

        it('scanContent_namedProvidersOnly_genericUnquotedAssignment_suppressed', () => {
            const content = 'export DB_PASSWORD=SuperSecretPass123';
            const findings = scanContent(content, '__tests__/config.js', { namedProvidersOnly: true });
            expect(findings.map(f => f.name)).not.toContain('Password Assignment (Unquoted)');
        });

        it('scanContent_defaultMode_nonTestFile_namedAndGenericBothDetected', () => {
            // Non-test-file behavior is unchanged: no options arg → both classes fire.
            const content = `const key = "${fakeAwsKey()}";\npassword = "hunter2hunter2"`;
            const findings = scanContent(content, 'config.js');
            const names = findings.map(f => f.name);
            expect(names).toContain('AWS Access Key');
            expect(names).toContain('Password Assignment');
        });
    });
});

// ─── isHardSkipPath / isTestFilePath ──────────────────────────────────────────

describe('isHardSkipPath', () => {
    it('isHardSkipPath_nodeModules_returnsTrue', () => {
        expect(isHardSkipPath('/project/node_modules/lodash/index.js')).toBe(true);
    });

    it('isHardSkipPath_gitDirectory_returnsTrue', () => {
        expect(isHardSkipPath('/project/.git/config')).toBe(true);
    });

    it('isHardSkipPath_testFile_returnsFalse', () => {
        // Test files are NOT hard-skipped — they're scanned in namedProvidersOnly mode.
        expect(isHardSkipPath('/project/src/auth.test.js')).toBe(false);
        expect(isHardSkipPath('/project/src/__tests__/auth.js')).toBe(false);
    });

    it('isHardSkipPath_regularSourceFile_returnsFalse', () => {
        expect(isHardSkipPath('/project/src/index.js')).toBe(false);
    });
});

describe('isTestFilePath', () => {
    it('isTestFilePath_testJs_returnsTrue', () => {
        expect(isTestFilePath('/project/src/auth.test.js')).toBe(true);
    });

    it('isTestFilePath_specTs_returnsTrue', () => {
        expect(isTestFilePath('/project/src/auth.spec.ts')).toBe(true);
    });

    it('isTestFilePath_testsDirectory_returnsTrue', () => {
        expect(isTestFilePath('/project/src/__tests__/auth.js')).toBe(true);
    });

    it('isTestFilePath_regularSourceFile_returnsFalse', () => {
        expect(isTestFilePath('/project/src/index.js')).toBe(false);
    });

    it('isTestFilePath_nodeModules_returnsFalse', () => {
        expect(isTestFilePath('/project/node_modules/lodash/index.js')).toBe(false);
    });
});

// ─── shouldSkipPath ───────────────────────────────────────────────────────────

describe('shouldSkipPath', () => {
    it('shouldSkipPath_gitDirectory_returnsTrue', () => {
        expect(shouldSkipPath('/project/.git/config')).toBe(true);
    });

    it('shouldSkipPath_nodeModules_returnsTrue', () => {
        expect(shouldSkipPath('/project/node_modules/lodash/index.js')).toBe(true);
    });

    it('shouldSkipPath_docsOutput_returnsFalse', () => {
        // docs/.output/ is deliberately NOT skipped — its generated reviews/
        // digests routinely quote config and are the most likely place to echo
        // a real secret (a /review:security report once leaked a live key here).
        expect(shouldSkipPath('/project/docs/.output/findings/reviews/x-security-audit.md')).toBe(false);
        expect(shouldSkipPath('/project/docs/.output/handoffs/x-end-main.md')).toBe(false);
        expect(shouldSkipPath('/project/docs/.output/plans/my-plan.md')).toBe(false);
    });

    it('shouldSkipPath_secretScannerItself_returnsTrue', () => {
        expect(shouldSkipPath('/project/.claude/hooks/secret-scanner.cjs')).toBe(true);
    });

    it('shouldSkipPath_secretPatternsItself_returnsTrue', () => {
        expect(shouldSkipPath('/project/.claude/hooks/secret-patterns.cjs')).toBe(true);
    });

    it('shouldSkipPath_regularSourceFile_returnsFalse', () => {
        expect(shouldSkipPath('/project/src/index.js')).toBe(false);
    });

    it('shouldSkipPath_skillsAndTemplates_returnsFalse', () => {
        // .claude/skills/ and .claude/templates/ are NO LONGER skipped — .claude/
        // is exactly what ships to every fleet adopter, so a secret authored into
        // a SKILL.md, a skill asset, or a template config must be scanned. Same
        // blind-spot class as the removed docs/.output/ skip.
        expect(shouldSkipPath('/project/.claude/skills/foo/SKILL.md')).toBe(false);
        expect(shouldSkipPath('/project/.claude/skills/foo/assets/example.env')).toBe(false);
        expect(shouldSkipPath('/project/.claude/templates/root/gitignore')).toBe(false);
    });

    it('shouldSkipPath_testFixtures_returnsTrue', () => {
        // Test-fixture skips are intentionally KEPT — they legitimately hold mock
        // secrets for auth-flow fixtures; code review is the right gate there.
        expect(shouldSkipPath('/project/src/__tests__/auth.js')).toBe(true);
        expect(shouldSkipPath('/project/src/auth.test.js')).toBe(true);
        expect(shouldSkipPath('/project/src/auth.spec.ts')).toBe(true);
    });

    it('secretInSkillFile_isNowScanned', () => {
        // End-to-end: a secret in a skill markdown file now produces a finding
        // (it was previously skipped wholesale and shipped unscanned).
        const findings = scanContent(
            `const key = "${fakeAwsKey()}";`,
            '/project/.claude/skills/x/SKILL.md'
        );
        expect(findings.map(f => f.name)).toContain('AWS Access Key');
    });

    it('shouldSkipPath_envFile_returnsFalse', () => {
        // .env is NOT in SKIP_PATHS — it's a high-risk file but still scanned
        expect(shouldSkipPath('/project/.env')).toBe(false);
    });

    it('shouldSkipPath_windowsBackslash_normalizedCorrectly', () => {
        // Windows-style paths should be handled via normalization
        expect(shouldSkipPath('C:\\project\\node_modules\\lodash\\index.js')).toBe(true);
    });
});

// ─── formatFindings ───────────────────────────────────────────────────────────

describe('formatFindings', () => {
    it('formatFindings_emptyArray_returnsNull', () => {
        expect(formatFindings([])).toBeNull();
    });

    it('formatFindings_singleFinding_containsExpectedFields', () => {
        const findings = [{
            type: 'SECRET_PATTERN',
            name: 'AWS Access Key',
            file: 'config.js',
            line: 3,
            match: 'AKIA1234...5678',
        }];
        const output = formatFindings(findings);
        expect(typeof output).toBe('string');
        expect(output).toContain('AWS Access Key');
        expect(output).toContain('config.js');
        expect(output).toContain(':3');
        expect(output).toContain('AKIA1234...5678');
    });

    it('formatFindings_multiplefindings_containsCount', () => {
        const findings = [
            { type: 'SECRET_PATTERN', name: 'AWS Access Key', file: 'a.js', line: 1, match: 'AKIA...1234' },
            { type: 'SECRET_PATTERN', name: 'OpenAI Key', file: 'b.js', line: 5, match: 'sk-ab...cdef' },
        ];
        const output = formatFindings(findings);
        expect(output).toContain('2 potential secret(s)');
    });

    it('formatFindings_output_containsSeparators', () => {
        const findings = [{
            type: 'SECRET_PATTERN',
            name: 'Test Pattern',
            file: 'test.js',
            line: 1,
            match: 'redacted',
        }];
        const output = formatFindings(findings);
        expect(output).toContain('========================================');
        expect(output).toContain('SECRET SCANNER');
    });

    it('formatFindings_finding_lineZero_omitsLineNumber', () => {
        const findings = [{
            type: 'HIGH_RISK_FILE',
            name: 'Sensitive file type',
            file: '.env',
            line: 0,
            match: '.env',
        }];
        const output = formatFindings(findings);
        // line: 0 → no ":0" suffix appended
        expect(output).not.toContain(':0');
    });
});

// ─── redact ──────────────────────────────────────────────────────────────────

describe('redact', () => {
    it('redact_shortValue_showsFirstFourPlusMask', () => {
        const result = redact('abc123');
        expect(result).toMatch(/^abc1\*{3}$/);
    });

    it('redact_longValue_showsHeadAndTail', () => {
        const longVal = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const result = redact(longVal);
        expect(result).toContain('ABCDEFGH');
        expect(result).toContain('...');
        expect(result.endsWith(longVal.slice(-4))).toBe(true);
    });

    it('redact_exactlyTwelveChars_useShortPath', () => {
        // length <= 12 → short path
        const val = '123456789012';
        const result = redact(val);
        expect(result).toMatch(/^1234\*{3}$/);
    });

    it('redact_thirteenChars_useLongPath', () => {
        // length > 12 → long path
        const val = '1234567890123';
        const result = redact(val);
        expect(result).toContain('...');
    });

    // ─── redact — named-provider secrets never leak real bytes ───────────────
    describe('redact_namedProvider', () => {
        it('redact_awsKey_omitsLastFourRealBytes', () => {
            const value = fakeAwsKey();
            const result = redact(value, 'AWS Access Key');
            expect(result).not.toContain(value.slice(-4));
            expect(result).not.toContain(value);
        });

        it('redact_anthropicKey_omitsAnyRealBytes', () => {
            const value = fakeAnthropicKey();
            const result = redact(value, 'Anthropic Key');
            expect(result).not.toContain(value.slice(-4));
            expect(result).not.toContain(value.slice(0, 8));
        });

        it('redact_namedProvider_includesProviderNameAndLength', () => {
            const value = fakeAwsKey();
            const result = redact(value, 'AWS Access Key');
            expect(result).toContain('AWS Access Key');
            expect(result).toContain(String(value.length));
        });

        it('redact_genericPatternName_keepsOriginalHeadTailBehavior', () => {
            // Passing a GENERIC pattern name explicitly preserves the original
            // head+tail behavior (backward compatible with the no-arg call).
            const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            const result = redact(value, 'Secret Assignment');
            expect(result.endsWith(value.slice(-4))).toBe(true);
        });
    });
});

// ─── redactSecretsInText (R7 — tool-output secret redaction) ──────────────────

describe('redactSecretsInText', () => {

    it('redactSecretsInText_secretInContent_replacedWithToken', () => {
        // AC1: secret detected in content → replaced with <REDACTED:PatternName>
        const fakeKey = fakeAwsKey();
        const content = `export const key = "${fakeKey}";`;
        const result = redactSecretsInText(content);

        expect(result).not.toContain(fakeKey);
        expect(result).toContain('<REDACTED:AWS Access Key>');
    });

    it('redactSecretsInText_multipleSecrets_allReplaced', () => {
        // AC1: multi-pattern coverage — AWS + Anthropic in one blob, both replaced
        const aws = fakeAwsKey();
        const ant = fakeAnthropicKey();
        const content = `aws=${aws}\nant=${ant}\n`;
        const result = redactSecretsInText(content);

        expect(result).not.toContain(aws);
        expect(result).not.toContain(ant);
        expect(result).toContain('<REDACTED:AWS Access Key>');
        expect(result).toContain('<REDACTED:Anthropic Key>');
    });

    it('redactSecretsInText_placeholderNotRedacted', () => {
        // AC2: Password Assignment with placeholder value → unchanged
        const content = 'password = "changeme"';
        const result = redactSecretsInText(content);

        expect(result).toBe(content);
    });

    it('redactSecretsInText_placeholderEnvVarNotRedacted', () => {
        // AC2: ${VARIABLE} placeholder → unchanged
        const content = 'api_key = "${API_KEY}"';
        const result = redactSecretsInText(content);

        expect(result).toBe(content);
    });

    it('redactSecretsInText_cleanContent_unchanged', () => {
        // AC1 negative: no patterns match → content returned as-is
        const content = 'const x = 42;\nconsole.log(x);\n';
        const result = redactSecretsInText(content);

        expect(result).toBe(content);
    });

    it('redactSecretsInText_emptyContent_returnsEmpty', () => {
        // Edge case: empty input
        expect(redactSecretsInText('')).toBe('');
    });

    it('redactSecretsInText_preservesSurroundingText', () => {
        // Substitution must not damage surrounding non-secret content
        const fakeKey = fakeAwsKey();
        const content = `before\nkey="${fakeKey}"\nafter`;
        const result = redactSecretsInText(content);

        expect(result).toMatch(/^before\n/);
        expect(result).toMatch(/\nafter$/);
        expect(result).toContain('<REDACTED:AWS Access Key>');
    });

    // F76 — unquoted assignment must be redacted too, not just detected.
    it('redactSecretsInText_unquotedShellExportPassword_redacted', () => {
        const content = 'export DB_PASSWORD=SuperSecretPass123';
        const result = redactSecretsInText(content);

        expect(result).not.toContain('SuperSecretPass123');
        expect(result).toContain('<REDACTED:Password Assignment (Unquoted)>');
    });

    it('redactSecretsInText_unquotedYamlSecret_redacted', () => {
        const content = 'api_key: aB3xK9mP2qR7tY1wZ5nL8vC4';
        const result = redactSecretsInText(content);

        expect(result).not.toContain('aB3xK9mP2qR7tY1wZ5nL8vC4');
        expect(result).toContain('<REDACTED:Secret Assignment (Unquoted)>');
    });

    it('redactSecretsInText_unquotedPlaceholder_notRedacted', () => {
        // Placeholder/false-positive guard on the redaction path too.
        const content = 'password=changeme';
        const result = redactSecretsInText(content);

        expect(result).toBe(content);
    });

});
