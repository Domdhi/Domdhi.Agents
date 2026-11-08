// The engine config (secret-engine.toml), the pins/names file (secret-engine.json) and the fallback
// list in secret-patterns.cjs must say the same thing. These tests keep the three in step.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const patterns = require('../../../.agents/hooks/secret-patterns.cjs');
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const binLib = require('../../../.agents/core/_lib/secret-engine-bin');

const configDir = path.join(__dirname, '..', '..', 'config');
const toml = fs.readFileSync(path.join(configDir, 'secret-engine.toml'), 'utf8');
const pins = JSON.parse(fs.readFileSync(path.join(configDir, 'secret-engine.json'), 'utf8'));
const names = new Map(pins.ruleNames);

// Rule blocks: id, regex, keywords, and the whole block text.
const rules = toml.split(/^\[\[rules\]\]\s*$/m).slice(1).map(block => ({
    id: (block.match(/^id = "([^"]+)"/m) || [])[1],
    regex: (block.match(/^regex = '''([\s\S]*?)'''/m) || [])[1],
    keywords: (block.match(/^keywords = \[([^\]]*)\]/m) || [])[1],
    description: (block.match(/^description = "([^"]*)"/m) || [])[1],
    block,
}));

describe('config file', () => {
    it('is accepted by the pinned engine (betterleaks config check)', () => {
        const status = engine.engineStatus({ fresh: true });
        expect(status.available, status.message).toBe(true);
        const r = spawnSync(status.bin, ['config', 'check', '--config', engine.CONFIG_PATH], { encoding: 'utf8' });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout + r.stderr).toMatch(/OK:/);
    });

    it('extends the built-in rules and disables the built-in path prefilter', () => {
        expect(toml).toMatch(/^\[extend\]\s*\nuseDefault = true/m);
        expect(toml).toMatch(/^prefilter = "false"/m);
    });

    it('has no network validation anywhere: no validate expressions, no http calls', () => {
        expect(toml).not.toMatch(/^\s*validate\s*=/m);
        expect(toml).not.toMatch(/\bhttp\.(get|post)\b/);
        expect(toml).not.toMatch(/--validation/);
    });

    it('gives every rule an id, a description, a regex and keywords', () => {
        expect(rules.length).toBeGreaterThan(50);
        for (const r of rules) {
            expect(r.id, 'id').toBeTruthy();
            expect(r.description, r.id).toBeTruthy();
            expect(r.regex, r.id).toBeTruthy();
            expect(r.keywords, `${r.id} keywords`).toBeTruthy();
        }
        expect(new Set(rules.map(r => r.id)).size).toBe(rules.length);
    });
});

describe('pins and names file', () => {
    it('names every provider rule and every name belongs to a rule', () => {
        const ids = new Set(rules.map(r => r.id));
        const generic = new Set(pins.genericRuleIds);
        for (const r of rules) {
            if (generic.has(r.id)) continue;
            expect(names.has(r.id), `no display name for ${r.id}`).toBe(true);
        }
        for (const id of names.keys()) {
            if (id.startsWith('domdhi-')) expect(ids.has(id), `${id} is named but not defined`).toBe(true);
        }
    });

    it('lists the same generic rules in secret-engine.json and in the global filter of the config', () => {
        const list = toml.match(/let generic = finding\["rule_id"\] in \[([\s\S]*?)\];/);
        expect(list, 'the "generic" list in the global filter').toBeTruthy();
        const inFilter = [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
        expect(inFilter).toEqual([...pins.genericRuleIds].sort());
    });

    it('defines every domdhi generic rule it lists', () => {
        const ids = new Set(rules.map(r => r.id));
        for (const id of pins.genericRuleIds.filter(i => i.startsWith('domdhi-'))) expect(ids.has(id), id).toBe(true);
    });

    it('names generic findings with the four retired generic display names', () => {
        for (const id of ['generic-password', 'generic-api-key', 'generic-username']) {
            expect(patterns.GENERIC_PATTERN_NAMES.has(names.get(id)), id).toBe(true);
        }
        expect(engine.isGenericRule('domdhi-secret-line')).toBe(true);
        expect(engine.isGenericRule('generic-credential-uri')).toBe(false);
        expect(engine.isGenericRule('stripe-access-token')).toBe(false);
    });
});

// RE2 has no lookahead and the engine reports a capture group as the secret, so the rules differ
// from the fallback list in a few documented ways. Everything else must be byte-for-byte equal
// once flags and capture groups are normalised.
const EXCEPTIONS = {
    'OpenAI Key': 'RE2 has no lookahead; sk-proj- and sk-ant- keys do not match the toml rule because a hyphen follows "sk-" + 4 letters',
    'AWS Secret Key': 'captures the value so only the value is the secret; [ \\t] instead of \\s so a match cannot span lines',
    'AWS Session Token': 'captures the value so only the value is the secret; [ \\t] instead of \\s so a match cannot span lines',
    'Azure SAS Token': 'captures the signature as the secret and allows a quote or space after it',
    'Bearer Token': 'captures the token as the secret; [ \\t] instead of \\s',
    'Private Key': 'replaced by domdhi-private-key-block, which also takes the body lines that follow the header',
    'PGP Private Key': 'replaced by domdhi-private-key-block, which also takes the body lines that follow the header',
    'Connection String': 'replaced by domdhi-connection-string, which captures the password and applies the placeholder filter',
    'Database URL': 'replaced by domdhi-database-url, which captures the password and applies the placeholder filter',
};

function normalise(source, flags) {
    // "\/" and "/" are the same character; a capture group is dropped because only the group would be the secret.
    const body = source.replace(/\\\//g, '/').replace(/(?<!\\)\((?!\?)/g, '(?:');
    return (flags && flags.includes('i') ? '(?i)' : '') + body;
}

describe('provider rules mirror the fallback list', () => {
    const byName = new Map();
    for (const [id, name] of names) {
        if (!id.startsWith('domdhi-') || !rules.some(r => r.id === id)) continue;
        byName.set(name, [...(byName.get(name) || []), rules.find(r => r.id === id)]);
    }

    for (const p of patterns.NAMED_PROVIDER_PATTERNS) {
        if (EXCEPTIONS[p.name]) {
            it(`${p.name}: differs on purpose (${EXCEPTIONS[p.name].slice(0, 60)}...)`, () => {
                expect(EXCEPTIONS[p.name]).toBeTruthy();
            });
            continue;
        }
        it(`${p.name}: a domdhi rule carries the same pattern`, () => {
            const candidates = byName.get(p.name) || [];
            expect(candidates.length, `no domdhi rule named "${p.name}"`).toBeGreaterThan(0);
            const want = normalise(p.regex.source, p.regex.flags);
            expect(candidates.map(r => normalise(r.regex, '')), `toml rule for ${p.name}`).toContain(want);
        });
    }

    it('gives every rule keywords that occur in the matching text (so the pre-filter cannot hide a match)', () => {
        for (const r of rules.filter(x => x.id.startsWith('domdhi-') && !pins.genericRuleIds.includes(x.id))) {
            const kws = [...r.keywords.matchAll(/"([^"]+)"/g)].map(m => m[1]);
            expect(kws.length, r.id).toBeGreaterThan(0);
            for (const k of kws) expect(k, `${r.id} keyword must be lower-case`).toBe(k.toLowerCase());
        }
    });
});

describe('pinned engine version', () => {
    it('is what the resolver and the toml agree on', () => {
        expect(binLib.loadPins().version).toBe(pins.version);
        expect(pins.releaseBase).toContain(`/v${pins.version}`);
        for (const asset of Object.values(pins.assets)) expect(asset.file).toContain(`_${pins.version}_`);
    });
});

// ── the built-in rule set: every rule of the pinned engine has been looked at ─────────────────────
// A rule with a generic shape (it keys on a word like "password" or "secret", not on a provider's own
// prefix) must be a generic rule here: placeholder and reference values are filtered for it, and it is
// dropped in test files. Bumping the engine version changes the built-in set; this test then fails
// until each new rule has been reviewed and classified.

describe('built-in rules are all classified', () => {
    let defaultToml;
    const builtin = () => {
        if (!defaultToml) {
            const status = engine.engineStatus({ fresh: true });
            expect(status.available, status.message).toBe(true);
            const r = spawnSync(status.bin, ['config', 'show'], { encoding: 'utf8', maxBuffer: 1 << 28 });
            expect(r.status).toBe(0);
            defaultToml = r.stdout;
        }
        const blocks = defaultToml.split(/^\[\[rules\]\]\s*$/m).slice(1);
        return blocks.map(b => {
            const id = (b.match(/^id = '(.+)'$/m) || [])[1];
            const kw = (b.match(/^keywords = \[(.*)\]\s*$/m) || [])[1] || '';
            return { id, keywords: [...kw.matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1].toLowerCase()) };
        }).filter(r => r.id);
    };
    const GENERIC_WORDS = new Set(['password', 'passwd', 'passw', 'psw', 'pwd', '_pw', '-pw', '.pw', 'secret', 'token', 'credential', 'credentials',
        'creds', 'api', 'auth', 'key', 'access', 'apikey', 'login', 'login(', 'user', 'username', 'bearer', 'authorization', 'basic', 'curl',
        'administrator_login_password', 'email', 'account', 'client', 'uid']);

    it('reviewedBuiltinRules is exactly the built-in rule set of the pinned version', () => {
        const ids = builtin().map(r => r.id).sort();
        expect(ids.length).toBeGreaterThan(400);
        const reviewed = pins.reviewedBuiltinRules.join(' ').split(/\s+/).filter(Boolean).sort();
        const missing = ids.filter(id => !reviewed.includes(id));
        const stale = reviewed.filter(id => !ids.includes(id));
        expect(missing, 'built-in rules nobody has classified: review each, add generic-shaped ones to genericRuleIds and the toml, then list them').toEqual([]);
        expect(stale, 'reviewed rules the pinned engine no longer has').toEqual([]);
    });

    it('every built-in rule is either classified generic or has a provider-specific shape', () => {
        const generic = new Set(pins.genericRuleIds);
        const offenders = builtin()
            .filter(r => r.keywords.length && r.keywords.every(k => GENERIC_WORDS.has(k)))
            .filter(r => !generic.has(r.id))
            // vendor-keyed rules whose only keyword is a plain word (aws "secret", azure "client") are reviewed named rules
            .filter(r => !['aws-secret-access-key', 'azure-client-id', 'kubernetes-secret-yaml'].includes(r.id));
        expect(offenders.map(r => r.id)).toEqual([]);
    });

    it('classifies the generic-shaped built-ins the first review found', () => {
        for (const id of ['hashicorp-tf-password', 'curl-auth-user', 'curl-auth-header', 'kubernetes-secret-yaml', 'nuget-config-password',
            'generic-api-key', 'generic-password', 'generic-username']) {
            expect(pins.genericRuleIds, id).toContain(id);
        }
    });

    it('lists every generic built-in in the global filter, and no domdhi rule is a built-in id', () => {
        const ids = new Set(builtin().map(r => r.id));
        for (const id of pins.genericRuleIds) {
            if (!id.startsWith('domdhi-')) expect(ids.has(id), `${id} is not a built-in rule`).toBe(true);
        }
        for (const r of rules) expect(ids.has(r.id), `${r.id} collides with a built-in rule`).toBe(false);
    });

    it('treats the built-in connection-string rules as connection strings (placeholder passwords stay clean)', () => {
        expect(toml).toMatch(/let conn = finding\["rule_id"\] in \[[^\]]*"mongodb-connection-string"[^\]]*"generic-credential-uri"|let conn = finding\["rule_id"\] in \[[^\]]*"generic-credential-uri"[^\]]*"mongodb-connection-string"/);
        expect(names.get('mongodb-connection-string')).toBe('Connection String');
    });
});

describe('the global filter exempts exact values only', () => {
    it('matches the fixed UUID by equality, not containment', () => {
        expect(toml).toMatch(/\|\| sv == "014df517-39d1-4453-b7b3-9930c563627c"/);
        expect(toml).not.toMatch(/containsAny\(sv, \["014df517/);
    });

    it('scopes the hex-digest exemption to digest contexts', () => {
        expect(toml).toMatch(/render-state/);
        expect(toml).toMatch(/sha\\d\*\|digest\|hash\|checksum\|integrity\|etag\|fingerprint/);
    });
});
