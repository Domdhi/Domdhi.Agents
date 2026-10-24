/**
 * Skill evolution intake — the autonomous driver behind /review:evolve-skills.
 *
 * Self-improving skills, our way: instead of waiting for a human to notice a
 * gap, this reads the failure/learning signals the toolkit already collects and
 * proposes skill work — honoring skill-authoring's revised rule that every edit
 * needs EVIDENCE OF A REAL GAP first (the empirical baseline), validated by a
 * differential eval after (see .claude/core/skill-eval.js).
 *
 * Two evolution paths, two signals:
 *   IMPROVE — agent-updates misalignments (docs/.output/evolution/agents/*.md)
 *             attributed to the existing skill that owns that domain. The
 *             misalignment IS the "without_skill / old_skill failed" baseline.
 *   CREATE  — clusters of recurring `workflows` + `patterns` memories that no
 *             existing skill covers → a candidate NEW skill (the Voyager/Hermes
 *             "extract the reusable pattern from experience and write it down"
 *             move). The recurrence across N memories IS the baseline evidence.
 *
 * This script does the deterministic part (collect, attribute, cluster, gate a
 * candidate against the skill spec). The reflective "why did it fail / what
 * should the skill say" diagnosis and the actual SKILL.md authoring are the
 * LLM's job in the command + skill-creator skill.
 *
 * Usage:
 *   node .claude/core/skill-evolution.js intake [--since YYYY-MM-DD] [--date YYYY-MM-DD] [--json]
 *   node .claude/core/skill-evolution.js check <skill-name> <candidate-SKILL.md>
 *   node .claude/core/skill-evolution.js status
 */

const fs = require('fs');
const path = require('path');
const conformance = require('./skill-conformance');

const ATTRIBUTE_MIN_SCORE = 2; // floor in units of the lowest possible IDF weight (see attributeSignal)
const COVERAGE_MIN_MATCHED = 4; // distinct shared tokens that make a memory cluster "already covered"
const ATTRIBUTE_MIN_DISTINCT_TOKENS = 2; // a single incidental literal must never bind a signal

// Winner-over-runner-up ratio required to call an attribution CONFIDENT.
//
// Measured across a project's real agent-update sections: margins ran 1.04-1.27 with
// one outlier at 1.91. A known-CORRECT attribution sat at 1.19 and a known-WRONG one
// (a test-honesty signal that matched only because a tool in the stack shares a word
// with the skill's name) sat at 1.17. They are not separable by margin, and re-scoping
// the text window flipped 6 of 8 winners.
//
// So this threshold does NOT filter good from bad — nothing does, at this signal
// quality. Its job is to stop the tool PRESENTING a coin-flip as a finding: below
// it, the signal is reported as ambiguous with its top candidates, and is kept out
// of IMPROVE so a differential eval is never spent on a guess.
const ATTRIBUTE_MIN_MARGIN = 1.5;
const CLUSTER_MIN_SHARED = 2;  // shared tokens to put two memories in one cluster
const CLUSTER_MIN_SIZE = 2;    // a CREATE candidate needs at least this many memories
const NAME_WEIGHT = 2;         // a skill-NAME token match counts double
const CAUGHT_WEIGHT = 0.5;     // down-rank a signal whose own text shows a safeguard WORKED

const STOPWORDS = new Set(
    ('the a an and or but for nor so yet of to in on at by with from into onto upon as is are was were be been being ' +
        'this that these those it its their there here when then than them they your you our we us not no do does did ' +
        'doc docs file files use used using via per each any all one two new old set get run runs ran make made via ' +
        'should must never always when what which while because before after during about above below over under ' +
        // Generic English that survives the 4-char filter and scores like a domain
        // term. A skill DESCRIPTION is natural prose, so these appear in many of
        // them — and IDF cannot save a word that happens to be unique to one
        // description. A section about retry predicates, session guards and a visual
        // settle helper was once attributed to a design-system skill on nothing but
        // a handful of such words.
        // Words that are also real domain terms (form, mode, site, time, line, name, work,
        // show, case, part, place, word, sign, sort, turn) are deliberately NOT listed: this
        // set is applied to skill names and descriptions and to memory clustering too, where
        // they carry meaning for most adopters.
        'first well need needs also only same just like more most both very much many some such ' +
        'even else once ever every other back next last long high real full hard easy good best less practices ' +
        'thing things take takes give gives keep keeps know knows want wants look looks kind based').split(/\s+/),
);

// Meta-vocabulary of the agent-updates format itself — words that appear in
// nearly EVERY misalignment record because they name the artifact, not the
// domain. Left in, they spuriously bind any signal to skills whose name/desc
// contains them (the crypto bug: "agent" matched `agent-creator` 20× off
// dev-agent misalignments that had nothing to do with authoring a subagent).
// Stripped only when attributing an agent-update signal — NOT from skill-index
// or memory tokens — so a genuine signal still attributes via its specific
// domain tokens (frontmatter, persona, model-tier, …), just not via "agent".
const SIGNAL_STOPWORDS = new Set(
    ('agent agents subagent subagents skill skills command commands update updates misalignment misalignments ' +
        'dispatch dispatched dispatches output outputs prompt prompts task tasks step steps').split(/\s+/),
);

// Skills owned by a reviewer/auditor/safeguard role. A signal that shows one of
// these CAUGHT a defect is evidence the safeguard WORKED — the gap is upstream
// in the dev-agent dispatch prompt, not in this skill. Extension point: add the
// skill any new gatekeeper agent loads.
const REVIEW_DOMAIN_SKILLS = new Set(['code-review', 'qa-engineer', 'verification-before-completion']);

// Cue phrases for signal polarity. SLIPPED = something failed/escaped (genuine
// gap). CAUGHT = a safeguard fired (worked as intended). Order matters in
// classifyPolarity: a documented slip is the actionable gap, so it wins on tie —
// EXCEPT for review-domain skills, where a caught-cue routes to dispatch (below).
const SLIPPED_RE = /\b(slipped through|slipped past|went undetected|undetected|escaped|missed|did ?n['o]t catch|failed to|should have (caught|been|flagged)|not caught|regress(ion|ed)?|false (success|green|positive)|fabricat(ed|ion))\b/i;
// An agent-update section that EXPLICITLY disclaims an agent gap is not evidence of one,
// however many failure-flavoured words surround it. A section that opens "**None
// attributable to the agents.** Both defects this wave were in the ORCHESTRATOR-written
// test fixtures" was still counted as `slipped` because SLIPPED_RE matched words in the
// surrounding prose. Checked BEFORE both cue scans: an explicit disclaimer outranks an
// inferred cue.
const NO_GAP_RE = /\b(none attributable|not attributable|no agent (?:issues|misalignments?|gaps?)|nothing attributable|none of (?:these|them) (?:are|were) agent)\b/i;

const CAUGHT_RE = /\b(caught by|caught the|caught a|flagged by|flagged the|flagged a|blocked by|blocked the|rejected by|rejected the|prevented by|reviewer (caught|flagged|found)|review caught|gate (caught|blocked)|guardrail (caught|blocked)|correctly (caught|flagged|rejected|identified))\b/i;

// ── Tokenizing + attribution (pure) ─────────────────────────────────────────

function tokenize(text, extraStop = null) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[`*_>#|\[\]()]/g, ' ')
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !(extraStop && extraStop.has(w))),
    );
}

/**
 * Polarity of an agent-update signal from its own prose.
 *   'slipped' — a defect failed/escaped → genuine evidence of a gap.
 *   'caught'  — a safeguard fired → the named thing WORKED.
 *   'neutral' — no clear cue.
 * A slip is the actionable gap, so it wins when both cues are present.
 */
function classifyPolarity(text) {
    const s = String(text || '');
    if (NO_GAP_RE.test(s)) return 'caught';
    if (SLIPPED_RE.test(s)) return 'slipped';
    if (CAUGHT_RE.test(s)) return 'caught';
    return 'neutral';
}

function buildSkillIndex(skillsRoot) {
    const index = [];
    if (!fs.existsSync(skillsRoot)) return index;
    // statSync fallback (not Dirent.isDirectory alone) so symlinked skill dirs count too —
    // Dirent.isDirectory() returns false for symlinks (same class as skill-conformance.js).
    const dirs = fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((d) => {
            if (d.isDirectory()) return true;
            if (!d.isSymbolicLink()) return false;
            try { return fs.statSync(path.join(skillsRoot, d.name)).isDirectory(); }
            catch { return false; }
        })
        .map((d) => d.name)
        .sort();
    for (const dir of dirs) {
        const skillPath = path.join(skillsRoot, dir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) continue;
        const content = fs.readFileSync(skillPath, 'utf8');
        const fm = conformance.extractFrontmatter(content);
        const description = conformance.parseField(fm, 'description') || '';
        index.push({
            dir,
            description,
            nameTokens: tokenize(dir.replace(/-/g, ' ')),
            descTokens: tokenize(description),
        });
    }
    return index;
}

/**
 * Inverse document frequency of every token across the skill index.
 *
 * Without this, attribution is raw presence-counting and one incidental word
 * decides a whole section. Reproduced: a section about a tab `aria-pressed` choice,
 * a brand scanner and a click-retry revert was attributed to an
 * `email-and-password-best-practices` skill with 4 of its 6 points coming from the
 * NAME tokens `email` and `password`, which were present only because the log
 * quotes the fixture error string `401 INVALID_EMAIL_OR_PASSWORD`. A quoted identifier is not evidence about
 * a skill. Weighting by IDF makes a token that half the skills share nearly
 * free, so a signal has to match something actually distinctive to bind.
 */
function buildIdf(skillIndex) {
    const df = new Map();
    for (const s of skillIndex) {
        for (const t of new Set([...s.nameTokens, ...s.descTokens])) {
            df.set(t, (df.get(t) || 0) + 1);
        }
    }
    const n = Math.max(skillIndex.length, 1);
    const idf = new Map();
    // log(1 + n/c), not log(n/c): the plain form is 0 for a token every skill shares, so a
    // one-skill index (a fresh project) would score every signal 0 and attribute nothing.
    for (const [t, c] of df) idf.set(t, Math.log(1 + n / c));
    return idf;
}

/** Overlap score of a token set against one skill (name matches weighted, IDF-scaled). */
function scoreOverlap(tokens, skillEntry, idf = null) {
    let score = 0;
    for (const t of tokens) {
        const w = skillEntry.nameTokens.has(t) ? NAME_WEIGHT : (skillEntry.descTokens.has(t) ? 1 : 0);
        if (!w) continue;
        score += idf ? w * idf.get(t) : w;
    }
    return score;
}

/** Count of DISTINCT signal tokens that match a skill's vocabulary at all. */
function matchCount(tokens, skillEntry) {
    let n = 0;
    for (const t of tokens) if (skillEntry.nameTokens.has(t) || skillEntry.descTokens.has(t)) n++;
    return n;
}

/**
 * Best-matching skill for a signal, or null when nothing clears the threshold.
 *
 * TWO gates, deliberately. IDF weighting rescaled `score` (a real match now runs
 * 13-17, not 2-6), which on its own would have made ATTRIBUTE_MIN_SCORE far MORE
 * permissive than before: one rare token, e.g. a product name quoted once in a
 * log line, scores ~3.7 and would bind a whole section by itself. So the original
 * intent — "at least this many shared MEANINGFUL tokens" — is kept as an explicit
 * structural gate that no single token can satisfy, and the weighted score is used
 * only to RANK the candidates that clear it. Without the second gate, fixing the
 * false attributions would have opened a new hole.
 */
function attributeSignal(tokens, skillIndex, minScore = ATTRIBUTE_MIN_SCORE) {
    const idf = buildIdf(skillIndex);
    // IDF is smoothed to log(1 + n/c), so the smallest weight any shared token can have
    // is log 2 whatever the index size. Expressing the floor in those units keeps a
    // one-skill index (where every token weighs log 2) as attributable as a large one.
    // With the distinct-token gate below (two tokens x log 2 = the default floor) this is
    // a backstop that only bites when a caller raises `minScore`; the gate is the real floor.
    const floor = minScore * Math.LN2;
    const ranked = [];
    for (const s of skillIndex) {
        const matched = matchCount(tokens, s);
        if (matched < ATTRIBUTE_MIN_DISTINCT_TOKENS) continue;
        const score = scoreOverlap(tokens, s, idf);
        if (score >= floor) ranked.push({ skill: s.dir, score: round(score), matched });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.score - a.score);
    const [best, runnerUp] = ranked;
    const margin = runnerUp ? best.score / runnerUp.score : Infinity;
    return {
        skill: best.skill,
        score: best.score,
        matchedTokens: best.matched,
        // The best token coverage among ALL ranked skills, not just the score winner's: the
        // winner is chosen by IDF score, which can favor two rare name tokens over five shared ones.
        maxMatchedTokens: Math.max(...ranked.map(r => r.matched)),
        runnerUp: runnerUp ? runnerUp.skill : null,
        runnerUpScore: runnerUp ? runnerUp.score : null,
        margin: Number.isFinite(margin) ? round(margin) : null,
        confident: margin >= ATTRIBUTE_MIN_MARGIN,
        alternatives: ranked.slice(0, 3).map((r) => `${r.skill} (${r.score})`),
    };
}

// ── Memory clustering for CREATE (pure) ─────────────────────────────────────

/** Shared-token count between two token sets. */
function sharedCount(a, b) {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n;
}

/**
 * Greedy single-link clustering of memories by token overlap.
 * memories: [{ id, tokens:Set, ... }] → [[memberIndices...]] (size ≥ minSize).
 */
function clusterMemories(memories, { minShared = CLUSTER_MIN_SHARED, minSize = CLUSTER_MIN_SIZE } = {}) {
    const clusters = [];
    for (let i = 0; i < memories.length; i++) {
        let placed = false;
        for (const cluster of clusters) {
            if (cluster.some((j) => sharedCount(memories[i].tokens, memories[j].tokens) >= minShared)) {
                cluster.push(i);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([i]);
    }
    return clusters.filter((c) => c.length >= minSize);
}

// ── Disk collectors ─────────────────────────────────────────────────────────

// Day-rotated update files live either flat (evolution/agents/{YYYY-MM-DD}.md — the
// tool's native write) OR bucketed one level deep under a {YYYY-MM}/ month dir (the
// homing/organize tool re-files them there). Read BOTH so the reader is robust to
// whichever layout the project ended up in.
function listDayFiles(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const isDayFile = (f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isFile() && isDayFile(ent.name)) {
            out.push({ file: ent.name, abs: path.join(dir, ent.name) });
        } else if (ent.isDirectory() && /^\d{4}-\d{2}$/.test(ent.name)) {
            const monthDir = path.join(dir, ent.name);
            for (const f of fs.readdirSync(monthDir)) {
                if (isDayFile(f)) out.push({ file: f, abs: path.join(monthDir, f) });
            }
        }
    }
    return out;
}

function collectAgentUpdates(dir) {
    const out = [];
    const files = listDayFiles(dir).sort((a, b) => b.file.localeCompare(a.file)); // newest first
    for (const { file, abs } of files) {
        const content = fs.readFileSync(abs, 'utf8');
        const date = file.replace(/\.md$/, '');
        // Split on top-level `## ` section headers; each section is one signal.
        const sections = content.split(/\n(?=## )/).filter((s) => /^## /.test(s.trim()));
        for (const sec of sections) {
            const firstLine = sec.split('\n')[0].replace(/^##\s*/, '').trim();
            out.push({ source: file, date, context: firstLine, text: sec });
        }
    }
    return out;
}

function collectMemories(memRoot, categories = ['workflows', 'patterns']) {
    const out = [];
    for (const cat of categories) {
        const catDir = path.join(memRoot, cat);
        if (!fs.existsSync(catDir)) continue;
        for (const file of fs.readdirSync(catDir).sort().filter((f) => f.endsWith('.json'))) {
            try {
                const m = JSON.parse(fs.readFileSync(path.join(catDir, file), 'utf8'));
                const desc = (m.content && m.content.description) || '';
                const evidence = (m.content && m.content.evidence) || '';
                out.push({
                    id: m.id || file.replace(/\.json$/, ''),
                    category: cat,
                    description: desc,
                    evidence,
                    confidence: (m.content && m.content.confidence) ?? 0.5,
                    usage_count: m.usage_count ?? 0,
                    importance: m.importance ?? 3,
                    tokens: tokenize(`${desc} ${evidence}`),
                });
            } catch {
                /* skip malformed memory */
            }
        }
    }
    return out;
}

// ── Intake ──────────────────────────────────────────────────────────────────

function intake({ projectDir, since = null } = {}) {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const skillsRoot = path.join(root, '.claude', 'skills');
    const memRoot = path.join(root, 'docs', '.output', '.memory');
    const auDir = path.join(root, 'docs', '.output', 'evolution', 'agents');

    const skillIndex = buildSkillIndex(skillsRoot);

    // IMPROVE: attribute each agent-update section to a skill — but read the
    // signal's POLARITY first. The scorer matches by domain keyword; it cannot
    // tell "this skill failed" (a gap to fix) from "this skill caught a defect"
    // (it worked). Two facets, both confirmed downstream:
    //   • caught + a review/safeguard skill ⇒ the safeguard fired; the real gap
    //     is the dev-agent DISPATCH PROMPT, not the skill → route to dispatchGaps.
    //   • caught (other) ⇒ down-rank (CAUGHT_WEIGHT) — working-as-intended is weak
    //     evidence for a rewrite.
    // Signal-vocabulary tokens ("agent", "skill", "dispatch", …) are stripped so
    // a misalignment doesn't bind to a skill merely for naming the artifact.
    let agentUpdates = collectAgentUpdates(auDir);
    if (since) agentUpdates = agentUpdates.filter((u) => u.date >= since);
    const improveBySkill = {};
    const unattributed = [];
    const dispatchGaps = [];
    const ambiguous = [];
    for (const u of agentUpdates) {
        const hit = attributeSignal(tokenize(u.text, SIGNAL_STOPWORDS), skillIndex);
        if (!hit) {
            unattributed.push({ type: 'agent-update', date: u.date, context: u.context });
            continue;
        }
        const polarity = classifyPolarity(u.text);
        if (!hit.confident) {
            // Near-tie. Report the candidates and let a human adjudicate rather
            // than seeding an expensive differential eval against a coin-flip.
            ambiguous.push({
                date: u.date,
                context: u.context,
                polarity,
                margin: hit.margin,
                alternatives: hit.alternatives,
            });
            continue;
        }
        if (REVIEW_DOMAIN_SKILLS.has(hit.skill) && CAUGHT_RE.test(u.text)) {
            // The review/safeguard skill did its job — don't seed a Δ=0 skill-body
            // eval. The actionable gap is upstream in the dispatch prompt.
            dispatchGaps.push({
                skill: hit.skill,
                source: u.source,
                date: u.date,
                context: u.context,
                reason: 'review/safeguard skill but the signal shows it CAUGHT the defect — likely a dev-agent dispatch-prompt gap, not a gap in this skill',
            });
            continue;
        }
        const weight = polarity === 'caught' ? CAUGHT_WEIGHT : 1;
        (improveBySkill[hit.skill] ||= { skill: hit.skill, score: 0, evidence: [] });
        improveBySkill[hit.skill].score = round(improveBySkill[hit.skill].score + hit.score * weight);
        improveBySkill[hit.skill].evidence.push({ source: u.source, date: u.date, context: u.context, polarity });
    }
    const improve = Object.values(improveBySkill).sort((a, b) => b.score - a.score);

    // CREATE: cluster recurring memories that no existing skill covers.
    const memories = collectMemories(memRoot);
    const clusters = clusterMemories(memories);
    const create = [];
    for (const cluster of clusters) {
        const members = cluster.map((i) => memories[i]);
        const merged = new Set();
        for (const m of members) for (const t of m.tokens) merged.add(t);
        const coverage = attributeSignal(merged, skillIndex);
        // Already covered by a strong existing-skill match ⇒ this is IMPROVE turf, not CREATE.
        // Judged by how many distinct cluster tokens the best skill shares, not by its
        // IDF-scaled score (a scale that moves with the index). A near-tie still means
        // the cluster is covered by existing skills.
        if (coverage && coverage.maxMatchedTokens >= COVERAGE_MIN_MATCHED) continue;
        const topTokens = [...merged].slice(0, 6);
        create.push({
            proposedName: topTokens.slice(0, 3).join('-') || 'new-skill',
            memberIds: members.map((m) => m.id),
            size: members.length,
            avgConfidence: round(members.reduce((s, m) => s + m.confidence, 0) / members.length),
            keywords: topTokens,
            coveredBy: coverage ? coverage.skill : null,
            evidence: members.map((m) => ({ id: m.id, category: m.category, description: truncate(m.description, 140) })),
        });
    }
    create.sort((a, b) => b.size - a.size || b.avgConfidence - a.avgConfidence);

    return {
        generated: null, // stamped by caller / CLI
        signals: { agentUpdates: agentUpdates.length, memories: memories.length, clusters: clusters.length },
        improve,
        create,
        dispatchGaps,
        unattributed,
        ambiguous,
    };
}

function round(x, dp = 2) {
    const f = 10 ** dp;
    return Math.round(x * f) / f;
}
function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderIntakeMd(report, date) {
    const L = [];
    L.push(`# Skill Evolution Intake — ${date || ''}`.trim());
    L.push('');
    L.push(`**Signals:** ${report.signals.agentUpdates} agent-update sections · ${report.signals.memories} memories · ${report.signals.clusters} clusters`);
    L.push('');
    L.push('## IMPROVE candidates (failure-trace → skill fix)');
    L.push('');
    if (!report.improve.length) L.push('_None — no agent-update misalignments attributed to a skill._');
    for (const c of report.improve) {
        L.push(`### \`${c.skill}\` (signal score ${c.score})`);
        for (const e of c.evidence) L.push(`- ${e.date} — ${e.context}${e.polarity && e.polarity !== 'neutral' ? ` _(${e.polarity})_` : ''}`);
        L.push('');
    }
    if (report.dispatchGaps && report.dispatchGaps.length) {
        L.push('## Dispatch-prompt gaps (reviewer caught — NOT a skill gap)');
        L.push('');
        L.push('_These signals attributed to a review/safeguard skill, but their text shows the safeguard **caught** the defect. The fix belongs in the dev-agent dispatch prompt (e.g. `/run-todo`), not in a skill-body eval that would read Δ=0._');
        L.push('');
        for (const d of report.dispatchGaps) L.push(`- ${d.date} — ${d.context} → caught by \`${d.skill}\``);
        L.push('');
    }
    L.push('## CREATE candidates (clustered memories → new skill)');
    L.push('');
    if (!report.create.length) L.push('_None — no uncovered recurring memory cluster._');
    for (const c of report.create) {
        L.push(`### proposed: \`${c.proposedName}\` (${c.size} memories, conf ${c.avgConfidence}${c.coveredBy ? `, weakly near \`${c.coveredBy}\`` : ''})`);
        L.push(`keywords: ${c.keywords.map((k) => `\`${k}\``).join(', ')}`);
        for (const e of c.evidence) L.push(`- [${e.category}] ${e.id} — ${e.description}`);
        L.push('');
    }
    if (report.ambiguous && report.ambiguous.length) {
        L.push('## Ambiguous signals (near-tie — NOT attributed, needs a human call)');
        L.push('');
        L.push(`_Winner did not beat the runner-up by ${ATTRIBUTE_MIN_MARGIN}x, so no skill is claimed. Keyword overlap over long prose scores every skill a little; at these margins the winner flips on trivial changes to the text window. Listed with the top candidates so a person can adjudicate — deliberately kept OUT of IMPROVE so no differential eval is spent on a coin-flip._`);
        L.push('');
        L.push('_Note: every agent-update section in this repo carries both an "Agent Issues" and a "Prompt Improvements Needed" heading. By the format\'s own charter these are evidence about DISPATCH and VERIFICATION discipline — so a domain skill winning a near-tie here is usually incidental vocabulary, not a domain-fact error._');
        L.push('');
        for (const a of report.ambiguous) {
            L.push(`- ${a.date} — ${a.context} _(${a.polarity}, margin ${a.margin ?? 'n/a'}x)_`);
            L.push(`  candidates: ${a.alternatives.join(' · ')}`);
        }
        L.push('');
    }

    if (report.unattributed.length) {
        L.push('## Unattributed signals (possible missing skill / too vague)');
        for (const u of report.unattributed) L.push(`- ${u.date} — ${u.context}`);
        L.push('');
    }
    return L.join('\n') + '\n';
}

// ── check: gate a candidate body against the skill spec ─────────────────────

function check(skillName, candidateFile) {
    if (!fs.existsSync(candidateFile)) {
        return { ok: false, error: `candidate not found: ${candidateFile}`, findings: [] };
    }
    const content = fs.readFileSync(candidateFile, 'utf8');
    const fm = conformance.extractFrontmatter(content);
    const findings = conformance.evaluateSkill({
        dir: skillName,
        name: conformance.parseField(fm, 'name'),
        description: conformance.parseField(fm, 'description'),
        lineCount: conformance.countLines(content),
    });
    const errors = findings.filter((f) => f.severity === 'ERROR');
    return { ok: errors.length === 0, findings };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(argv) {
    const args = require('./skill-eval').parseArgs(argv);
    const cmd = args._[0];
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

    if (cmd === 'intake') {
        const report = intake({ projectDir: root, since: args.since || null });
        const date = args.date || null;
        report.generated = date;
        if (args.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        const outDir = path.join(root, 'docs', '.output', 'evolution', 'skills', date || 'latest');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'intake.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(outDir, 'intake.md'), renderIntakeMd(report, date));
        console.log(`[SKILL-EVOLUTION] ${report.improve.length} IMPROVE · ${report.create.length} CREATE · ${report.dispatchGaps.length} dispatch-gap → ${path.join(outDir, 'intake.md')}`);
        return;
    }

    if (cmd === 'check') {
        const result = check(args._[1], args._[2]);
        if (result.error) {
            console.error(`[SKILL-EVOLUTION] ${result.error}`);
            process.exit(1);
        }
        for (const f of result.findings) console.log(`${f.severity} ${f.message}`);
        console.log(`[SKILL-EVOLUTION] candidate ${result.ok ? 'PASSES' : 'FAILS'} the skill spec.`);
        process.exit(result.ok ? 0 : 1);
    }

    if (cmd === 'status') {
        const base = path.join(root, 'docs', '.output', 'evolution', 'skills');
        if (!fs.existsSync(base)) {
            console.log('[SKILL-EVOLUTION] no runs yet.');
            return;
        }
        // Run-dirs are named {YYYY-MM-DD} and sit either flat under base (native
        // write) or one level deep under a {YYYY-MM}/ month dir (homed). A
        // no-date intake run writes to `latest/` — the reader must list it too
        // (the writer's own default output, line ~405). Sort newest-first by
        // run DATE (the basename), not the relative path — sorting mixed
        // flat/nested paths puts location, not date, in the tiebreaker slot
        // ('-' < '/'), listing month-nested runs above newer flat runs.
        const runs = new Map(); // run date -> display path ('/' separator, cross-platform output)
        const addRun = (date, rel) => { if (!runs.has(date)) runs.set(date, rel); };
        for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            if (/^\d{4}-\d{2}-\d{2}$/.test(ent.name) || ent.name === 'latest') {
                if (fs.existsSync(path.join(base, ent.name, 'intake.md'))) addRun(ent.name, ent.name);
            } else if (/^\d{4}-\d{2}$/.test(ent.name)) {
                const monthDir = path.join(base, ent.name);
                for (const d of fs.readdirSync(monthDir)) {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(monthDir, d, 'intake.md'))) {
                        addRun(d, `${ent.name}/${d}`);
                    }
                }
            }
        }
        // Ascending sort puts date-named runs first and 'latest' (0x6C > 0x39)
        // last; after reverse, 'latest' — the newest unstamped run — tops the list.
        for (const date of [...runs.keys()].sort().reverse()) {
            console.log(`- ${runs.get(date)}/intake.md`);
        }
        return;
    }

    console.error('Usage: node .claude/core/skill-evolution.js intake|check|status [...]');
    process.exit(2);
}

/**
 * Mine GEPA-style failure traces from an already-built benchmark object.
 * Input: { evals: [{ eval_name, assertions: [{ text, evidence_on_fail }] }] }
 * Output: [{ eval_name, assertion, evidence: string[] }] — one entry per
 * assertion whose evidence_on_fail is a non-empty array. Assertions with no
 * failure evidence are skipped. Pure function, no I/O.
 */
function extractFailureTraces(benchmark) {
    const traces = [];
    for (const ev of (benchmark && benchmark.evals) || []) {
        for (const a of (ev && ev.assertions) || []) {
            if (Array.isArray(a.evidence_on_fail) && a.evidence_on_fail.length > 0) {
                traces.push({
                    eval_name: ev.eval_name,
                    assertion: a.text,
                    evidence: a.evidence_on_fail,
                });
            }
        }
    }
    return traces;
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
    ATTRIBUTE_MIN_SCORE,
    ATTRIBUTE_MIN_MARGIN,
    ATTRIBUTE_MIN_DISTINCT_TOKENS,
    COVERAGE_MIN_MATCHED,
    CLUSTER_MIN_SHARED,
    CLUSTER_MIN_SIZE,
    SIGNAL_STOPWORDS,
    REVIEW_DOMAIN_SKILLS,
    tokenize,
    classifyPolarity,
    buildSkillIndex,
    scoreOverlap,
    buildIdf,
    matchCount,
    NO_GAP_RE,
    attributeSignal,
    sharedCount,
    clusterMemories,
    collectAgentUpdates,
    collectMemories,
    intake,
    renderIntakeMd,
    check,
    extractFailureTraces,
    main,
};
