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
 * Intake attribution (SF-4.5): the day-rotated agent-update logs carry structured issue rows
 * (`agent-issue-log.js`: `| Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |`).
 * A row whose Skill cell exactly names an indexed skill is a CONFIDENT attribution whatever the prose
 * margin; token overlap stays as the fallback for a row naming no known skill and for legacy prose
 * sections. Every surfaced signal carries an opaque `fingerprint`; a fingerprint recorded in the
 * adjudication ledger (`docs/.output/evolution/skills/_decisions.md`, read-only here) is not
 * resurfaced. A target in the protected set (`_lib/improvement-scope.js`) goes to `protectedTargets`,
 * never IMPROVE. Recurring gate failures (the SF-1.5 failure ledger) are reported as `gateFailures`:
 * the ledger names no skill, so they never create an IMPROVE entry.
 *
 * Usage:
 *   node .claude/core/skill-evolution.js intake [--since YYYY-MM-DD] [--date YYYY-MM-DD] [--json]
 *   node .claude/core/skill-evolution.js check <skill-name> <candidate-SKILL.md | a file under a references directory>
 *   node .claude/core/skill-evolution.js status [--json]
 *   node .claude/core/skill-evolution.js apply <skill-name> --run <workspace> [--mode propose|apply] [--branch auto/<name>]
 *        [--route verdict|side-door] [--iteration <dir>] [--holdout <dir>] [--min-replicates <n>]
 *        [--candidate-sha256 <hex64>] [--date YYYY-MM-DD] [--evidence id[,id...]]
 *   node .claude/core/skill-evolution.js bind --run <workspace> [--iteration <dir>]
 *   node .claude/core/skill-evolution.js record-commit --candidate-sha256 <hex64> --commit <commit id> [--date YYYY-MM-DD]
 *   node .claude/core/skill-evolution.js watch [--json]
 *   node .claude/core/skill-evolution.js auto-check --candidates <n> --runs <n> --tokens <n> --cost-usd <x> [--extra-cost-usd <x>]
 *   node .claude/core/skill-evolution.js auto-check --candidates <n> --skill <name> [--draft-cost-usd <x>]
 *   node .claude/core/skill-evolution.js auto-apply-check --candidate-sha256 <hex64>
 *   node .claude/core/skill-evolution.js record-stop --skill <name> --run <workspace> [--evidence id[,id...]] [--date YYYY-MM-DD]
 *
 * `apply` (SF-4.9) is `_lib/skill-apply.js`: it proposes by default (nothing is written), and with `--mode apply`
 * (which needs `--candidate-sha256` from the propose run) lands an accepted candidate as an uncommitted delta on a local
 * `auto/` branch, restoring everything on any failure. It never commits, stages or pushes; the exit code is 0 proposed
 * or applied, 1 refused or failed, 2 invalid input. `bind` records, inside the evaluated iteration, the hashes of the
 * candidate and snapshot it graded and of every grading.json and benchmark.json under the iteration and its holdout
 * (`iteration-<N>/binding.json`); the verdict route refuses a candidate or grading evidence that does not match.
 *
 * The audit trail (SF-4.10). Every disposition `apply` reaches is recorded in `docs/.output/evolution/skills/{date}/ledger.json`
 * (written by `_lib/skill-apply.js`, which also owns `record-commit`: the commit and the exact `git revert <hash>` text of an
 * applied delta, filled in once after the change has landed on the default branch). This file READS that trail, never writes a ledger.
 *
 * THE LEDGER IS EVIDENCE, NOT THE SOURCE OF TRUTH. Graduation, `watch`, the intake's revert candidates and `auto-apply-check` count
 * ONLY changes git proves (`skillApply.openEvidence`): an applied entry's commit is reachable from the repository's DEFAULT branch
 * (`origin/HEAD`, else `main`, else `master`; never the HEAD of the checkout), the diff of that commit on the skill's files is
 * exactly the change the entry evaluated (`delta_sha256`; a squash merge is matched by that diff, not by ancestry), and one commit
 * serves one entry. A reverted change is read from the trees (a later commit on the default branch that restores the pre-image of
 * those files), never from a commit message; a revert that is itself reverted is a net no-op unless another ledger entry re-applied
 * it. A forged ledger can therefore at worst add an entry that does not count. Entries are ordered by their recorded `applied_at`
 * (the `--date` of a run only names its folder), and a change's watch window starts at its commit's time on the default branch.
 *   status  lists the ledgers and, per change class, the consecutive proven changes with no revert and no scoreboard regression
 *           inside the watch window, against the graduation criteria for auto-apply (Owner Decision 12: a measured decision, never
 *           an automatic one). `pending` (no commit, or not on the default branch), `unverified` (not proven to be the entry's
 *           change, or a commit another entry holds) and `unmeasured` (fewer than `minSample` scoreboard runs on a side of the window:
 *           no observation) never count and never break the streak.
 *   watch   compares the run scoreboard's metrics for the N runs before and after each proven change and queues a revert candidate
 *           (`docs/.output/evolution/skills/revert-candidates.json`) when a regression is plausible. It reads git and writes that
 *           queue: it never reverts, resets or checks out anything, and nothing here ever applies a change. The intake surfaces
 *           a candidate as `revertCandidates` only after rebuilding it from the ledger and a fresh window (the queue's own text is
 *           never rendered); a malformed or unmatched queue entry is reported in `rejectedRevertCandidates`.
 * Thresholds come from `improvement.graduation` ({consecutive: 10, maxReverts: 0}) and `improvement.watch` ({runs: 5,
 * minSample: 3, dropPoints: 20, rise: 1}) in the gate config AS COMMITTED AT HEAD (`.claude/gate.config.json`, `git show HEAD:...`,
 * like ship-check.js: an uncommitted edit changes nothing, and the `.agents` copy is not read); a wrong value, an unknown key, an
 * unparseable config or a broken ledger exits 2 naming the key or the file, never an empty report. Every git probe runs with
 * `-C <root>` and without the GIT_DIR / GIT_WORK_TREE family.
 *
 * The scheduled cycle's gates (SF-4.11), read from the same committed gate config:
 *   auto-check        the cycle's plan (candidates, runs, tokens, cost) must be covered by `improvement.budget` ({maxCandidates: 1,
 *                     maxRuns: 30, maxTokens: 10000000, maxCostUsd: 20} by default) AND must be able to finish: the runs times the
 *                     cost of a run (an estimate from the first live cycle, printed with its source) must fit the plan's own caps.
 *                     Exit 0 within budget, exit 12 over it (the run result seam's budget-exhausted code; the cycle makes no model
 *                     call), exit 2 on a bad plan or config. `--skill NAME` derives the plan from the suite and the block instead of
 *                     taking it from the caller (a suite below 2 dev evals or 1 holdout eval is refused, exit 1, because a measured
 *                     candidate could never be applied) and prints the `regress` values to pass to `skill-regress.js run`.
 *   auto-apply-check  `improvement.autoApply` is "off" unless the committed file says exactly "on" (the owner edits and commits a
 *                     protected file to enable it). Off: exit 1 whatever the evidence says, the cycle only stages. On: exit 0 only
 *                     for a ledger entry that is still the newest for its hash and still `staged`, an additive reference change
 *                     with a dev delta above 0, a holdout delta at or above 0, at least 3 replicates, no fragile flag (Owner Decision
 *                     12) and a benchmark that is not low-power, whose class has GRADUATED on git-proven changes (`not-graduated`
 *                     otherwise); `apply --mode apply` then adds the protected-set check and the full gate.
 *   record-stop       a measurement that ended without a candidate to stage (a cap, a timeout) records a `dropped` ledger entry with
 *                     the tokens the workspace's own run records show.
 *                     Only record-stop writes (the ledger).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const conformance = require('./skill-conformance');
const failureLedger = require('./_lib/failure-ledger');
const improvementScope = require('./_lib/improvement-scope');
const fsSafe = require('./_lib/fs-safe');
const { stamp: runStamp, dayKey } = require('./_lib/run-stamp');
const skillApply = require('./_lib/skill-apply');
const skillEval = require('./skill-eval');
const { HEADER: ISSUE_HEADER } = require('./agent-issue-log');

const ATTRIBUTE_MIN_SCORE = 2; // floor in units of the lowest possible IDF weight (see attributeSignal)
const COVERAGE_MIN_MATCHED = 4; // distinct shared tokens that make a memory cluster "already covered"
const ATTRIBUTE_MIN_DISTINCT_TOKENS = 2; // a single incidental literal must never bind a signal

// Winner-over-runner-up ratio required to call an attribution CONFIDENT.
//
// Measured across a sample of real agent-update sections: margins ran 1.04-1.27 with
// one outlier at 1.91. A known-CORRECT attribution sat at 1.19 and a known-WRONG one
// (a signal that matched only because an unrelated word in its text also appears in
// the skill's name) sat at 1.17. They are not separable by margin, and re-scoping
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
// Score of a structured row whose Skill cell exactly names a skill, when its prose overlaps the skill
// little or not at all. A confident token attribution scores about 13-17 (IDF-weighted); a named
// skill is at least as strong evidence, so it ranks beside them instead of below.
const EXACT_ATTRIBUTION_SCORE = 10;
const GATE_RECURRENCE_MIN = 2;  // genuine failing rows (changed trees) of one signature that make it recurring
const MAX_DECISIONS_BYTES = 4 * 1024 * 1024;

// Where the guardrail rules live (the same order `_lib/improvement-scope.js` resolves them in).
const RULES_CANDIDATES = ['.agents/config/guardrail-rules.yaml', '.claude/guardrail-rules.yaml'];
// A project without its own rules file is judged by the toolkit's: this file sits at
// `<root>/.agents/core/` here and in an installed project's runtime core directory, both two levels below the root.
const TOOLKIT_ROOT = path.resolve(__dirname, '..', '..');

const DECISIONS_REL = ['docs', '.output', 'evolution', 'skills', '_decisions.md'];
// `- {date} · {fingerprint} · **killed|deferred|applied** — {reason}` (the triage ledger pattern).
const DECISION_LINE_RE = /^\s*-\s+\d{4}-\d{2}-\d{2}\s+·\s+([^\s·]+)\s+·\s+\*\*(?:killed|deferred|applied)\*\*/;

const STOPWORDS = new Set(
    ('the a an and or but for nor so yet of to in on at by with from into onto upon as is are was were be been being ' +
        'this that these those it its their there here when then than them they your you our we us not no do does did ' +
        'doc docs file files use used using via per each any all one two new old set get run runs ran make made via ' +
        'should must never always when what which while because before after during about above below over under ' +
        // Generic English that survives the 4-char filter and scores like a domain
        // term. A skill DESCRIPTION is natural prose, so these appear in many of
        // them — and IDF cannot save a word that happens to be unique to one
        // description. A section with no real subject overlap can be attributed to a
        // skill on nothing but a handful of such words.
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
 * decides a whole section. Example: a section can be attributed to a skill with most of its
 * points coming from two NAME tokens that were present only because the text quotes a
 * fixture identifier containing those two words. A quoted identifier is not evidence about
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

// ── Skill index root ────────────────────────────────────────────────────────

/**
 * The skills directory the intake indexes: the canonical `.agents/skills` when it exists, else the
 * generated `.claude/skills` (an installation that has not migrated to the canonical layout).
 */
function resolveSkillsRoot(projectDir) {
    const canonical = path.join(projectDir, '.agents', 'skills');
    try {
        if (fs.statSync(canonical).isDirectory()) return canonical;
    } catch { /* absent or unreadable: fall back */ }
    return path.join(projectDir, '.claude', 'skills');
}

// ── Structured issue rows (the agent-issue-log.js table) ────────────────────

/**
 * Split one markdown table line into trimmed, decoded cells. Parity-aware, the inverse of the writer's
 * `cell()`: a run of n backslashes right before a pipe is an escaped literal pipe when n is odd (n = 2k+1
 * decodes to k backslashes plus the pipe) and a column delimiter when n is even. Returns null for a
 * line that does not start with a pipe.
 */
function splitTableRow(line) {
    const s = String(line).replace(/\r$/, '').trim();
    if (!s.startsWith('|')) return null;
    const cells = [];
    let cur = '';
    let i = 1;
    while (i < s.length) {
        if (s[i] === '\\') {
            let n = 0;
            while (s[i + n] === '\\') n++;
            if (s[i + n] === '|' && n % 2 === 1) {
                cur += '\\'.repeat((n - 1) / 2) + '|';
                i += n + 1;
            } else {
                cur += '\\'.repeat(n);
                i += n;
            }
        } else if (s[i] === '|') {
            cells.push(cur.trim());
            cur = '';
            i++;
        } else {
            cur += s[i];
            i++;
        }
    }
    if (cur.trim() !== '') cells.push(cur.trim());
    return cells;
}

const ISSUE_COLUMNS = splitTableRow(ISSUE_HEADER).map((c) => c.toLowerCase());
const isTableSeparator = (line) => /^\|[\s:|-]+$/.test(line.replace(/\r$/, '').trim()) && line.includes('-');

/**
 * Structured issue rows of one `## ` section: the rows under a header that is exactly the
 * agent-issue-log header, each with exactly one cell per column. A legacy table (other header) and
 * any row with another cell count are skipped. `-` in Skill or Signature is "none".
 */
function parseIssueRows(sectionText) {
    const rows = [];
    let inTable = false;
    for (const line of String(sectionText).split('\n')) {
        const cells = splitTableRow(line);
        if (cells === null) {
            inTable = false;
            continue;
        }
        if (!inTable) {
            inTable = cells.length === ISSUE_COLUMNS.length && cells.every((c, i) => c.toLowerCase() === ISSUE_COLUMNS[i]);
            continue;
        }
        if (isTableSeparator(line) || cells.length !== ISSUE_COLUMNS.length) continue;
        const [agent, story, skill, step, signature, run, issue, fix] = cells;
        rows.push({
            agent,
            story,
            skill: skill === '-' ? null : skill,
            step,
            signature: signature === '-' || signature === '' ? null : signature,
            run,
            issue,
            fix,
        });
    }
    return rows;
}

// The subsection heading the writer puts above its table (`agent-issue-log.js` SUBSECTION).
const ISSUE_SUBSECTION_RE = /^#{3}\s+Agent Issues\s*$/i;

/**
 * A `## ` section's text without its structured issue tables: each table's header, separator and every
 * row (parsed or malformed), plus the `### Agent Issues` heading that sits directly above it. What is left
 * is the section's prose, which `parseIssueRows` never reads. Appending a row to a section therefore leaves
 * this text (and so its fingerprint) as it was before the append.
 */
function stripIssueTables(sectionText) {
    const out = [];
    let inTable = false;
    for (const line of String(sectionText).split('\n')) {
        const cells = splitTableRow(line);
        if (cells === null) {
            inTable = false;
            out.push(line);
            continue;
        }
        if (inTable) continue;
        if (cells.length === ISSUE_COLUMNS.length && cells.every((c, i) => c.toLowerCase() === ISSUE_COLUMNS[i])) {
            inTable = true;
            let j = out.length;
            while (j > 0 && out[j - 1].trim() === '') j--;
            if (j > 0 && ISSUE_SUBSECTION_RE.test(out[j - 1].trim())) out.length = j - 1;
            continue;
        }
        out.push(line); // a table of another shape (a legacy table) is prose evidence
    }
    return out.join('\n');
}

/** Whether `text` has a line that is neither blank nor a markdown heading. */
const hasSubstantiveText = (text) => String(text).split('\n').some((l) => l.trim() !== '' && !/^\s*#{1,6}(\s|$)/.test(l));

// ── Fingerprints and the adjudication ledger ────────────────────────────────

/** Opaque, deterministic signal id: `{kind}-{12 hex}` over the parts (no whitespace, no `·`). */
function fingerprintOf(kind, parts) {
    const hash = crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 12);
    return `${kind}-${hash}`;
}

/**
 * Fingerprints recorded in the adjudication ledger (read-only). A missing, unreadable, non-file or
 * garbage ledger yields an empty set: it must never suppress a signal by accident or throw.
 */
function readDecisions(root) {
    const decided = new Set();
    let text;
    try {
        const file = path.join(root, ...DECISIONS_REL);
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_DECISIONS_BYTES) return decided;
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return decided;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = DECISION_LINE_RE.exec(line);
        if (m) decided.add(m[1]);
    }
    return decided;
}

// ── Protected targets ───────────────────────────────────────────────────────

/**
 * A `skill -> reason | null` check against the protected set. The rules come from the project's own
 * rules file when it has one, else the toolkit's. `classify` fails closed (an unusable rules file makes
 * every path `protected`), so an unusable project rules file protects every target.
 */
function makeProtectionCheck(root) {
    const projectHasRules = RULES_CANDIDATES.some((c) => fs.existsSync(path.join(root, c)));
    const toolkitRules = RULES_CANDIDATES.map((c) => path.join(TOOLKIT_ROOT, c)).find((f) => fs.existsSync(f));
    const options = projectHasRules || !toolkitRules ? { root } : { root, rulesPath: toolkitRules };
    const cache = new Map();
    return (skill) => {
        if (cache.has(skill)) return cache.get(skill);
        let reason = null;
        try {
            const res = improvementScope.classify(`.agents/skills/${skill}/SKILL.md`, { ...options, target: skill });
            if (res.class === 'protected') {
                reason = res.matched ? `protected set entry ${res.matched}` : res.reason;
                if (res.error) reason += `: ${truncate(res.error, 160)}`;
            }
        } catch (err) {
            reason = `protection check failed: ${truncate(err && err.message, 160)}`;
        }
        cache.set(skill, reason);
        return reason;
    };
}

// ── Recurring gate failures (the SF-1.5 failure ledger) ─────────────────────

/**
 * Signatures with GATE_RECURRENCE_MIN or more genuine failing rows, most frequent first. Counting rule
 * (the failure-ledger seam): a failure counts once per changed tree. Excluded: environment-class rows,
 * killed or timed-out rows, pass rows, rows without a signature, a flaky failure (its tree also has a
 * pass row, in either order, whose legs cover every leg the failure ran: `failureLedger.legsCover`) and a
 * repeat of the signature on the same non-null tree. A null tree is unknown and always counts. An absent,
 * empty or corrupt ledger is a no-op.
 *
 * Not `failureLedger.classify`: that judges the newest outcome's consecutive streak, while "recurring"
 * here is any signature seen on 2+ trees however long ago, so the two share the readers, the killed
 * predicate and the flaky leg rule but not the counting loop.
 */
function collectGateFailures(root) {
    let rows;
    try {
        rows = failureLedger.readLedger({ root });
    } catch {
        return [];
    }
    // Pass rows by tree: a failure is flaky only when a pass on its tree ran every leg it failed
    // (`legsCover`, the rule `failureLedger.classify` applies: a lint pass says nothing about a test failure).
    const passesByHead = new Map();
    for (const r of rows) {
        if (r.passed !== true || failureLedger.isKilled(r) || r.head == null) continue;
        if (!passesByHead.has(r.head)) passesByHead.set(r.head, []);
        passesByHead.get(r.head).push(r.legs);
    }
    const bySig = new Map();
    for (const r of rows) {
        if (r.passed === true || failureLedger.isKilled(r) || r.cls === 'environment') continue;
        if (typeof r.sig !== 'string' || r.sig === '') continue;
        if (r.head != null && (passesByHead.get(r.head) || []).some((passLegs) => failureLedger.legsCover(passLegs, r.legs))) continue; // flaky
        let entry = bySig.get(r.sig);
        if (!entry) {
            entry = { sig: r.sig, count: 0, legs: [], lastTs: null, heads: new Set() };
            bySig.set(r.sig, entry);
        }
        if (r.head != null) {
            if (entry.heads.has(r.head)) continue; // same tree again: a no-op, not a repeat
            entry.heads.add(r.head);
        }
        entry.count++;
        if (typeof r.ts === 'string') entry.lastTs = r.ts;
        for (const leg of Array.isArray(r.legs) ? r.legs : []) {
            if (typeof leg === 'string' && !entry.legs.includes(leg)) entry.legs.push(leg);
        }
    }
    return [...bySig.values()]
        .filter((e) => e.count >= GATE_RECURRENCE_MIN)
        .sort((a, b) => b.count - a.count || String(b.lastTs).localeCompare(String(a.lastTs)) || a.sig.localeCompare(b.sig))
        .map((e) => ({ sig: e.sig, count: e.count, legs: e.legs, lastTs: e.lastTs, fingerprint: fingerprintOf('gf', [e.sig]) }));
}

// ── Intake ──────────────────────────────────────────────────────────────────

/**
 * Signal units from the agent-update sections: one per parsed structured row, plus one for the section's
 * remaining prose (the section without its structured tables) when it has any; a section with no parsed
 * row (legacy prose, a legacy table, a section of only malformed rows) is one unit over its whole text.
 * Each carries a fingerprint; identical units in one run are told apart by occurrence number.
 */
function buildSignalUnits(agentUpdates) {
    const units = [];
    const seen = new Map();
    const stamp = (kind, parts) => {
        const key = parts.map(String).join('\u0000');
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        return fingerprintOf(kind, [...parts, n]);
    };
    for (const u of agentUpdates) {
        const rows = parseIssueRows(u.text);
        if (rows.length === 0) {
            units.push({ ...u, row: null, fingerprint: stamp('au', [u.date, u.context, u.text.trim()]) });
            continue;
        }
        for (const row of rows) {
            units.push({
                source: u.source,
                date: u.date,
                context: `${u.context}: ${truncate(row.issue, 100)}`,
                text: `${row.issue} ${row.fix}`,
                row,
                fingerprint: stamp('au', [u.date, u.context, row.agent, row.story, row.skill || '', row.step, row.signature || '', row.run, row.issue, row.fix]),
            });
        }
        // The writer appends its table to a section that may already hold prose (a wave's findings). The
        // prose is evidence too: it stays one unit, over the text with the structured tables removed.
        const residual = stripIssueTables(u.text);
        if (hasSubstantiveText(residual)) units.push({ ...u, text: residual, row: null, fingerprint: stamp('au', [u.date, u.context, residual.trim()]) });
    }
    return units;
}

const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isSinceDate = (v) => typeof v === 'string' && SINCE_RE.test(v);

function intake({ projectDir, since = null } = {}) {
    // A bare `--since` arrives as `true` and compares false against every date: it would read nothing and
    // report "no signal". A value that is not a date is refused instead of silently ignored.
    if (since != null && !isSinceDate(since)) throw new Error(`since must be a YYYY-MM-DD date, got ${JSON.stringify(since)}`);
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const skillsRoot = resolveSkillsRoot(root);
    const memRoot = path.join(root, 'docs', '.output', '.memory');
    const auDir = path.join(root, 'docs', '.output', 'evolution', 'agents');

    const skillIndex = buildSkillIndex(skillsRoot);
    const skillEntries = new Map(skillIndex.map((s) => [s.dir, s]));
    const idf = buildIdf(skillIndex);
    const decided = readDecisions(root);
    const protectionOf = makeProtectionCheck(root);

    // IMPROVE: attribute each signal unit to a skill — but read the
    // signal's POLARITY first. The scorer matches by domain keyword; it cannot
    // tell "this skill failed" (a gap to fix) from "this skill caught a defect"
    // (it worked). Two facets, both confirmed downstream:
    //   • caught + a review/safeguard skill ⇒ the safeguard fired; the real gap
    //     is the dev-agent DISPATCH PROMPT, not the skill → route to dispatchGaps.
    //   • caught (other) ⇒ down-rank (CAUGHT_WEIGHT) — working-as-intended is weak
    //     evidence for a rewrite.
    // Signal-vocabulary tokens ("agent", "skill", "dispatch", …) are stripped so
    // a misalignment doesn't bind to a skill merely for naming the artifact.
    //
    // A unit is one structured issue row, or one `## ` section with no parsed row. A row whose Skill
    // cell exactly names an indexed skill is a confident attribution without any prose margin (the
    // writer named the skill); every other unit goes through token overlap as before.
    let agentUpdates = collectAgentUpdates(auDir);
    if (since) agentUpdates = agentUpdates.filter((u) => u.date > since); // exclusive: a section on the --since date was already seen
    const units = buildSignalUnits(agentUpdates);
    const improveBySkill = {};
    const protectedBySkill = {};
    const unattributed = [];
    const dispatchGaps = [];
    const ambiguous = [];
    let adjudicated = 0;
    let attributed = 0;
    const rowCount = units.filter((u) => u.row).length;
    const exactAttributed = units.filter((u) => u.row && u.row.skill && skillEntries.has(u.row.skill)).length;
    for (const u of units) {
        if (decided.has(u.fingerprint)) {
            adjudicated++;
            continue;
        }
        const tokens = tokenize(u.text, SIGNAL_STOPWORDS);
        let skill;
        let attribution;
        let score;
        if (u.row && u.row.skill && skillEntries.has(u.row.skill)) {
            skill = u.row.skill;
            attribution = 'exact';
            score = Math.max(scoreOverlap(tokens, skillEntries.get(skill), idf), EXACT_ATTRIBUTION_SCORE);
        } else {
            const hit = attributeSignal(tokens, skillIndex);
            if (!hit) {
                unattributed.push({ type: 'agent-update', date: u.date, context: u.context, fingerprint: u.fingerprint });
                continue;
            }
            if (!hit.confident) {
                // Near-tie. Report the candidates and let a human adjudicate rather
                // than seeding an expensive differential eval against a coin-flip.
                ambiguous.push({
                    date: u.date,
                    context: u.context,
                    polarity: classifyPolarity(u.text),
                    margin: hit.margin,
                    alternatives: hit.alternatives,
                    fingerprint: u.fingerprint,
                });
                continue;
            }
            skill = hit.skill;
            attribution = 'tokens';
            score = hit.score;
        }
        attributed++;
        const polarity = classifyPolarity(u.text);
        if (REVIEW_DOMAIN_SKILLS.has(skill) && CAUGHT_RE.test(u.text)) {
            // The review/safeguard skill did its job — don't seed a Δ=0 skill-body
            // eval. The actionable gap is upstream in the dispatch prompt.
            dispatchGaps.push({
                skill,
                source: u.source,
                date: u.date,
                context: u.context,
                reason: 'review/safeguard skill but the signal shows it CAUGHT the defect — likely a dev-agent dispatch-prompt gap, not a gap in this skill',
                fingerprint: u.fingerprint,
            });
            continue;
        }
        const evidence = { source: u.source, date: u.date, context: u.context, polarity, attribution, fingerprint: u.fingerprint };
        if (u.row) Object.assign(evidence, { step: u.row.step, signature: u.row.signature, issue: u.row.issue });
        const protectedReason = protectionOf(skill);
        if (protectedReason) {
            // A judge or protected-set file is never an improvement target, whatever the evidence says.
            (protectedBySkill[skill] ||= { skill, reason: protectedReason, evidence: [] }).evidence.push(evidence);
            continue;
        }
        const weight = polarity === 'caught' ? CAUGHT_WEIGHT : 1;
        (improveBySkill[skill] ||= { skill, score: 0, evidence: [] });
        improveBySkill[skill].score = round(improveBySkill[skill].score + score * weight);
        improveBySkill[skill].evidence.push(evidence);
    }
    const improve = Object.values(improveBySkill).sort((a, b) => b.score - a.score);
    const protectedTargets = Object.values(protectedBySkill);

    // Recurring gate failures: a signal about the gate, not about any one skill, so it never creates an
    // IMPROVE entry; a person decides whether a recurring signature points at a skill.
    const gateFailures = collectGateFailures(root).filter((g) => {
        if (!decided.has(g.fingerprint)) return true;
        adjudicated++;
        return false;
    });

    // Revert candidates (SF-4.10): the queue `watch` writes says WHICH commits to look at; this is how one reaches "the next
    // intake". Every candidate is rebuilt from the evidence (the ledger entry and a fresh watch window), a malformed or unmatched
    // queue entry is reported and never rendered, and a candidate whose fingerprint is decided in the adjudication ledger is not
    // resurfaced.
    const surfaced = surfaceRevertCandidates(root, decided);
    const revertCandidates = surfaced.candidates;
    const rejectedRevertCandidates = surfaced.rejected;
    const suppressedRevertCandidates = surfaced.suppressed; // listed so that a suppression by a decision line is never invisible
    adjudicated += surfaced.adjudicated;

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
        // The cluster is identified by its member memory ids, so a decided cluster stays suppressed until
        // its membership changes.
        const fingerprint = fingerprintOf('cl', members.map((m) => m.id).sort());
        if (decided.has(fingerprint)) {
            adjudicated++;
            continue;
        }
        const topTokens = [...merged].slice(0, 6);
        create.push({
            fingerprint,
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
        // agentUpdates counts `## ` sections; rows and exactAttributed count what was PARSED (before the
        // adjudication ledger); attributed, ambiguous, unattributed and gateFailures count what is SURFACED.
        signals: {
            agentUpdates: agentUpdates.length,
            rows: rowCount,
            exactAttributed,
            attributed,
            ambiguous: ambiguous.length,
            unattributed: unattributed.length,
            adjudicated,
            gateFailures: gateFailures.length,
            revertCandidates: revertCandidates.length,
            rejectedRevertCandidates: rejectedRevertCandidates.length,
            memories: memories.length,
            clusters: clusters.length,
        },
        improve,
        create,
        dispatchGaps,
        unattributed,
        ambiguous,
        protectedTargets,
        gateFailures,
        revertCandidates,
        rejectedRevertCandidates,
        suppressedRevertCandidates,
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
    const fp = (item) => (item && item.fingerprint ? ` \`${item.fingerprint}\`` : '');
    L.push(`# Skill Evolution Intake — ${date || ''}`.trim());
    L.push('');
    L.push(`**Signals:** ${report.signals.agentUpdates} agent-update sections · ${report.signals.memories} memories · ${report.signals.clusters} clusters`);
    if (report.signals.rows !== undefined) {
        L.push(`**Structured rows:** ${report.signals.rows} parsed · ${report.signals.exactAttributed} exact-attributed · ${report.signals.attributed} attributed · ${report.signals.ambiguous} ambiguous · ${report.signals.unattributed} unattributed · ${report.signals.adjudicated} adjudicated (suppressed) · ${report.signals.gateFailures} recurring gate failures`);
    }
    L.push('');
    L.push('_Each signal ends with its fingerprint. To stop a signal resurfacing, append `- {date} · {fingerprint} · **killed|deferred|applied** — {reason}` to `docs/.output/evolution/skills/_decisions.md`._');
    L.push('');
    L.push('## IMPROVE candidates (failure-trace → skill fix)');
    L.push('');
    if (!report.improve.length) L.push('_None — no agent-update misalignments attributed to a skill._');
    for (const c of report.improve) {
        L.push(`### \`${c.skill}\` (signal score ${c.score})`);
        for (const e of c.evidence) L.push(`- ${e.date} — ${e.context}${e.polarity && e.polarity !== 'neutral' ? ` _(${e.polarity})_` : ''}${e.attribution ? ` _[${e.attribution}]_` : ''}${fp(e)}`);
        L.push('');
    }
    if (report.protectedTargets && report.protectedTargets.length) {
        L.push('## Protected targets (NOT improvable — in the protected set)');
        L.push('');
        L.push('_These skills attracted evidence, but they are in the protected set (`_lib/improvement-scope.js`): an improvement run may not edit them. A person decides; nothing here seeds an eval._');
        L.push('');
        for (const p of report.protectedTargets) {
            L.push(`### \`${p.skill}\` — ${p.reason}`);
            for (const e of p.evidence) L.push(`- ${e.date} — ${e.context}${fp(e)}`);
            L.push('');
        }
    }
    if (report.gateFailures && report.gateFailures.length) {
        L.push('## Recurring gate failures (the gate, not a skill — NOT attributed)');
        L.push('');
        L.push('_The failure ledger names no skill. Each signature below failed on 2 or more changed trees (flaky and environment failures excluded). A person decides whether one points at a skill gap before any candidate is drafted._');
        L.push('');
        for (const g of report.gateFailures) L.push(`- \`${String(g.sig).slice(0, 12)}\` × ${g.count} (legs: ${g.legs.join(', ') || 'n/a'}; last ${g.lastTs || 'n/a'})${fp(g)}`);
        L.push('');
    }
    if (report.revertCandidates && report.revertCandidates.length) {
        L.push('## Revert candidates (an applied change followed by a plausible regression — a person decides)');
        L.push('');
        L.push('_`watch` compared the run scoreboard before and after each change below. Nothing is reverted automatically: if the regression is real, run the revert command on a branch, then append `- {date} · {fingerprint} · **applied|killed|deferred** — {reason}` to `docs/.output/evolution/skills/_decisions.md`._');
        L.push('');
        for (const c of report.revertCandidates) {
            // Rebuilt from the evidence by the intake, and still sanitised here: the revert command is computed from the commit,
            // never taken from the report, and nothing else can carry a backtick or a line break into the line.
            const plain = (v) => String(v).replace(/[`\r\n]/g, ' ');
            const metrics = (Array.isArray(c.metrics) ? c.metrics : []).map((m) => `${plain(m.metric)} ${plain(m.before)} → ${plain(m.after)}`).join(', ');
            const revert = typeof c.commit === 'string' && COMMIT_ID_RE.test(c.commit) ? revertTextOf(c.commit) : 'an invalid commit id';
            L.push(`- \`${plain(c.skill)}\` — \`${revert}\` (applied ${plain(c.applied_at)}; ${metrics || 'no metric recorded'})${fp(c)}`);
        }
        L.push('');
    }
    if (report.suppressedRevertCandidates && report.suppressedRevertCandidates.length) {
        L.push('## Revert candidates hidden by a decision line (shown so a suppression is never invisible)');
        L.push('');
        for (const f of report.suppressedRevertCandidates) L.push(`- \`${String(f).replace(/[\`\r\n]/g, ' ')}\` is decided in \`docs/.output/evolution/skills/_decisions.md\``);
        L.push('');
    }
    if (report.rejectedRevertCandidates && report.rejectedRevertCandidates.length) {
        L.push('## Rejected revert-candidate queue entries (malformed or matching no applied change — NOT shown)');
        L.push('');
        L.push(`_${report.rejectedRevertCandidates.length} entr${report.rejectedRevertCandidates.length === 1 ? 'y' : 'ies'} of \`docs/.output/evolution/skills/revert-candidates.json\` did not validate against the ledger. Their text is not reproduced here. Repair or remove them; \`watch\` refuses to append to a queue that holds one._`);
        L.push('');
        for (const r of report.rejectedRevertCandidates) L.push(`- ${r.index === null ? 'unmatched entry' : `entry ${r.index}`}: ${String(r.problem).replace(/[\`\r\n]/g, ' ')}`);
        L.push('');
    }
    if (report.dispatchGaps && report.dispatchGaps.length) {
        L.push('## Dispatch-prompt gaps (reviewer caught — NOT a skill gap)');
        L.push('');
        L.push('_These signals attributed to a review/safeguard skill, but their text shows the safeguard **caught** the defect. The fix belongs in the dev-agent dispatch prompt (e.g. `/run-todo`), not in a skill-body eval that would read Δ=0._');
        L.push('');
        for (const d of report.dispatchGaps) L.push(`- ${d.date} — ${d.context} → caught by \`${d.skill}\`${fp(d)}`);
        L.push('');
    }
    L.push('## CREATE candidates (clustered memories → new skill)');
    L.push('');
    if (!report.create.length) L.push('_None — no uncovered recurring memory cluster._');
    for (const c of report.create) {
        L.push(`### proposed: \`${c.proposedName}\` (${c.size} memories, conf ${c.avgConfidence}${c.coveredBy ? `, weakly near \`${c.coveredBy}\`` : ''})${fp(c)}`);
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
            L.push(`- ${a.date} — ${a.context} _(${a.polarity}, margin ${a.margin ?? 'n/a'}x)_${fp(a)}`);
            L.push(`  candidates: ${a.alternatives.join(' · ')}`);
        }
        L.push('');
    }

    if (report.unattributed.length) {
        L.push('## Unattributed signals (possible missing skill / too vague)');
        for (const u of report.unattributed) L.push(`- ${u.date} — ${u.context}${fp(u)}`);
        L.push('');
    }
    return L.join('\n') + '\n';
}

// ── check: gate a candidate body against the skill spec ─────────────────────

/**
 * Whether a candidate is a reference file: a `references` directory is an ancestor, at any depth, between the
 * file and its skill root (the nearest directory holding a SKILL.md). A file named SKILL.md is always a skill
 * candidate, so `references/SKILL.md` still faces the name and description rules.
 */
function isReferenceCandidate(candidateFile) {
    const abs = path.resolve(candidateFile);
    if (path.basename(abs) === 'SKILL.md') return false;
    let dir = path.dirname(abs);
    for (;;) {
        if (path.basename(dir) === 'references') return true;
        if (fs.existsSync(path.join(dir, 'SKILL.md'))) return false; // reached the skill root without one
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

function check(skillName, candidateFile) {
    if (!fs.existsSync(candidateFile)) {
        return { ok: false, error: `candidate not found: ${candidateFile}`, findings: [] };
    }
    const content = fs.readFileSync(candidateFile, 'utf8');
    const fm = conformance.extractFrontmatter(content);
    // A reference file (any file under `<skill>/references/`) has no name or description to validate: the frontmatter
    // rules are skipped by passing the values they compare against, and only the size finding is kept.
    const isReference = isReferenceCandidate(candidateFile);
    const findings = conformance.evaluateSkill({
        dir: skillName,
        name: isReference ? skillName : conformance.parseField(fm, 'name'),
        description: isReference ? '' : conformance.parseField(fm, 'description'),
        lineCount: conformance.countLines(content),
    });
    const errors = findings.filter((f) => f.severity === 'ERROR');
    return { ok: errors.length === 0, findings };
}

// ── The audit trail's readers: config, graduation, watch and the revert-candidate queue (SF-4.10) ──

const DEFAULT_GRADUATION = Object.freeze({ consecutive: 10, maxReverts: 0 });
const DEFAULT_WATCH = Object.freeze({ runs: 5, minSample: 3, dropPoints: 20, rise: 1 });
// The one file the switches and thresholds come from, read as COMMITTED at HEAD (like ship-check.js): an uncommitted edit, by any
// writer, never moves a threshold that gates an unattended apply.
const GATE_CONFIG_REL = '.claude/gate.config.json';
const IMPROVEMENT_KEYS = ['graduation', 'watch', 'autoApply', 'budget'];
const REVERT_QUEUE_REL = 'docs/.output/evolution/skills/revert-candidates.json';
const QUEUE_VERSION = 1;
const RUN_STAMP_RE = /^(\d{6}-\d{4})(?!\d)/;
const METRIC_EPSILON = 1e-9;
// The kind of a queue entry, never an argument to git: that nothing here spawns a git verb that changes history is pinned by a spy on
// child_process in skill-apply.test.js, not by a text search.
const REVERT_KIND = 'revert';

/** A malformed ledger, queue or config: the CLI exits 2 naming the file or key instead of reading it as empty. */
class InputError extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
const isPositiveNumber = (v) => isNum(v) && v > 0;
const roundTo = (n, digits) => parseFloat(n.toFixed(digits));

function validateGraduation(g) {
    if (!isPositiveInteger(g.consecutive)) throw new InputError(`improvement.graduation.consecutive must be a positive integer (got ${JSON.stringify(g.consecutive)})`);
    if (!(Number.isInteger(g.maxReverts) && g.maxReverts >= 0)) throw new InputError(`improvement.graduation.maxReverts must be a non-negative integer (got ${JSON.stringify(g.maxReverts)})`);
    return { consecutive: g.consecutive, maxReverts: g.maxReverts };
}

function validateWatch(w) {
    if (!isPositiveInteger(w.runs)) throw new InputError(`improvement.watch.runs must be a positive integer (got ${JSON.stringify(w.runs)})`);
    if (!isPositiveInteger(w.minSample)) throw new InputError(`improvement.watch.minSample must be a positive integer (got ${JSON.stringify(w.minSample)})`);
    if (w.minSample > w.runs) throw new InputError(`improvement.watch.minSample (${w.minSample}) must not exceed improvement.watch.runs (${w.runs})`);
    if (!isPositiveNumber(w.dropPoints)) throw new InputError(`improvement.watch.dropPoints must be a positive number (got ${JSON.stringify(w.dropPoints)})`);
    if (!isPositiveNumber(w.rise)) throw new InputError(`improvement.watch.rise must be a positive number (got ${JSON.stringify(w.rise)})`);
    return { runs: w.runs, minSample: w.minSample, dropPoints: w.dropPoints, rise: w.rise };
}

/**
 * The gate config object (`.claude/gate.config.json`) as committed at HEAD; {} when HEAD or the file does not exist (the
 * defaults). The working tree is never consulted: the file is editable by any main-thread writer, and a switch or threshold that
 * gates an unattended apply must leave history. Git runs with `-C <root>` and without the GIT_DIR family. A file at HEAD that
 * cannot be read or is not a JSON object is an InputError (never read as empty).
 */
function readGateConfig(root) {
    const git = skillApply.gitFor(root);
    if (git.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).status !== 0) return {};
    const listing = git.run(['ls-tree', '-z', 'HEAD', '--', `./${GATE_CONFIG_REL}`]);
    if (listing.status !== 0) throw new InputError(`${GATE_CONFIG_REL} cannot be looked up at HEAD: ${truncate(listing.stderr, 160)}`);
    if (listing.stdout.trim() === '') return {};
    const shown = git.run(['show', `HEAD:./${GATE_CONFIG_REL}`]);
    if (shown.status !== 0) throw new InputError(`${GATE_CONFIG_REL} cannot be read at HEAD: ${truncate(shown.stderr, 160)}`);
    let parsed;
    try {
        parsed = JSON.parse(shown.stdout);
    } catch (err) {
        throw new InputError(`${GATE_CONFIG_REL} is not valid JSON at HEAD: ${err.message}`);
    }
    if (!isPlainObject(parsed)) throw new InputError(`${GATE_CONFIG_REL} must hold a JSON object at HEAD`);
    return parsed;
}

/** The `improvement` object of the committed gate config ({} when there is none); an unknown key under it is an InputError. */
function readImprovement(root) {
    const config = readGateConfig(root);
    if (config.improvement !== undefined && !isPlainObject(config.improvement)) throw new InputError('improvement must be an object');
    const improvement = config.improvement || {};
    for (const key of Object.keys(improvement)) {
        if (!IMPROVEMENT_KEYS.includes(key)) throw new InputError(`improvement.${key} is not an improvement key (expected ${IMPROVEMENT_KEYS.join(', ')})`);
    }
    return improvement;
}

function mergeBlock(defaults, given, key) {
    if (given === undefined) return { ...defaults };
    if (!isPlainObject(given)) throw new InputError(`improvement.${key} must be an object`);
    for (const name of Object.keys(given)) {
        if (!Object.prototype.hasOwnProperty.call(defaults, name)) throw new InputError(`improvement.${key}.${name} is not a ${key} key (expected ${Object.keys(defaults).join(', ')})`);
    }
    return { ...defaults, ...given };
}

/**
 * `improvement.graduation` and `improvement.watch` from the gate config, merged over the defaults and validated. A block a
 * caller does not need (`graduation: false`) is not validated. Throws InputError naming the dotted key or the file.
 */
function readImprovementConfig(root, { graduation = true, watch: watchBlock = true } = {}) {
    const improvement = readImprovement(root);
    // The shape and the key names of BOTH blocks are always checked (a mistyped key is never silently ignored, whichever verb
    // runs); only the values a caller needs are validated.
    const gradBlock = mergeBlock(DEFAULT_GRADUATION, improvement.graduation, 'graduation');
    const watchMerged = mergeBlock(DEFAULT_WATCH, improvement.watch, 'watch');
    return {
        graduation: graduation ? validateGraduation(gradBlock) : { ...DEFAULT_GRADUATION },
        watch: watchBlock ? validateWatch(watchMerged) : { ...DEFAULT_WATCH },
    };
}

/** Every evolution ledger below `root`, oldest date first. A broken ledger is an InputError naming its file. */
function loadLedgers(root) {
    try {
        return skillApply.loadLedgers(root);
    } catch (err) {
        throw new InputError(err.message);
    }
}

// ── evaluateWatch: the pure before/after comparison ──

const stampOf = (row) => {
    const m = row !== null && typeof row === 'object' && typeof row.run_id === 'string' ? RUN_STAMP_RE.exec(row.run_id) : null;
    return m === null ? null : m[1];
};

const percentOf = (part, whole) => (whole > 0 ? roundTo((part / whole) * 100, 1) : null);

function meanOf(values) {
    const known = values.filter(isNum);
    return known.length === 0 ? null : roundTo(known.reduce((a, b) => a + b, 0) / known.length, 2);
}

/** One side of the comparison, with the scoreboard's own metric definitions. */
function summarizeRuns(rows) {
    const withWaves = rows.filter((r) => isNum(r.waves) && isNum(r.first_pass_green_waves) && r.waves > 0);
    return {
        runs: rows.length,
        success_rate: percentOf(rows.filter((r) => r.status === 'passed').length, rows.length),
        first_pass_green_rate: percentOf(withWaves.reduce((n, r) => n + r.first_pass_green_waves, 0), withWaves.reduce((n, r) => n + r.waves, 0)),
        mean_fix_rounds: meanOf(rows.map((r) => r.fix_rounds)),
        mean_gate_failures: meanOf(rows.map((r) => r.gate_failures)),
    };
}

/**
 * Compare the scoreboard's runs before and after an applied change. Pure: no I/O, the rows are never mutated.
 *   entry   needs `applied_at` (an ISO instant)
 *   runs    scoreboard rows (`buildScoreboard().runs`); only rows with a record and a `YYMMDD-HHMM` run id count
 *   config  a partial `improvement.watch` merged over DEFAULT_WATCH
 * BEFORE is the `runs` latest runs whose stamp is strictly earlier than the applied minute (local time, like the run ids);
 * AFTER is the `runs` earliest runs at or after it. Fewer than `minSample` on either side is noise: `insufficient-sample`,
 * never a flag. Otherwise `regression` when a rate fell by `dropPoints` or more points (success rate, first-pass-green rate)
 * or a mean rose by `rise` or more (fix rounds, gate failures); a metric with no data on a side never regresses.
 * @returns {{status: string, before: object, after: object, regressions: {metric: string, before: number, after: number}[]}}
 */
function evaluateWatch({ entry, runs, config } = {}) {
    const cfg = validateWatch({ ...DEFAULT_WATCH, ...(isPlainObject(config) ? config : {}) });
    const appliedAt = entry !== null && typeof entry === 'object' ? entry.applied_at : undefined;
    if (typeof appliedAt !== 'string' || !Number.isFinite(Date.parse(appliedAt))) {
        throw new Error('evaluateWatch needs entry.applied_at, an ISO-8601 instant');
    }
    const applied = runStamp(new Date(appliedAt));
    const ordered = (Array.isArray(runs) ? runs : [])
        .filter((r) => r !== null && typeof r === 'object' && r.has_record === true && stampOf(r) !== null)
        .map((row) => ({ row, at: stampOf(row) }))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.row.run_id < b.row.run_id ? -1 : a.row.run_id > b.row.run_id ? 1 : 0)));
    const before = summarizeRuns(ordered.filter((x) => x.at < applied).slice(-cfg.runs).map((x) => x.row));
    const after = summarizeRuns(ordered.filter((x) => x.at >= applied).slice(0, cfg.runs).map((x) => x.row));
    if (before.runs < cfg.minSample || after.runs < cfg.minSample) return { status: 'insufficient-sample', before, after, regressions: [] };

    const regressions = [];
    const consider = (metric, was, now, worse) => {
        if (was !== null && now !== null && worse(was, now)) regressions.push({ metric, before: was, after: now });
    };
    const dropped = (was, now) => was - now >= cfg.dropPoints - METRIC_EPSILON;
    const rose = (was, now) => now - was >= cfg.rise - METRIC_EPSILON;
    consider('success_rate', before.success_rate, after.success_rate, dropped);
    consider('first_pass_green_rate', before.first_pass_green_rate, after.first_pass_green_rate, dropped);
    consider('mean_fix_rounds', before.mean_fix_rounds, after.mean_fix_rounds, rose);
    consider('mean_gate_failures', before.mean_gate_failures, after.mean_gate_failures, rose);
    return { status: regressions.length > 0 ? 'regression' : 'stable', before, after, regressions };
}

// ── git proof: what counts as an applied change ──
//
// The ledger is evidence, not the source of truth. An applied entry counts (graduation, `watch`, the unattended-apply gate)
// only when git proves it (`skillApply.openEvidence`): its commit is reachable from the repository's DEFAULT branch (`origin/HEAD`,
// else `main`, else `master`; never the HEAD of the current checkout), its diff on the skill's files is exactly the change the
// entry evaluated (`delta_sha256`; a squash merge is matched by that diff, not by ancestry), and one commit serves one entry.
// Reverts are read from the trees (a later commit on the default branch that restores the pre-image of those files), never from a
// message. The window of a change starts at its commit time on the default branch, not at the recorded `applied_at`.

/** The scoreboard's run rows, built on first use (a run of `status` with no applied entry never builds one). */
function lazyRuns(root) {
    let rows = null;
    return () => {
        if (rows === null) {
            const { buildScoreboard } = require('./run-scoreboard');
            const board = buildScoreboard({ root });
            rows = Array.isArray(board.runs) ? board.runs : [];
        }
        return rows;
    };
}

/**
 * What `watch`, `status` and the intake say about one applied entry, from git: 'no-commit', 'not-merged' (not on the default
 * branch), 'unverified' (on it, but not proven to be this entry's change, or a commit another entry already holds), 'reverted',
 * and, for a change that is live, evaluateWatch's 'insufficient-sample' | 'stable' | 'regression'. Only the last two count.
 * `view` is `appliedView(root, ledgers)`.
 */
function assessApplied(entry, view, getRuns, watchConfig) {
    const none = (status, reason) => ({ status, before: null, after: null, regressions: [], ...(reason === undefined ? {} : { reason }) });
    if (entry.commit === null) return none('no-commit');
    if (view.claims.owner.get(entry.commit) !== entry) return none('unverified', 'its commit is already counted for another entry');
    const proof = view.evidence.assess(entry, view.claims.othersOf(entry));
    if (proof.state === 'not-merged') return none('not-merged', proof.reason);
    if (proof.state === 'unverified') return none('unverified', proof.reason);
    if (proof.state === 'reverted') return none('reverted');
    return evaluateWatch({ entry: { ...entry, applied_at: proof.commitTime }, runs: getRuns(), config: watchConfig });
}

/** The applied entries oldest first by their recorded instant (the `--date` of a run only names its folder), ties in recording order. */
function orderedApplied(ledgers) {
    return ledgers.flatMap((l) => l.entries.filter((e) => e.disposition === 'applied'))
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => (Date.parse(a.entry.applied_at) - Date.parse(b.entry.applied_at)) || (a.index - b.index))
        .map((x) => x.entry);
}

function appliedView(root, ledgers) {
    const applied = orderedApplied(ledgers);
    return { applied, evidence: skillApply.openEvidence(root), claims: skillApply.claimCommits(applied) };
}

// ── the revert-candidate queue ──

const queueFile = (root) => path.join(root, ...REVERT_QUEUE_REL.split('/'));
const QUEUE_CANDIDATE_KEYS = ['applied_at', 'candidate_sha256', 'commit', 'fingerprint', 'kind', 'metrics', 'revert', 'skill'];
const QUEUE_METRICS = ['success_rate', 'first_pass_green_rate', 'mean_fix_rounds', 'mean_gate_failures'];
const SKILL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const COMMIT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64_LOWER_RE = /^[0-9a-f]{64}$/;
const revertTextOf = (commit) => skillApply.revertText(commit);

/** Why a queue entry is not a candidate `watch` could have written, or null. Every field that reaches a person is validated here. */
function candidateProblem(c) {
    if (!isPlainObject(c)) return 'it is not an object';
    const keys = Object.keys(c).sort();
    if (keys.length !== QUEUE_CANDIDATE_KEYS.length || keys.some((k, i) => k !== QUEUE_CANDIDATE_KEYS[i])) return `it must have exactly the keys ${QUEUE_CANDIDATE_KEYS.join(', ')}`;
    if (c.kind !== REVERT_KIND) return 'kind is not a revert candidate';
    if (typeof c.skill !== 'string' || !SKILL_NAME_RE.test(c.skill)) return 'skill is not a skill directory name';
    if (typeof c.commit !== 'string' || !COMMIT_ID_RE.test(c.commit)) return 'commit is not a 40 (or 64) lower-case hex commit id';
    if (typeof c.candidate_sha256 !== 'string' || !HEX64_LOWER_RE.test(c.candidate_sha256)) return 'candidate_sha256 is not 64 lower-case hex characters';
    if (typeof c.applied_at !== 'string' || !Number.isFinite(Date.parse(c.applied_at)) || new Date(c.applied_at).toISOString() !== c.applied_at) return 'applied_at is not an ISO-8601 UTC instant';
    if (c.revert !== revertTextOf(c.commit)) return `revert is not exactly "${revertTextOf('<commit>')}" for its commit`;
    if (c.fingerprint !== fingerprintOf('rv', [c.commit])) return 'fingerprint is not the fingerprint of its commit';
    if (!Array.isArray(c.metrics)) return 'metrics is not an array';
    for (const m of c.metrics) {
        if (!isPlainObject(m) || Object.keys(m).sort().join() !== 'after,before,metric' || !QUEUE_METRICS.includes(m.metric) || !isNum(m.before) || !isNum(m.after)) {
            return `metrics must hold only {metric (${QUEUE_METRICS.join(', ')}), before, after} with finite numbers`;
        }
    }
    return null;
}

/**
 * The queue's candidates, each validated: {candidates, rejected: [{index, problem}]} ([] and [] when there is no queue). A queue
 * that is unreadable, not JSON or not the `{version, candidates}` envelope is an InputError naming it; a malformed ENTRY is
 * reported in `rejected`, never rendered.
 */
function parseRevertQueue(root) {
    const file = queueFile(root);
    let text;
    try {
        if (!fs.lstatSync(file).isFile()) throw new Error('it is not a regular file');
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { candidates: [], rejected: [] };
        throw new InputError(`the revert-candidate queue ${REVERT_QUEUE_REL} cannot be read: ${err && err.message}`);
    }
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        throw new InputError(`the revert-candidate queue ${REVERT_QUEUE_REL} is not valid JSON: ${err.message}`);
    }
    if (!(isPlainObject(doc) && Object.keys(doc).sort().join() === 'candidates,version' && doc.version === QUEUE_VERSION && Array.isArray(doc.candidates))) {
        throw new InputError(`the revert-candidate queue ${REVERT_QUEUE_REL} is not a valid queue (expected {"version": ${QUEUE_VERSION}, "candidates": [...]} of revert candidates)`);
    }
    const candidates = [];
    const rejected = [];
    doc.candidates.forEach((c, index) => {
        const problem = candidateProblem(c);
        if (problem === null) candidates.push(c);
        else rejected.push({ index, problem });
    });
    return { candidates, rejected };
}

/** The queue's candidates for a WRITER: a queue holding a malformed entry is an InputError (it is never re-serialised). */
function readRevertQueue(root) {
    const parsed = parseRevertQueue(root);
    if (parsed.rejected.length > 0) {
        const first = parsed.rejected[0];
        throw new InputError(`the revert-candidate queue ${REVERT_QUEUE_REL} holds ${parsed.rejected.length} malformed entr${parsed.rejected.length === 1 ? 'y' : 'ies'} (entry ${first.index}: ${first.problem}); repair or remove it`);
    }
    return parsed.candidates;
}

/** Append the candidates the queue does not hold yet (by fingerprint), under a lock; returns the ones newly queued. Never rewrites an entry. */
function appendToRevertQueue(root, candidates) {
    const file = queueFile(root);
    const fresh = [];
    for (const c of candidates) {
        const problem = candidateProblem(c);
        if (problem !== null) throw new Error(`watch built a revert candidate that is not valid (${problem})`);
    }
    fsSafe.safeMkdirp(path.dirname(file), root);
    fsSafe.safeMkdirp(path.dirname(skillApply.lockPathFor(root, file)), root);
    skillApply.withFileLock(skillApply.lockPathFor(root, file), () => {
        const queued = readRevertQueue(root);
        const known = new Set(queued.map((c) => c.fingerprint));
        for (const c of candidates) {
            if (known.has(c.fingerprint)) continue;
            known.add(c.fingerprint);
            fresh.push(c);
        }
        if (fresh.length === 0) return;
        skillApply.writeAtomic(file, `${JSON.stringify({ version: QUEUE_VERSION, candidates: [...queued, ...fresh] }, null, 2)}\n`, root);
    });
    return fresh;
}

/**
 * For every applied ledger entry, compare the scoreboard before and after its commit's time on the default branch; a plausible
 * regression is queued as a revert candidate for the next intake. Reads the ledgers, the scoreboard, git and the config; writes
 * only the queue. It never reverts, resets or checks out anything. Throws InputError on a broken ledger, queue or config.
 * @returns {{watched: object[], emitted: object[], queue: string}}
 */
function watch({ projectDir } = {}) {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const { watch: watchConfig } = readImprovementConfig(root, { graduation: false });
    const view = appliedView(root, loadLedgers(root));
    const getRuns = lazyRuns(root);

    const watched = [];
    const candidates = [];
    for (const entry of view.applied) {
        const assessed = assessApplied(entry, view, getRuns, watchConfig);
        watched.push({
            skill: entry.skill,
            commit: entry.commit,
            candidate_sha256: entry.candidate_sha256,
            applied_at: entry.applied_at,
            status: assessed.status,
            ...(assessed.reason === undefined ? {} : { reason: assessed.reason }),
            before: assessed.before,
            after: assessed.after,
            regressions: assessed.regressions,
        });
        if (assessed.status !== 'regression') continue;
        candidates.push({
            kind: REVERT_KIND,
            skill: entry.skill,
            commit: entry.commit,
            candidate_sha256: entry.candidate_sha256,
            revert: entry.revert,
            applied_at: entry.applied_at,
            metrics: assessed.regressions,
            fingerprint: fingerprintOf('rv', [entry.commit]),
        });
    }
    // The queue is only opened when there is something to add: a clean watch creates nothing.
    const emitted = candidates.length > 0 ? appendToRevertQueue(root, candidates) : [];
    return { watched, emitted, queue: REVERT_QUEUE_REL };
}

/**
 * The queue's candidates as the intake surfaces them: rebuilt from the evidence, never taken from the file. A candidate shows
 * only when its commit is still an applied ledger entry's proven, live change whose watch window still shows a regression; the
 * skill, instant, revert command and metrics are the ledger's and the scoreboard's, so a planted or stale queue entry cannot put
 * text in front of a person. Entries that match no applied entry are reported with the malformed ones.
 * A candidate whose fingerprint is decided in the adjudication ledger is not rebuilt and is counted in `adjudicated`.
 * @returns {{candidates: object[], rejected: {index: number|null, problem: string}[], adjudicated: number, suppressed: string[]}}
 */
function surfaceRevertCandidates(root, decided) {
    const { candidates: queuedAll, rejected } = parseRevertQueue(root);
    const queued = queuedAll.filter((c) => !decided.has(c.fingerprint));
    const suppressed = queuedAll.filter((c) => decided.has(c.fingerprint)).map((c) => c.fingerprint);
    const adjudicated = suppressed.length;
    if (queued.length === 0) return { candidates: [], rejected, adjudicated, suppressed };
    const { watch: watchConfig } = readImprovementConfig(root, { graduation: false });
    const view = appliedView(root, loadLedgers(root));
    const getRuns = lazyRuns(root);
    const surfaced = [];
    for (const c of queued) {
        const entry = view.applied.find((e) => e.commit === c.commit && e.candidate_sha256 === c.candidate_sha256 && e.skill === c.skill);
        if (entry === undefined) {
            rejected.push({ index: null, problem: `the queued candidate ${c.fingerprint} matches no applied ledger entry, so it is not surfaced` });
            continue;
        }
        const assessed = assessApplied(entry, view, getRuns, watchConfig);
        if (assessed.status !== 'regression') continue; // reverted since, the regression cleared, or no longer provable
        surfaced.push({
            kind: REVERT_KIND,
            skill: entry.skill,
            commit: entry.commit,
            candidate_sha256: entry.candidate_sha256,
            revert: revertTextOf(entry.commit),
            applied_at: entry.applied_at,
            metrics: assessed.regressions,
            fingerprint: c.fingerprint,
        });
    }
    return { candidates: surfaced, rejected, adjudicated, suppressed };
}

// ── graduation: a measured decision for Owner Decision 12's upgrade path ──

/**
 * Per change class, over the applied entries in the order they were applied (`applied_at`, then recording order). Only a change
 * git proves counts (see the section above):
 *   merged       commit proven on the default branch, enough scoreboard runs around it, and not reverted:  the entries the streak is made of
 *   pending      no commit yet, or not on the default branch (never break the streak)
 *   unverified   on the default branch but not proven to be the entry's change, or a commit another entry holds (never count)
 *   unmeasured   proven, but fewer than `minSample` scoreboard runs on a side of its window: no observation, so neither extends
 *                nor breaks the streak (never count)
 *   reverts      merged entries whose change the default branch's later history undid;  regressions = proven, live entries whose
 *                watch window shows a regression
 *   consecutive  from the newest counted entry backwards, the entries before the first reverted or regressed one
 *   ready        consecutive >= thresholds.consecutive, reverts <= thresholds.maxReverts and no holdout regression in the class
 */
function buildGraduation(root, ledgers, config) {
    const classes = {};
    const view = appliedView(root, ledgers);
    if (view.applied.length > 0) {
        const getRuns = lazyRuns(root);
        for (const entry of view.applied) {
            const key = entry.change_class === null ? 'unclassified' : entry.change_class;
            const bucket = (classes[key] ||= { merged: [], pending: 0, unverified: 0, unmeasured: 0, holdoutRegressed: false });
            if (isNum(entry.holdout_delta) && entry.holdout_delta < 0) bucket.holdoutRegressed = true;
            const { status } = assessApplied(entry, view, getRuns, config.watch);
            if (status === 'no-commit' || status === 'not-merged') bucket.pending++;
            else if (status === 'unverified') bucket.unverified++;
            else if (status === 'insufficient-sample') bucket.unmeasured++;
            else bucket.merged.push({ reverted: status === 'reverted', regressed: status === 'regression' });
        }
    }
    const report = {};
    for (const [key, bucket] of Object.entries(classes)) {
        let consecutive = 0;
        for (let i = bucket.merged.length - 1; i >= 0; i--) {
            if (bucket.merged[i].reverted || bucket.merged[i].regressed) break;
            consecutive++;
        }
        const reverts = bucket.merged.filter((m) => m.reverted).length;
        report[key] = {
            consecutive,
            reverts,
            holdoutRegressed: bucket.holdoutRegressed,
            regressions: bucket.merged.filter((m) => m.regressed).length,
            pending: bucket.pending,
            unverified: bucket.unverified,
            unmeasured: bucket.unmeasured,
            ready: consecutive >= config.graduation.consecutive && reverts <= config.graduation.maxReverts && !bucket.holdoutRegressed,
        };
    }
    return report;
}

/** Run-dirs are named {YYYY-MM-DD} and sit either flat under `base` or one level deep under a {YYYY-MM}/ month dir; `latest/` is the no-date run. */
function listIntakeRuns(base) {
    const runs = new Map(); // run date -> display path ('/' separator, cross-platform output)
    const addRun = (date, rel) => { if (!runs.has(date)) runs.set(date, rel); };
    if (!fs.existsSync(base)) return [];
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
    // Ascending sort puts date-named runs first and 'latest' (0x6C > 0x39) last; after reverse, 'latest' (the newest
    // unstamped run) tops the list. Sorted by run DATE (the basename), not the relative path: a month-nested path
    // would sort by location ('-' < '/') and list nested runs above newer flat runs.
    return [...runs.keys()].sort().reverse().map((date) => `${runs.get(date)}/intake.md`);
}

/**
 * What `status` reports: the intake runs, the ledgers (newest date first) with their disposition counts, and per change class
 * the graduation numbers against the configured thresholds. Reads and writes nothing else. Throws InputError on a broken
 * ledger or config.
 */
function statusReport(root) {
    const config = readImprovementConfig(root);
    const ledgers = loadLedgers(root);
    const byDisposition = { applied: 0, dropped: 0, staged: 0, rejected: 0 };
    let entries = 0;
    for (const l of ledgers) {
        for (const e of l.entries) {
            byDisposition[e.disposition]++;
            entries++;
        }
    }
    return {
        runs: listIntakeRuns(path.join(root, 'docs', '.output', 'evolution', 'skills')),
        ledgers: [...ledgers].reverse().map((l) => `${l.date}/ledger.json`),
        ledger: { entries, by_disposition: byDisposition },
        // `defaultBranch` is the branch a change must be on to count (null: it cannot be resolved, so nothing counts).
        graduation: { thresholds: config.graduation, defaultBranch: skillApply.openEvidence(root).defaultBranch().name, classes: buildGraduation(root, ledgers, config) },
    };
}

// ── The scheduled cycle's gates: the budget block, the auto-apply switch and the stop record (SF-4.11) ──
//
// `/review:evolve-skills --auto` is the headless propose-only cycle. The decisions in it that move money or code are made by code:
//   auto-check        refuse to START when the cycle's plan is above the budget block, or when the plan cannot finish at the cost of
//                     a run (exit 12, no model call). `--skill` makes code derive the plan (the number of runs, the caps) from the
//                     suite and the block, so the caller states none of the numbers it is checked against.
//   auto-apply-check  may a staged candidate be applied? Only with `improvement.autoApply` set to "on" in the gate config
//                     (the protected file, read as committed at HEAD) and every condition of Owner Decision 12's upgrade path met;
//                     the default is "off", so a cycle only ever stages.
//   record-stop       a cycle that spent money and did not stage (a cap stopped the run, a timeout, no run executed) still writes a
//                     `dropped` ledger entry with the tokens the workspace's own run records show.
// All three read the gate config and the evolution ledger; only record-stop writes (the ledger). The apply helper
// (`apply --mode apply`) still enforces the protected-set check, the render, the conformance check and the full gate on the branch
// it creates. What no code here can do is bind a model that runs in the same session as the caller: see the workflow's "--auto"
// section for which walls are code and which are the session's own.

const AUTO_APPLY_VALUES = ['off', 'on'];
const DEFAULT_AUTO_APPLY = 'off';
// The measurement must be able to meet the verdict's non-low-power floors that the cycle controls: `skill-eval.js verdict` calls an
// accept low-power (propose, never apply) below LOW_POWER_MIN_RUNS_PER_ARM runs per arm and below LOW_POWER_MIN_EVALS dev evals.
// The third floor (discordant assertions) depends on the data, so it is only recorded and checked (`decideAutoApply`).
const CYCLE_REPEAT = skillEval.LOW_POWER_MIN_RUNS_PER_ARM;
const CYCLE_MIN_DEV_EVALS = skillEval.LOW_POWER_MIN_EVALS;
const CYCLE_MIN_HOLDOUT_EVALS = 1;
const CYCLE_ARMS = 2; // with_skill and the baseline
// The cost of one `skill-regress.js run` agent, measured: the first live cycle (2026-11-19) spent 2,021,762 tokens and $2.18 over
// 7 runs (288,823 tokens and $0.31 per run); the estimate rounds both up. A plan whose runs times this is above its caps cannot finish.
const CYCLE_RUN_ESTIMATE = Object.freeze({
    tokens: 300000,
    costUsd: 0.35,
    source: 'the first live cycle, 2026-11-19: 2,021,762 tokens and $2.18 over 7 runs, rounded up',
});
// Passed to `skill-regress.js run` as --agent-max-usd: one agent's own cap, so the run that crosses a cap cannot overshoot it by more.
const CYCLE_AGENT_MAX_USD = 2;
// The defaults fit the seeded suites at CYCLE_REPEAT runs per arm: the largest has 2 dev and 1 holdout evals = 18 runs, about
// 5.4M tokens and $6.30; 30 runs (five evals) at the estimate is 9M tokens and $10.50, inside the block below.
const DEFAULT_CYCLE_BUDGET = Object.freeze({ maxCandidates: 1, maxRuns: 30, maxTokens: 10000000, maxCostUsd: 20 });
const EXIT_BUDGET_EXCEEDED = 12; // the run result seam's budget-exhausted code (`run-record.js`), also skill-regress's stop code
const AUTO_APPLY_CLASS = 'additive-reference';
const AUTO_APPLY_MIN_REPLICATES = 3;
// The planned values a cycle must state, in the order the CLI documents them; each is compared with its cap.
const PLAN_KEYS = [
    { key: 'candidates', flag: '--candidates', limit: 'maxCandidates', integer: true },
    { key: 'runs', flag: '--runs', limit: 'maxRuns', integer: true },
    { key: 'tokens', flag: '--tokens', limit: 'maxTokens', integer: true },
    { key: 'costUsd', flag: '--cost-usd', limit: 'maxCostUsd', integer: false },
];

/** `improvement.autoApply` from the gate config: "off" (the default) or "on". Anything else is an InputError (fail closed). */
function readAutoApply(root) {
    const value = readImprovement(root).autoApply;
    if (value === undefined) return DEFAULT_AUTO_APPLY;
    if (!AUTO_APPLY_VALUES.includes(value)) {
        throw new InputError(`improvement.autoApply must be "off" or "on" (got ${JSON.stringify(value)}); it stays off until it is exactly "on"`);
    }
    return value;
}

/** `improvement.budget` from the gate config, merged over the defaults. Unknown keys and wrong values are InputErrors. */
function readCycleBudget(root) {
    const given = readImprovement(root).budget;
    if (given !== undefined && !isPlainObject(given)) throw new InputError('improvement.budget must be an object');
    const budget = { ...DEFAULT_CYCLE_BUDGET, ...(given || {}) };
    for (const key of Object.keys(budget)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_CYCLE_BUDGET, key)) {
            throw new InputError(`improvement.budget.${key} is not a budget key (expected ${Object.keys(DEFAULT_CYCLE_BUDGET).join(', ')})`);
        }
    }
    for (const spec of PLAN_KEYS) {
        const v = budget[spec.limit];
        const ok = spec.integer ? isPositiveInteger(v) : isPositiveNumber(v);
        if (!ok) throw new InputError(`improvement.budget.${spec.limit} must be a positive ${spec.integer ? 'integer' : 'number'} (got ${JSON.stringify(v)})`);
    }
    return budget;
}

/**
 * Compare a cycle's plan with the budget block. `planned` carries all four of candidates, runs, tokens and costUsd (a missing
 * or negative one is an InputError: a plan that does not state its spend cannot be checked) and may carry `extraCostUsd`, the
 * spend that is not the regression run's (the drafting call, the last run's overshoot), which counts toward the cost ceiling.
 * A key is exceeded when its planned value is above its cap. Two further keys are judged from the cost of a run
 * (CYCLE_RUN_ESTIMATE): `estimatedTokens` and `estimatedCostUsd` are exceeded when the planned runs times the estimate is above the
 * plan's own token or cost cap, i.e. when the plan would be stopped by its cap before its last run: the cycle must not start it.
 * Returns { ok, limits, planned, estimate, exceeded: [{ key, planned, limit }] }.
 */
function checkCycleBudget(root, planned) {
    const limits = readCycleBudget(root);
    const plan = {};
    const exceeded = [];
    for (const spec of PLAN_KEYS) {
        const v = planned ? planned[spec.key] : undefined;
        const ok = spec.integer ? Number.isInteger(v) && v >= 0 : isNum(v) && v >= 0;
        if (!ok) throw new InputError(`the plan must state ${spec.flag} as a non-negative ${spec.integer ? 'integer' : 'number'} (got ${JSON.stringify(v)})`);
        plan[spec.key] = v;
    }
    const extra = planned && planned.extraCostUsd !== undefined ? planned.extraCostUsd : 0;
    if (!(isNum(extra) && extra >= 0)) throw new InputError(`the plan must state --extra-cost-usd as a non-negative number (got ${JSON.stringify(extra)})`);
    plan.extraCostUsd = extra;
    for (const spec of PLAN_KEYS) {
        const total = spec.key === 'costUsd' ? roundTo(plan.costUsd + extra, 6) : plan[spec.key];
        if (total > limits[spec.limit]) exceeded.push({ key: spec.key, planned: total, limit: limits[spec.limit] });
    }
    const estimate = {
        perRunTokens: CYCLE_RUN_ESTIMATE.tokens,
        perRunCostUsd: CYCLE_RUN_ESTIMATE.costUsd,
        tokens: plan.runs * CYCLE_RUN_ESTIMATE.tokens,
        costUsd: roundTo(plan.runs * CYCLE_RUN_ESTIMATE.costUsd, 6),
        source: CYCLE_RUN_ESTIMATE.source,
    };
    if (estimate.tokens > plan.tokens) exceeded.push({ key: 'estimatedTokens', planned: estimate.tokens, limit: plan.tokens });
    if (estimate.costUsd > plan.costUsd) exceeded.push({ key: 'estimatedCostUsd', planned: estimate.costUsd, limit: plan.costUsd });
    return { ok: exceeded.length === 0, limits, planned: plan, estimate, exceeded };
}

/**
 * The suite's checkable eval counts for `skill`, read by `tools/skill-regress.js list` (the tool the cycle measures with; it sits
 * beside the helpers in the repository, in a pinned copy of one, and in the workshop only). Any failure is an InputError.
 */
function suiteCounts(root, skill) {
    const tool = path.resolve(__dirname, '..', '..', 'tools', 'skill-regress.js');
    if (!fs.existsSync(tool)) throw new InputError(`tools/skill-regress.js is not present beside the helpers (${tool}): the cycle cannot count the suite`);
    const r = spawnSync(process.execPath, [tool, 'list', '--skill', skill, '--root', root], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    let doc = null;
    try {
        doc = JSON.parse(r.stdout);
    } catch {
        doc = null;
    }
    if (r.status !== 0 || doc === null || !isPlainObject(doc.counts) || !Number.isInteger(doc.counts.dev) || !Number.isInteger(doc.counts.holdout)) {
        throw new InputError(`skill-regress.js list failed for ${skill} (exit ${r.status}): ${truncate(r.stderr || r.stdout, 200)}`);
    }
    return { dev: doc.counts.dev, holdout: doc.counts.holdout };
}

/**
 * The plan the cycle MUST run for `skill`, derived from the suite and the budget block and not stated by the caller: the number
 * of runs is (dev + holdout) x 2 arms x CYCLE_REPEAT, the token cap is the block's less one run (the stop is checked before each
 * run, so the last one may pass the cap by about a run), and the cost cap is the block's less the spend that is not the regression
 * run's (the drafting call `draftCostUsd` and one agent's cap for the last run). A suite below the minimum is not eligible: the
 * result says so and no plan exists. Otherwise the result of checkCycleBudget plus `regress`: the values to pass to `run`.
 */
function deriveCyclePlan(root, skill, { candidates, draftCostUsd = 0 } = {}) {
    const counts = suiteCounts(root, skill);
    if (counts.dev < CYCLE_MIN_DEV_EVALS || counts.holdout < CYCLE_MIN_HOLDOUT_EVALS) {
        return { ok: false, eligible: false, counts, reason: `${skill} has ${counts.dev} dev and ${counts.holdout} holdout checkable evals; a measured candidate can only be applied with at least ${CYCLE_MIN_DEV_EVALS} dev evals and ${CYCLE_MIN_HOLDOUT_EVALS} holdout eval, so it is not staged` };
    }
    const limits = readCycleBudget(root);
    const runs = (counts.dev + counts.holdout) * CYCLE_ARMS * CYCLE_REPEAT;
    const extraCostUsd = roundTo(CYCLE_AGENT_MAX_USD + draftCostUsd, 6);
    const tokens = limits.maxTokens - CYCLE_RUN_ESTIMATE.tokens;
    const costUsd = roundTo(limits.maxCostUsd - extraCostUsd, 6);
    if (tokens <= 0 || costUsd <= 0) throw new InputError(`improvement.budget.maxTokens and maxCostUsd are too small for one run plus the spend that is not the regression run's (${CYCLE_RUN_ESTIMATE.tokens} tokens, $${extraCostUsd})`);
    const result = checkCycleBudget(root, { candidates, runs, tokens, costUsd, extraCostUsd });
    return { ...result, eligible: true, counts, regress: { repeat: CYCLE_REPEAT, maxRuns: runs, maxTokens: tokens, maxCostUsd: costUsd, agentMaxUsd: CYCLE_AGENT_MAX_USD } };
}

/** The power of the benchmark a ledger entry points at, or null when it cannot be read (an entry whose power is unknown is not applied). */
function benchmarkPowerOf(root, entry) {
    if (typeof entry.benchmark !== 'string' || entry.benchmark === '') return null;
    const file = path.isAbsolute(entry.benchmark) ? entry.benchmark : path.join(root, ...entry.benchmark.split('/'));
    try {
        if (!fs.lstatSync(file).isFile()) return null;
        const benchmark = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isPlainObject(benchmark) || !Array.isArray(benchmark.evals)) return null;
        const baselineConfig = (Array.isArray(benchmark.configs) && typeof benchmark.configs[1] === 'string' && benchmark.configs[1]) || skillEval.BASELINE_DIRS[0];
        return skillEval.computePower(benchmark, baselineConfig);
    } catch {
        return null;
    }
}

/**
 * May the staged candidate with this hash be applied unattended? Reads `improvement.autoApply` and the NEWEST ledger entry carrying
 * the hash, which must still be `staged` (a candidate that was applied, dropped or rejected since is not a candidate). With the
 * switch off the answer is no whatever the evidence says. With it on, every condition of Owner Decision 12's upgrade path that the
 * ledger records must hold: an additive reference change, a dev delta above zero, a holdout delta at or above zero, at least 3
 * replicates per arm and a candidate that is not fragile, and a measurement that is not low-power by the verdict's own floors (read
 * from the benchmark the entry points at: `apply --mode apply` refuses a low-power accept, so this check must not answer yes to one).
 * The protected-set check and the full gate are not in the ledger: `apply --mode apply` runs them itself and restores everything when
 * either fails. Returns { allowed, autoApply, reasons, entry }; `reasons` is empty only when allowed.
 */
function decideAutoApply(root, candidateSha256) {
    const autoApply = readAutoApply(root);
    if (typeof candidateSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(candidateSha256)) {
        throw new InputError('--candidate-sha256 must be a 64-character hex hash');
    }
    if (autoApply !== 'on') return { allowed: false, autoApply, reasons: ['auto-apply-off'], entry: null };
    const sha = candidateSha256.toLowerCase();
    let entry = null;
    for (const ledger of loadLedgers(root)) {
        for (const e of ledger.entries) if (e.candidate_sha256 === sha) entry = e; // ledgers run oldest first, entries in the order they were written
    }
    if (entry === null) return { allowed: false, autoApply, reasons: ['no-staged-entry'], entry: null };
    if (entry.disposition !== 'staged') return { allowed: false, autoApply, reasons: ['not-staged'], entry };
    const reasons = [];
    if (entry.change_class !== AUTO_APPLY_CLASS) reasons.push('not-additive-reference');
    if (!isNum(entry.delta) || !(skillEval.deltaSign(entry.delta) > 0)) reasons.push('no-improvement');
    if (!isNum(entry.holdout_delta)) reasons.push('no-holdout');
    else if (skillEval.deltaSign(entry.holdout_delta) < 0) reasons.push('holdout-regression');
    if (!Number.isInteger(entry.replicates) || entry.replicates < AUTO_APPLY_MIN_REPLICATES) reasons.push('insufficient-replicates');
    if (entry.fragile !== false) reasons.push('fragile-or-unknown');
    const power = benchmarkPowerOf(root, entry);
    if (power === null) reasons.push('low-power-unknown');
    else if (power.lowPower) reasons.push('low-power');
    // The upgrade is a measured decision: the class must have graduated on changes git proves (see `buildGraduation`), never on
    // what the ledger merely says. A forged ledger can add entries that do not count, so it cannot graduate a class.
    const config = readImprovementConfig(root);
    const graduated = buildGraduation(root, loadLedgers(root), config)[AUTO_APPLY_CLASS];
    if (graduated === undefined || graduated.ready !== true) reasons.push('not-graduated');
    return { allowed: reasons.length === 0, autoApply, reasons, entry };
}

// ── record-stop: a cycle that spent money and staged nothing still leaves a ledger entry ──

/** sha256 over every regular file below `dir` (path and content digest, sorted); a symlink counts as its target text; a missing dir is the empty hash. */
function hashTree(dir) {
    const rows = [];
    const walk = (abs, rel) => {
        let dirents;
        try {
            dirents = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of dirents) {
            const childAbs = path.join(abs, ent.name);
            const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
            if (ent.isDirectory()) walk(childAbs, childRel);
            else if (ent.isSymbolicLink()) rows.push(`${childRel}\0link:${fs.readlinkSync(childAbs)}`);
            else if (ent.isFile()) rows.push(`${childRel}\0${crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex')}`);
        }
    };
    walk(dir, '');
    rows.sort();
    return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

/**
 * What a run spent, summed from the `run-status.json` of every run the highest iteration of `workspace` attempted (the dev
 * `iteration-<N>` and the holdout beside it): the run records are the tool's own, written for every attempted run, so the total does not
 * depend on what a caller says. Returns { tokens: {with_skill, baseline}, duration_ms: {with_skill, baseline}, runs }.
 */
function workspaceSpend(workspace) {
    const spend = { tokens: { with_skill: 0, baseline: 0 }, duration_ms: { with_skill: 0, baseline: 0 }, runs: 0 };
    const iterations = (base) => {
        try {
            return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && /^iteration-\d+$/.test(e.name)).map((e) => Number(e.name.slice('iteration-'.length)));
        } catch {
            return [];
        }
    };
    const highest = Math.max(0, ...iterations(workspace), ...iterations(path.join(workspace, 'holdout')));
    if (highest === 0) return spend;
    const visit = (dir, depth) => {
        let dirents;
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of dirents) {
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory() && depth < 5) visit(abs, depth + 1);
            else if (ent.isFile() && ent.name === 'run-status.json') {
                let doc;
                try {
                    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
                } catch {
                    continue;
                }
                const arm = path.basename(path.dirname(path.dirname(abs))) === 'with_skill' ? 'with_skill' : 'baseline';
                spend.tokens[arm] += (isNum(doc.tokensIn) ? doc.tokensIn : 0) + (isNum(doc.tokensOut) ? doc.tokensOut : 0);
                spend.duration_ms[arm] += isNum(doc.durationMs) ? doc.durationMs : 0;
                spend.runs++;
            }
        }
    };
    visit(path.join(workspace, `iteration-${highest}`), 0);
    visit(path.join(workspace, 'holdout', `iteration-${highest}`), 0);
    return spend;
}

/**
 * Record that a measurement ended without a candidate to stage (a cap, a timeout, no run executed) as a `dropped` ledger entry in
 * `root`, with the tokens and time the workspace's run records show. The hashes are those of the workspace's `candidate/` and
 * `skill-snapshot/` as the run left them. Writes only the ledger. Returns { ok, ledger, tokens, runs, candidateSha256 } or { ok: false, reason }.
 */
function recordStop({ root, skill, run, evidence = [], date } = {}) {
    if (typeof skill !== 'string' || !SKILL_NAME_RE.test(skill)) throw new InputError('--skill must be a skill directory name');
    if (typeof run !== 'string' || run === '') throw new InputError('--run <workspace> is required');
    const workspace = path.resolve(run);
    let st;
    try {
        st = fs.lstatSync(workspace);
    } catch {
        st = null;
    }
    if (st === null || !st.isDirectory()) throw new InputError(`--run ${run} is not a workspace directory`);
    const day = date === undefined ? dayKey(new Date()) : date;
    if (!skillApply.validDate(day)) throw new InputError(`--date needs a real YYYY-MM-DD date, got ${JSON.stringify(day)}`);
    const spend = workspaceSpend(workspace);
    const entry = {
        skill,
        path: `.agents/skills/${skill}`,
        evidence,
        candidate_sha256: hashTree(path.join(workspace, 'candidate')),
        snapshot_sha256: hashTree(path.join(workspace, 'skill-snapshot')),
        delta_sha256: null,
        benchmark: null,
        delta: null,
        replicates: null,
        holdout_delta: null,
        fragile: null,
        tokens: spend.tokens,
        duration_ms: spend.duration_ms,
        disposition: 'dropped',
        commit: null,
        revert: null,
        applied_at: null,
        change_class: null,
    };
    const written = skillApply.appendLedger({ root, date: day, entry });
    if (!written.ok) return { ok: false, reason: written.reason || written.error || JSON.stringify(written) };
    return { ok: true, ledger: `docs/.output/evolution/skills/${day}/ledger.json`, tokens: spend.tokens, runs: spend.runs, candidateSha256: entry.candidate_sha256 };
}

/** The cycle gates' CLI. Prints exactly one JSON object; exit 0 ok, 1 refused, 2 invalid input, 12 over budget. */
function runAutoCli(argv, root) {
    const verb = argv[0];
    const FLAGS = {
        'auto-check': { '--candidates': 'candidates', '--runs': 'runs', '--tokens': 'tokens', '--cost-usd': 'costUsd', '--extra-cost-usd': 'extraCostUsd', '--skill': 'skill', '--draft-cost-usd': 'draftCostUsd' },
        'auto-apply-check': { '--candidate-sha256': 'candidateSha256' },
        'record-stop': { '--skill': 'skill', '--run': 'run', '--evidence': 'evidence', '--date': 'date' },
    };
    const USAGE = {
        'auto-check': 'auto-check --candidates N (--runs N --tokens N --cost-usd X [--extra-cost-usd X] | --skill NAME [--draft-cost-usd X])',
        'auto-apply-check': 'auto-apply-check --candidate-sha256 <hex64>',
        'record-stop': 'record-stop --skill NAME --run <workspace> [--evidence id,id] [--date YYYY-MM-DD]',
    };
    const flags = FLAGS[verb];
    try {
        const given = {};
        for (let i = 1; i < argv.length; i++) {
            const key = flags[argv[i]];
            if (key === undefined) throw new InputError(`unknown or unexpected argument ${argv[i]} (usage: ${USAGE[verb]})`);
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new InputError(`${argv[i]} needs a value`);
            if (Object.prototype.hasOwnProperty.call(given, key)) throw new InputError(`${argv[i]} given twice`);
            given[key] = value;
            i++;
        }
        if (verb === 'auto-check') {
            const number = (raw, integer) => (raw !== undefined && (integer ? /^\d+$/ : /^(?:\d+(?:\.\d+)?|\.\d+)$/).test(raw) ? Number(raw) : undefined);
            let result;
            if (given.skill !== undefined) {
                for (const stated of ['runs', 'tokens', 'costUsd', 'extraCostUsd']) {
                    if (given[stated] !== undefined) throw new InputError('with --skill the runs, the caps and the extra cost come from the suite and the budget block: do not state --runs, --tokens, --cost-usd or --extra-cost-usd');
                }
                if (!SKILL_NAME_RE.test(given.skill)) throw new InputError('--skill must be a skill directory name');
                const draftCostUsd = given.draftCostUsd === undefined ? 0 : number(given.draftCostUsd, false);
                if (draftCostUsd === undefined) throw new InputError('--draft-cost-usd must be a non-negative number');
                const candidates = number(given.candidates, true);
                if (candidates === undefined) throw new InputError('the plan must state --candidates as a non-negative integer (got undefined)');
                result = deriveCyclePlan(root, given.skill, { candidates, draftCostUsd });
                if (result.eligible === false) {
                    console.log(JSON.stringify(result));
                    console.error(`[SKILL-EVOLUTION] the cycle will not start: ${result.reason}`);
                    return 1;
                }
            } else {
                if (given.draftCostUsd !== undefined) throw new InputError('--draft-cost-usd needs --skill (state --extra-cost-usd for an explicit plan)');
                const planned = {};
                for (const spec of PLAN_KEYS) planned[spec.key] = number(given[spec.key], spec.integer);
                if (given.extraCostUsd !== undefined) {
                    planned.extraCostUsd = number(given.extraCostUsd, false);
                    if (planned.extraCostUsd === undefined) throw new InputError('--extra-cost-usd must be a non-negative number');
                }
                result = checkCycleBudget(root, planned);
            }
            console.log(JSON.stringify(result));
            if (!result.ok) {
                const say = (x) => (x.key === 'estimatedTokens' || x.key === 'estimatedCostUsd'
                    ? `${x.key} ${x.planned} (${result.planned.runs} runs at ${x.key === 'estimatedTokens' ? `${result.estimate.perRunTokens} tokens` : `$${result.estimate.perRunCostUsd}`} a run: ${result.estimate.source}) is above the cap ${x.limit}, so the run could not finish`
                    : `${x.key} ${x.planned} is above ${x.limit}`);
                console.error(`[SKILL-EVOLUTION] the cycle will not start: ${result.exceeded.map(say).join('; ')}`);
                return EXIT_BUDGET_EXCEEDED;
            }
            return 0;
        }
        if (verb === 'record-stop') {
            const ids = given.evidence === undefined || given.evidence === '' ? [] : given.evidence.split(',');
            const result = recordStop({ root, skill: given.skill, run: given.run, evidence: ids, date: given.date });
            console.log(JSON.stringify(result));
            if (!result.ok) console.error(`[SKILL-EVOLUTION] the stop was not recorded: ${result.reason}`);
            return result.ok ? 0 : 1;
        }
        const result = decideAutoApply(root, given.candidateSha256);
        console.log(JSON.stringify({ allowed: result.allowed, autoApply: result.autoApply, reasons: result.reasons }));
        if (!result.allowed) {
            const hint = result.reasons.includes('auto-apply-off') ? '; the switch is read from the gate config as committed at HEAD, so an edit counts only once it is committed' : '';
            console.error(`[SKILL-EVOLUTION] not applied unattended: ${result.reasons.join(', ')} (the candidate stays staged)${hint}`);
        }
        return result.allowed ? 0 : 1;
    } catch (err) {
        if (!(err instanceof InputError)) throw err;
        console.log(JSON.stringify({ ok: false, error: err.message }));
        console.error(`[SKILL-EVOLUTION] ${err.message}`);
        return 2;
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(argv) {
    const args = require('./skill-eval').parseArgs(argv);
    const cmd = args._[0];
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

    if (cmd === 'intake') {
        if (args.since !== undefined && !isSinceDate(args.since)) {
            console.error(`[SKILL-EVOLUTION] --since needs a YYYY-MM-DD date, got ${args.since === true ? 'no value' : JSON.stringify(args.since)}`);
            process.exit(2);
        }
        // `--date` only names the output folder, so it is a real calendar day and nothing else: a path (`../../x`) can never steer
        // the write out of `docs/.output/evolution/skills/`.
        if (args.date !== undefined && !skillApply.validDate(args.date)) {
            console.error(`[SKILL-EVOLUTION] --date needs a real YYYY-MM-DD date, got ${args.date === true ? 'no value' : JSON.stringify(args.date)}`);
            process.exit(2);
        }
        const report = intake({ projectDir: root, since: args.since === undefined ? null : args.since });
        const date = args.date || null;
        report.generated = date;
        if (args.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        const skillsOut = path.join(root, 'docs', '.output', 'evolution', 'skills');
        const outDir = path.join(skillsOut, date || 'latest');
        if (path.relative(skillsOut, outDir).split(path.sep).length !== 1) throw new InputError(`the intake folder ${outDir} is not directly under ${skillsOut}`);
        fsSafe.safeMkdirp(outDir, root);
        skillApply.writeAtomic(path.join(outDir, 'intake.json'), JSON.stringify(report, null, 2), root);
        skillApply.writeAtomic(path.join(outDir, 'intake.md'), renderIntakeMd(report, date), root);
        console.log(`[SKILL-EVOLUTION] ${report.improve.length} IMPROVE · ${report.create.length} CREATE · ${report.dispatchGaps.length} dispatch-gap · ${report.protectedTargets.length} protected · ${report.gateFailures.length} gate-failure · ${report.revertCandidates.length} revert-candidate → ${path.join(outDir, 'intake.md')}`);
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
        // Everything is computed (and every ledger and config validated) before anything is printed: a broken audit trail
        // never gets a partial or an empty report.
        const report = statusReport(root);
        if (args.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        if (!fs.existsSync(path.join(root, 'docs', '.output', 'evolution', 'skills'))) {
            console.log('[SKILL-EVOLUTION] no runs yet.');
            return;
        }
        for (const run of report.runs) console.log(`- ${run}`);
        const t = report.graduation.thresholds;
        for (const ledger of report.ledgers) console.log(`- ${ledger}`);
        const classes = Object.entries(report.graduation.classes);
        if (classes.length > 0) {
            console.log(`- counted only when git proves it on the default branch (${report.graduation.defaultBranch === null ? 'none found: nothing counts' : report.graduation.defaultBranch}); an unmeasured change (too few scoreboard runs around it) neither counts nor breaks the streak`);
        }
        for (const [name, c] of classes) {
            console.log(`- class ${name}: ${c.consecutive} of ${t.consecutive} consecutive merged accepts, ${c.reverts} revert(s) of ${t.maxReverts} allowed, ${c.regressions} regression(s), ${c.pending} pending, ${c.unmeasured} unmeasured, ${c.unverified} unverified${c.holdoutRegressed ? ', holdout REGRESSED' : ''}; ${c.ready ? 'ready' : 'not ready'}`);
        }
        return;
    }

    if (cmd === 'watch') {
        const extra = argv.slice(1).filter((a) => a !== '--json');
        if (extra.length > 0) {
            console.error(`[SKILL-EVOLUTION] watch: unexpected argument ${extra[0]} (usage: watch [--json])`);
            process.exit(2);
        }
        const result = watch({ projectDir: root });
        if (argv.includes('--json')) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        console.log(`[SKILL-EVOLUTION] ${result.watched.length} applied change(s) watched · ${result.emitted.length} revert candidate${result.emitted.length === 1 ? '' : 's'} queued → ${result.queue}`);
        for (const w of result.watched) {
            const detail = w.regressions.length > 0
                ? ` (${w.regressions.map((r) => `${r.metric} ${r.before} → ${r.after}`).join(', ')})`
                : (w.reason === undefined ? '' : ` (${w.reason})`);
            console.log(`- ${w.skill} ${w.commit === null ? 'no commit' : w.commit.slice(0, 12)}: ${w.status}${detail}`);
        }
        return;
    }

    if (cmd === 'apply' || cmd === 'bind' || cmd === 'record-commit') {
        // The raw argv, not the parsed args: the apply helper owns its flags and refuses an unknown one.
        process.exitCode = require('./_lib/skill-apply').runCli(argv, { root });
        return;
    }

    if (cmd === 'auto-check' || cmd === 'auto-apply-check' || cmd === 'record-stop') {
        // The raw argv again: the cycle gates own their flags and refuse an unknown one.
        process.exitCode = runAutoCli(argv, root);
        return;
    }

    console.error('Usage: node .claude/core/skill-evolution.js intake|check|status|apply|bind|watch|record-commit|auto-check|auto-apply-check|record-stop [...]');
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
        console.error(err instanceof InputError ? `[SKILL-EVOLUTION] ${err.message}` : err.message);
        process.exit(err instanceof InputError ? 2 : 1);
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
    resolveSkillsRoot,
    parseIssueRows,
    collectGateFailures,
    intake,
    renderIntakeMd,
    check,
    extractFailureTraces,
    DEFAULT_GRADUATION,
    DEFAULT_WATCH,
    InputError,
    readImprovementConfig,
    evaluateWatch,
    watch,
    statusReport,
    DEFAULT_CYCLE_BUDGET,
    readAutoApply,
    readCycleBudget,
    checkCycleBudget,
    deriveCyclePlan,
    decideAutoApply,
    recordStop,
    CYCLE_REPEAT,
    CYCLE_MIN_DEV_EVALS,
    CYCLE_MIN_HOLDOUT_EVALS,
    CYCLE_AGENT_MAX_USD,
    CYCLE_RUN_ESTIMATE,
    main,
};
