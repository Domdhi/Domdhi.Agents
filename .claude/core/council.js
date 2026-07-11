/**
 * Council review aggregation — the deterministic core of /review:code-review --council.
 *
 * A "council" generalizes --deep's 2-agent cross-model check into N reviewers
 * differentiated by LENS (correctness / security / architecture / performance),
 * following Karpathy's llm-council: independent reviews → anonymized peer
 * cross-validation → chairman synthesis. We're single-vendor (Claude), so the
 * diversity comes from lens + tier, not vendor.
 *
 * The PewDiePie-ChatOS lesson is baked into the survival rule: reviewers are
 * NEVER rewarded for agreement. A finding survives by INDEPENDENT confirmation
 * (raised by ≥2 lenses, or cross-confirmed by a lens that didn't raise it) and
 * is killed by majority refutation — but a CRITICAL is never silently dropped,
 * only marked "contested". That rewards dissent and resists collusion/consensus
 * bias the way Karpathy's anonymization does for a single-vendor panel.
 *
 * The LLM does the reviewing, the anonymized cross-validation, and the final
 * synthesis; THIS script does the reproducible glue: dedup findings (independent
 * re-raises are themselves a confirmation signal), assign stable ids, tally
 * votes, compute consensus severity, and decide survival.
 *
 * Usage:
 *   node .claude/core/council.js dedupe <findings.json>        → deduped.json (stable ids)
 *   node .claude/core/council.js aggregate <workspaceDir>      → council.json + council.md
 *       (reads <dir>/deduped.json + <dir>/votes.json)
 *   node .claude/core/council.js lenses                        → prints the default lens set
 *
 * findings.json : [ { file, line?, title, severity, lens, detail? } ]
 * votes.json    : [ { finding_id, voter, verdict: "confirm"|"refute"|"unsure", severity_vote? } ]
 */

const fs = require('fs');
const path = require('path');

const LENSES = [
    { key: 'correctness', focus: 'logic bugs, edge cases, error handling, data integrity, race conditions' },
    { key: 'security', focus: 'injection, authz/authn, secrets, unsafe input, OWASP, supply chain' },
    { key: 'architecture', focus: 'convention/standard compliance, coupling, layering, duplication, naming' },
    { key: 'performance', focus: 'hot paths, N+1, allocations, blocking I/O, algorithmic complexity' },
];

const SEVERITY_ORDER = { CRITICAL: 3, MAJOR: 2, MINOR: 1, NIT: 0 };
const SEVERITY_NAME = ['NIT', 'MINOR', 'MAJOR', 'CRITICAL'];

// ── Pure helpers ────────────────────────────────────────────────────────────

function normalizeTitle(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Dedup key: same file + line + normalized title ⇒ the same finding. */
function findingKey(f) {
    return `${f.file || ''}:${f.line ?? ''}:${normalizeTitle(f.title)}`;
}

function severityRank(sev) {
    return SEVERITY_ORDER[String(sev || '').toUpperCase()] ?? 0;
}

function maxSeverity(a, b) {
    return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * Merge findings that multiple lenses raised independently. An independent
 * re-raise is a confirmation signal, so we keep WHO raised it (`raisedBy`).
 * Returns deduped findings with stable ids (deterministic sort → F0, F1, ...).
 */
function dedupeFindings(findings) {
    const byKey = new Map();
    for (const f of findings || []) {
        const key = findingKey(f);
        if (!byKey.has(key)) {
            byKey.set(key, {
                file: f.file || '',
                line: f.line ?? null,
                title: f.title || '',
                severity: (f.severity || 'MINOR').toUpperCase(),
                detail: f.detail || '',
                raisedBy: [],
            });
        }
        const merged = byKey.get(key);
        merged.severity = maxSeverity(merged.severity, (f.severity || 'MINOR').toUpperCase());
        if (f.lens && !merged.raisedBy.includes(f.lens)) merged.raisedBy.push(f.lens);
        if (!merged.detail && f.detail) merged.detail = f.detail;
    }
    const sorted = [...byKey.values()].sort(
        (a, b) =>
            (a.file || '').localeCompare(b.file || '') ||
            (a.line ?? 0) - (b.line ?? 0) ||
            a.title.localeCompare(b.title),
    );
    sorted.forEach((f, i) => {
        f.id = `F${i}`;
        f.raisedBy.sort();
    });
    return sorted;
}

/** Deterministic reviewer→label map (Reviewer A, B, …) for anonymized review. */
function anonymize(lensKeys) {
    const sorted = [...new Set(lensKeys)].sort();
    const map = {};
    sorted.forEach((k, i) => {
        map[k] = `Reviewer ${String.fromCharCode(65 + i)}`;
    });
    return map;
}

/** Median severity across the original + all severity votes. */
function consensusSeverity(originalSeverity, votes) {
    const ranks = [severityRank(originalSeverity)];
    for (const v of votes) {
        if (v.severity_vote) ranks.push(severityRank(v.severity_vote));
    }
    ranks.sort((a, b) => a - b);
    const mid = ranks[Math.floor((ranks.length - 1) / 2)];
    return SEVERITY_NAME[mid];
}

/**
 * Tally one finding. Independent raises count as confirms; cross-validation
 * votes from non-raisers add confirms/refutes.
 */
function tallyVotes(finding, votes) {
    const mine = (votes || []).filter((v) => v.finding_id === finding.id);
    const raisers = new Set(finding.raisedBy || []);
    let crossConfirms = 0;
    let refutes = 0;
    let unsure = 0;
    for (const v of mine) {
        if (raisers.has(v.voter)) continue; // a raiser confirming itself adds nothing
        if (v.verdict === 'confirm') crossConfirms++;
        else if (v.verdict === 'refute') refutes++;
        else unsure++;
    }
    const independentRaises = Math.max(1, raisers.size);
    const confirms = independentRaises + crossConfirms;
    return { confirms, crossConfirms, independentRaises, refutes, unsure, votes: mine };
}

/**
 * Survival decision — reward independent confirmation, resist consensus bias.
 *   confirmed  : ≥2 confirms AND confirms > refutes
 *   refuted    : refutes > confirms (but a CRITICAL is never refuted away)
 *   contested  : a CRITICAL/MAJOR that drew refutes, or a tie
 *   unconfirmed: a single-lens finding nobody corroborated (surface, low-confidence)
 */
function classify(finding, tally) {
    const isHigh = severityRank(finding.severity) >= SEVERITY_ORDER.MAJOR;
    // Only a CRITICAL is immune from outright 'refuted' (per the docstring) — it
    // downgrades to 'contested' instead. A MAJOR with more refutes than confirms
    // IS refuted; using isHigh here wrongly shielded MAJOR too.
    const isCritical = severityRank(finding.severity) >= SEVERITY_ORDER.CRITICAL;
    if (tally.refutes > tally.confirms) return isCritical ? 'contested' : 'refuted';
    if (tally.confirms >= 2 && tally.confirms > tally.refutes) {
        return tally.refutes > 0 && isHigh ? 'contested' : 'confirmed';
    }
    if (tally.refutes > 0) return 'contested';
    return 'unconfirmed';
}

function aggregateCouncil(dedupedFindings, votes, opts = {}) {
    const lensKeys = opts.lenses || [...new Set((dedupedFindings || []).flatMap((f) => f.raisedBy || []))];
    const anon = anonymize(lensKeys);
    const consensus = (dedupedFindings || []).map((f) => {
        const tally = tallyVotes(f, votes);
        const status = classify(f, tally);
        return {
            ...f,
            confirms: tally.confirms,
            crossConfirms: tally.crossConfirms,
            refutes: tally.refutes,
            unsure: tally.unsure,
            consensusSeverity: consensusSeverity(f.severity, tally.votes),
            status,
        };
    });
    const order = { confirmed: 0, contested: 1, unconfirmed: 2, refuted: 3 };
    consensus.sort(
        (a, b) =>
            order[a.status] - order[b.status] ||
            severityRank(b.consensusSeverity) - severityRank(a.consensusSeverity),
    );
    const count = (s) => consensus.filter((f) => f.status === s).length;
    return {
        anonymization: anon,
        n_reviewers: lensKeys.length,
        stats: {
            deduped: consensus.length,
            confirmed: count('confirmed'),
            contested: count('contested'),
            unconfirmed: count('unconfirmed'),
            refuted: count('refuted'),
        },
        findings: consensus,
    };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const STATUS_BADGE = {
    confirmed: '✅ confirmed',
    contested: '⚠ contested',
    unconfirmed: '◻ unconfirmed',
    refuted: '✗ refuted',
};

function renderCouncilMd(result) {
    const L = [];
    L.push('## Council Review — consensus');
    L.push('');
    L.push(`**Reviewers (lenses):** ${result.n_reviewers}  ·  **Deduped findings:** ${result.stats.deduped}`);
    L.push(`**Consensus:** ${result.stats.confirmed} confirmed · ${result.stats.contested} contested · ${result.stats.unconfirmed} unconfirmed · ${result.stats.refuted} refuted`);
    L.push('');
    L.push('| Status | Severity | Finding | Where | Raised by | Confirms/Refutes |');
    L.push('|--------|----------|---------|-------|-----------|------------------|');
    for (const f of result.findings) {
        const where = f.line ? `${f.file}:${f.line}` : f.file;
        L.push(
            `| ${STATUS_BADGE[f.status] || f.status} | ${f.consensusSeverity} | ${f.title} | \`${where}\` | ${(f.raisedBy || []).join(', ')} | ${f.confirms}/${f.refutes} |`,
        );
    }
    L.push('');
    const refuted = result.findings.filter((f) => f.status === 'refuted');
    if (refuted.length) {
        L.push('### Refuted (dropped by the council — logged, not actioned)');
        for (const f of refuted) L.push(`- ${f.title} (${f.file}) — refuted ${f.refutes} vs ${f.confirms} confirms`);
        L.push('');
    }
    return L.join('\n') + '\n';
}

// ── Disk / CLI ──────────────────────────────────────────────────────────────

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
    const cmd = argv[0];

    if (cmd === 'lenses') {
        console.log(JSON.stringify(LENSES, null, 2));
        return;
    }

    if (cmd === 'dedupe') {
        const findings = readJson(argv[1]);
        const deduped = dedupeFindings(findings);
        const out = path.join(path.dirname(argv[1]), 'deduped.json');
        fs.writeFileSync(out, JSON.stringify(deduped, null, 2));
        console.log(`[COUNCIL] ${findings.length} raw → ${deduped.length} deduped → ${out}`);
        return;
    }

    if (cmd === 'aggregate') {
        const dir = argv[1];
        if (!dir || !fs.existsSync(dir)) {
            console.error(`[COUNCIL] workspace dir not found: ${dir}`);
            process.exit(1);
        }
        const dedupedPath = path.join(dir, 'deduped.json');
        const findingsPath = path.join(dir, 'findings.json');
        const deduped = fs.existsSync(dedupedPath)
            ? readJson(dedupedPath)
            : dedupeFindings(readJson(findingsPath));
        const votesPath = path.join(dir, 'votes.json');
        const votes = fs.existsSync(votesPath) ? readJson(votesPath) : [];
        const result = aggregateCouncil(deduped, votes);
        fs.writeFileSync(path.join(dir, 'council.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(dir, 'council.md'), renderCouncilMd(result));
        console.log(
            `[COUNCIL] ${result.stats.confirmed} confirmed / ${result.stats.contested} contested / ${result.stats.refuted} refuted → ${path.join(dir, 'council.md')}`,
        );
        return;
    }

    console.error('Usage: node .claude/core/council.js dedupe <findings.json> | aggregate <dir> | lenses');
    process.exit(2);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    LENSES,
    SEVERITY_ORDER,
    SEVERITY_NAME,
    normalizeTitle,
    findingKey,
    severityRank,
    maxSeverity,
    dedupeFindings,
    anonymize,
    consensusSeverity,
    tallyVotes,
    classify,
    aggregateCouncil,
    renderCouncilMd,
    main,
};
