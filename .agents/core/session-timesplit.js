#!/usr/bin/env node

/**
 * session-timesplit.js — split a Claude Code session's time into buckets.
 *
 * WHY THIS EXISTS
 * ---------------
 * A long `/run-todo` run is judged by impression ("it felt slow", "too many
 * fix rounds"). This tool turns one session transcript into numbers: where the
 * main thread's wall clock went, how many subagent runs of each role ran and
 * for how long, how much of that was fixing versus building, and how often a
 * review actually found something serious.
 *
 * USAGE (CLI)
 *   node .claude/core/session-timesplit.js <transcript.jsonl | session-id>
 *        [--project-dir DIR] [--since TS] [--until TS] [--json]
 *
 *   A path (ends in .jsonl, or contains a path separator) is used as is. A
 *   bare session id is resolved to `<project-dir>/<id>.jsonl`, where
 *   project-dir is a `~/.claude/projects/<dir>` folder. Default: derived from
 *   the cwd (absolute path with every character that is not a letter or digit
 *   replaced by `-`, as Claude Code names the folder). A relative
 *   --project-dir that does not exist is tried under `~/.claude/projects/`.
 *   Subagents are read from `<session>/subagents/agent-*.jsonl`, with the role
 *   taken from the sibling `agent-*.meta.json` description.
 *
 *   --since / --until (TS: anything Date.parse accepts, ISO-8601 in practice)
 *   limit the analysis to events with since <= ts <= until (inclusive), in the
 *   main thread and in every subagent transcript; a subagent run with no event
 *   in the window is not counted. The report then carries `window`. Without
 *   either flag the output is unchanged.
 *
 * HOW TIME IS ATTRIBUTED
 *   Every gap between two consecutive main-thread events goes to exactly one
 *   bucket. A gap of "own work" is charged to the category of the LAST tool the
 *   previous assistant event called, so model latency after a tool result is
 *   billed to that tool, and parallel tool calls in one message bill to the last
 *   one listed. Read the "Own work by tool category" table with that in mind.
 *
 * READ-ONLY: this module never writes anything, anywhere.
 *
 * Exit codes: 0 ok (or --help), 1 transcript not found or unreadable, 2 bad usage.
 *
 * Zero runtime dependencies (node built-ins only).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── Tunables ────────────────────────────────────────────────────────────────

/** A human message after at least this long counts as "waiting on the owner". */
const OWNER_WAIT_MIN_SECONDS = 60;
/** A gap longer than this (not owner / notification) is "idle", not work. */
const IDLE_GAP_SECONDS = 1800;

const WAIT_OWNER = 'waitingOnOwner';
const WAIT_AGENTS = 'waitingOnAgents';
const IDLE = 'idle';
const DEFAULT_CATEGORY = 'thinking/writing reply';

/**
 * Paths and commands that are project bookkeeping rather than product work.
 * Case-sensitive and anchored on a path or word boundary, so product code such as
 * `src/dashboard/`, `Timeline.tsx` or `changelog-view.ts` is not bookkeeping.
 */
const BOOK = /(TODO_|\/todo\/|docs\/\.output\/plans|handoffs\/|(?:^|[\s/'"])Board\/|(?:^|[\s/'"])timeline\.md(?=$|[\s'"])|(?:^|[\s/'"])(?:CHANGELOG|changelog)(?:\.md)?(?=$|[\s'"])|\.commit-msg)/;
/** Prose and markup files; any other edited file is code. */
const DOC_FILE = /\.(?:md|mdx|txt|rst|adoc)$/i;

const ROLES = ['build', 'fix', 'review', 'security', 'tests', 'docs', 'research'];
const REVIEW_ROLES = new Set(['review', 'security']);
const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'NIT'];

/**
 * Security audits grade HIGH / MEDIUM / LOW (and id them H-1, M-2, L-3 or M1). For yield
 * they count as MAJOR / MINOR / NIT; CRITICAL is CRITICAL in both vocabularies.
 */
const SEVERITY_ALIAS = { HIGH: 'MAJOR', MEDIUM: 'MINOR', LOW: 'NIT' };
const ID_LETTER_SEVERITY = { H: 'MAJOR', M: 'MINOR', L: 'NIT', N: 'NIT' };
const ID_TOKEN = /^[HMLN]-?\d+$/;
/**
 * One labelled finding per line: "- MAJOR-1: ...", "**CRITICAL** ...", "3. NIT ...",
 * "- **M-1: ...**", "**M1. ...**", "8. **LOW: ...**". Case-sensitive on purpose.
 */
const SEVERITY_LINE = /^\s*(?:[-*]|\d+\.|#+)?\s*\**\[?(CRITICAL|MAJOR|MINOR|NIT|(?:HIGH|MEDIUM|LOW)(?![-\s]*(?:risk|tier)\b)|[HMLN]-?\d+)s?\b(.*)$/;
/**
 * A label whose WHOLE remainder says "none" / "0" ("none", "0 findings", "no issues found",
 * "nil (all closed)") is a summary line, not a finding. Anchored at both ends and word-bounded:
 * "No validation on the path", "nil pointer ...", "None returned ...", "0-length buffer ..." and
 * "zeroing the buffer ..." are real findings.
 */
const SEVERITY_NONE = /^\W*(?:(?:findings?|issues?)\W*)?[-:=(]?\s*(?:none|nil|zero|0|no)\b(?:\s+(?:findings?|issues?|problems?|found|open|remaining|blocking|new))*\W*(?:\([^)]*\))?\W*$/i;
/** What may follow a label on a heading-only line: markup, a colon, "findings", a "(3)" count or a short parenthetical. */
const BARE_LABEL_REMAINDER = /^[\s*:\]\-–—]*(?:(?:findings?|issues?)\b[^*\n]*)?(?:\([^)]*\))?[\s*:]*$/;
/** "two MAJOR", "7 MINOR", "a CRITICAL", "3 LOW": a number word or digits before a label. */
const PROSE_COUNT = /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(?:new\s+|real\s+|remaining\s+|blocking\s+)?(CRITICAL|MAJOR|MINOR|NIT|(?:HIGH|MEDIUM|LOW)(?![-\s]*(?:risk|tier|paths?|files?|surfaces?)\b))s?\b/gi;
const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
const NO_FINDINGS = /\b(?:no|zero|0)\s+(?:(?:blocking|remaining|material|new|open)\s+)?(?:findings|issues)\b/i;

/** The wrapper Claude Code puts around a SendMessage that reaches a subagent mid-run. */
const COORDINATOR_PREFIX = /^\s*The coordinator sent a message while you were working:\s*/;
/**
 * A later message that sends review findings back for fixing: "Round 2 for ...",
 * "fix these findings", "address the review", "security review findings to fold in".
 * A decision or answer ("Main Agent decision: Option 1. Proceed.") is not a fix round.
 */
const FIX_MESSAGE = new RegExp(
  [
    /^\s*round\s*\d+\b/,
    /^\s*fix\b/,
    /\bfix(?:es|ed)?\b[^.\n]{0,60}\b(?:findings?|review|issues?|comments?|problems?|bugs?)\b/,
    /\baddress(?:ing)?\b[^.\n]{0,40}\b(?:findings?|review|issues?|comments?)\b/,
    // Findings named alone are not an instruction: the verb has to come with them.
    /\b(?:fix|address|resolve|apply|handle|fold|incorporate|redo|rework)\w*\b[^.\n]{0,40}\b(?:review|reviewer|security|audit)s?\b[^.\n]{0,40}\bfindings?\b/,
    /\b(?:review|reviewer|security|audit)s?\b[^.\n]{0,40}\bfindings?\b[^.\n]{0,40}\bto\s+(?:fold|fix|address|resolve|apply|handle|incorporate)/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse JSONL text into the user/assistant events that carry a timestamp,
 * sorted by time (stable). Malformed lines are skipped.
 * @param {string} text
 * @returns {object[]}
 */
function parseEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"timestamp"') === -1) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || !e.timestamp || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const ms = Date.parse(e.timestamp);
    if (Number.isNaN(ms)) continue;
    out.push({ e, ms });
  }
  // Array.prototype.sort is stable in Node >= 11.
  out.sort((a, b) => a.ms - b.ms);
  return out.map(({ e, ms }) => {
    e.__ms = ms;
    return e;
  });
}

/**
 * Parsed, time-sorted events of one transcript file. With a `cache` Map (analyzeSession's `eventCache`),
 * a file is read and parsed once and every later window over it reuses the same event objects, which
 * the analysis only reads. A failed read is never cached.
 * @param {string} file
 * @param {Map<string, object[]>|null} [cache]
 * @returns {object[]}
 */
function loadEvents(file, cache = null) {
  if (cache instanceof Map && cache.has(file)) return cache.get(file);
  const events = parseEvents(fs.readFileSync(file, 'utf8'));
  if (cache instanceof Map) cache.set(file, events);
  return events;
}

/** Flatten a message's content to plain text (string content or text blocks). */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((x) => (x && typeof x === 'object' && typeof x.text === 'string' ? x.text : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * Classify a user event: 'human' (a real message from the owner), 'notify'
 * (a background-agent task-notification), or null (tool result, meta,
 * compaction summary, system-injected text, or not a user event).
 * @param {object} e
 * @returns {'human'|'notify'|null}
 */
function humanKind(e) {
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary) return null;
  const c = e.message && e.message.content;
  let t;
  if (typeof c === 'string') {
    t = c;
  } else if (Array.isArray(c)) {
    if (c.some((x) => x && typeof x === 'object' && x.type === 'tool_result')) return null;
    t = contentText(c);
  } else {
    return null;
  }
  if (t.includes('<task-notification>')) return 'notify';
  const head = t.trim();
  if (head.startsWith('<') && (head.slice(0, 200).includes('system-reminder') || head.slice(0, 200).includes('local-command'))) {
    return null;
  }
  return 'human';
}

// ── Tool categories ─────────────────────────────────────────────────────────

/**
 * Category of "own work" for a tool call.
 * @param {string} name tool name
 * @param {object} [input] tool input
 * @returns {string}
 */
function categorizeTool(name, input) {
  const inp = input || {};
  if (name === 'Agent' || name === 'Task' || name === 'SendMessage') return 'dispatch agents';
  // TaskOutput / TaskStop wait on or stop a background agent; they are not task-list bookkeeping.
  if (name === 'TaskOutput' || name === 'TaskStop') return 'waiting/agent ops';
  if (name.startsWith('Task') || name === 'TodoWrite') return 'bookkeeping';
  if (name === 'Bash') {
    const c = String(inp.command || '');
    if (/commit\.js|git (add|commit|push|status|log|diff)/.test(c)) return 'git/commit';
    if (/gate\.js|vitest|npm (run )?(test|typecheck|lint|build)|playwright|tsc\b|e2e/.test(c)) return 'verify (build/tests)';
    if (/supabase|wrangler|psql|curl/.test(c)) return 'infra/live checks';
    if (BOOK.test(c)) return 'bookkeeping';
    return 'shell (other)';
  }
  const p = String(inp.file_path || inp.path || '');
  if (BOOK.test(p)) return 'bookkeeping';
  if (/(\.test\.|\.spec\.|\/tests?\/|__tests__)/.test(p)) {
    return name === 'Edit' || name === 'Write' ? 'write tests' : 'read code/docs';
  }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    return DOC_FILE.test(p) ? 'write docs' : 'write code';
  }
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'read code/docs';
  if (name.startsWith('mcp__t3')) return 't3/thread ops';
  return 'other tools';
}

// ── Main thread ─────────────────────────────────────────────────────────────

/**
 * Split the main thread's wall clock into buckets.
 * @param {object[]} events sorted user/assistant events
 * @returns {{startedAt:string|null, endedAt:string|null, wallSeconds:number,
 *   buckets:{waitingOnOwner:number, waitingOnAgents:number, idle:number,
 *   ownWork:{total:number, byCategory:Object<string,number>}}}}
 */
function splitMainThread(events) {
  const buckets = { [WAIT_OWNER]: 0, [WAIT_AGENTS]: 0, [IDLE]: 0 };
  const own = {};
  let prev = null;
  let prevCat = DEFAULT_CATEGORY;

  for (const e of events) {
    if (prev) {
      const gap = (e.__ms - prev.__ms) / 1000;
      const h = humanKind(e);
      if (h === 'human' && gap > OWNER_WAIT_MIN_SECONDS) buckets[WAIT_OWNER] += gap;
      else if (h === 'notify') buckets[WAIT_AGENTS] += gap;
      else if (gap > IDLE_GAP_SECONDS) buckets[IDLE] += gap;
      else own[prevCat] = (own[prevCat] || 0) + gap;
    }
    if (e.type === 'assistant') {
      const cs = (e.message && e.message.content) || [];
      const tools = Array.isArray(cs) ? cs.filter((x) => x && typeof x === 'object' && x.type === 'tool_use') : [];
      prevCat = tools.length ? categorizeTool(String(tools[tools.length - 1].name || ''), tools[tools.length - 1].input) : DEFAULT_CATEGORY;
    }
    prev = e;
  }

  const ownTotal = Object.values(own).reduce((a, b) => a + b, 0);
  const first = events[0];
  const last = events[events.length - 1];
  return {
    startedAt: first ? first.timestamp : null,
    endedAt: last ? last.timestamp : null,
    wallSeconds: first ? (last.__ms - first.__ms) / 1000 : 0,
    buckets: {
      waitingOnOwner: buckets[WAIT_OWNER],
      waitingOnAgents: buckets[WAIT_AGENTS],
      idle: buckets[IDLE],
      ownWork: { total: ownTotal, byCategory: own },
    },
  };
}

// ── Subagent roles ──────────────────────────────────────────────────────────

/** A run that only writes or runs tests: "Tests: ST-5.2", "Add unit tests for e1rm", "QA checklist". */
const TEST_LEAD = /^(?:(?:add|write|create|run|extend|draft|update|expand|author|improve)\s+)?(?:(?:the|more|new|some|missing|unit|integration|e2e|regression|acceptance|smoke)\s+)*(?:tests?|specs?|qa)\b/;
/** "tests for ..." / "QA ..." mid-description counts only when nothing else is being built or combined with "+". */
const TEST_MENTION = /\b(?:tests? for|qa)\b/;
const BUILD_SIGNAL = /\+|\b(?:implement|impl|build|setup|set up|scaffold|migrat)/;

/** @param {string} t lower-cased description */
function isTestOnly(t) {
  return TEST_LEAD.test(t) || (TEST_MENTION.test(t) && !BUILD_SIGNAL.test(t));
}

/** A run that starts by making something: "Build review screen" is a build, not a review. */
const BUILD_LEAD = /^(?:implement|impl|build|add|create|develop|wire|port|refactor|migrate|scaffold|set\s?up|introduce|extend)\b/;

/**
 * The role a subagent's `agentType` (from its meta file) settles on its own, or null when
 * the type says nothing about the work (`general-purpose`, `architect`, ...).
 * @param {unknown} agentType
 * @returns {'review'|'security'|'tests'|'docs'|null}
 */
function roleFromAgentType(agentType) {
  const t = String(agentType || '').trim().toLowerCase().replace(/^.*:/, '');
  if (t === 'code-reviewer') return 'review';
  if (t === 'security-auditor') return 'security';
  if (t === 'qa-engineer') return 'tests';
  if (t === 'doc-writer') return 'docs';
  return null;
}

/**
 * Map a run description (or the head of a first prompt) to a role.
 * Order matters: fix intent ("fix the review findings", "Address review findings",
 * "Round 2 fixes", "Security fixes") is `fix`, not `review` or `security`; a run that
 * starts by building ("Build review screen", "Add security headers") is `build`.
 * `tests` means a test-only run: "TR-2.18 setup + guided test" is a build.
 * @param {string} text
 * @returns {'build'|'fix'|'review'|'security'|'tests'|'docs'|'research'}
 */
function roleFromText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^fix/.test(t) || (/\bfix/.test(t) && /(finding|review|security|audit)/.test(t))) return 'fix';
  if (/^(?:address|resolve)\b/.test(t) && /(finding|review|audit|issue|comment)/.test(t)) return 'fix';
  if (/^round\s*\d/.test(t) && /(fix|finding|review|address)/.test(t)) return 'fix';
  if (BUILD_LEAD.test(t) && !isTestOnly(t)) return 'build';
  if (/security|audit/.test(t)) return 'security';
  if (/review/.test(t)) return 'review';
  if (isTestOnly(t)) return 'tests';
  if (/\bdocs?\b|\bdocument|readme|changelog/.test(t)) return 'docs';
  if (/research|investigat/.test(t)) return 'research';
  return 'build';
}

/** Text of the first user message of a run, for the no-meta fallback. */
function firstPromptText(events) {
  const first = events.find((e) => e.type === 'user');
  return first ? contentText(first.message && first.message.content) : '';
}

/** Text of the last assistant message that carries any text. */
function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'assistant') continue;
    const t = contentText(e.message && e.message.content).trim();
    if (t) return t;
  }
  return '';
}

/**
 * Text of a later message that reached a subagent after its first prompt: a real
 * user message, or a SendMessage from the coordinator (an `isMeta` event wrapped in
 * "The coordinator sent a message while you were working:"). Tool results, skill
 * injections, system notifications and image stubs are not messages. Null if none.
 * @param {object} e
 * @returns {string|null}
 */
function continuationText(e) {
  if (e.type !== 'user' || e.isCompactSummary) return null;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((x) => x && typeof x === 'object' && x.type === 'tool_result')) return null;
  const t = contentText(c).trim();
  if (COORDINATOR_PREFIX.test(t)) return t.replace(COORDINATOR_PREFIX, '');
  return humanKind(e) === 'human' ? t : null;
}

/**
 * Indices of the events that start a fix round inside a run: a later message that
 * sends findings back to the same agent (SendMessage "Round 2", "fix these
 * findings"). The run's first prompt never counts.
 * @param {object[]} events sorted events of one subagent run
 * @returns {number[]}
 */
function fixRoundStarts(events) {
  const firstUser = events.findIndex((e) => e.type === 'user');
  const starts = [];
  for (let i = firstUser + 1; i < events.length && firstUser >= 0; i++) {
    const t = continuationText(events[i]);
    if (t !== null && FIX_MESSAGE.test(t)) starts.push(i);
  }
  return starts;
}

/** Sum of output tokens, one count per message id (streamed chunks repeat an id). */
function outputTokens(events) {
  const byId = new Map();
  let anon = 0;
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const u = e.message && e.message.usage;
    const n = u && Number(u.output_tokens);
    if (!n) continue;
    const id = e.message.id || `anon-${anon++}`;
    byId.set(id, Math.max(byId.get(id) || 0, n));
  }
  let sum = 0;
  for (const n of byId.values()) sum += n;
  return sum;
}

// ── Review yield ────────────────────────────────────────────────────────────

/**
 * Canonical severity for a label token: CRITICAL/MAJOR/MINOR/NIT as is,
 * HIGH/MEDIUM/LOW and H-1/M-2/L-3 ids mapped to MAJOR/MINOR/NIT.
 * @param {string} token
 * @returns {'CRITICAL'|'MAJOR'|'MINOR'|'NIT'}
 */
function canonicalSeverity(token) {
  const t = String(token).toUpperCase();
  if (SEVERITIES.includes(t)) return t;
  if (SEVERITY_ALIAS[t]) return SEVERITY_ALIAS[t];
  return ID_LETTER_SEVERITY[t[0]];
}

/** Cells of one markdown table row: "| a | b |" -> ['a', 'b']. */
function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** A cell without emphasis, code ticks or brackets: "**MAJOR**" -> "MAJOR". */
function plainCell(cell) {
  return String(cell || '').replace(/[*`[\]_]/g, '').trim();
}

/** The severity a table cell names ("**MAJOR**", "HIGH"), or null. Uppercase only, like every label. */
function cellSeverity(cell) {
  const m = /^(CRITICAL|MAJOR|MINOR|NIT|HIGH|MEDIUM|LOW)S?$/.exec(plainCell(cell));
  return m ? canonicalSeverity(m[1]) : null;
}

const TABLE_SEPARATOR_CELL = /^:?-+:?$/;
const TABLE_SEVERITY_HEADER = /^(?:severity|sev)$/i;
const TABLE_COUNT_HEADER = /^(?:count|counts|total|number|num|n|qty|findings?|issues?)$/i;
const TABLE_CLOSED_CELL = /^(?:closed|resolved|fixed|verified|done)$/i;

/** Add one table's findings to `out` (see countTableFindings). */
function tallyTable(rows, out) {
  const isSeparator = (r) => r.length > 0 && r.every((c) => TABLE_SEPARATOR_CELL.test(c));
  const header = rows.length > 1 && isSeparator(rows[1]) ? rows[0] : null;
  const data = rows.slice(header ? 2 : 0).filter((r) => !isSeparator(r));
  const headerSeverities = header ? header.map(cellSeverity) : [];
  const transposed = headerSeverities.some(Boolean);
  const sevCol = header ? header.findIndex((c) => TABLE_SEVERITY_HEADER.test(plainCell(c))) : -1;
  const countCol = header ? header.findIndex((c) => TABLE_COUNT_HEADER.test(plainCell(c))) : -1;
  const asInt = (cell) => (/^\d+$/.test(plainCell(cell)) ? Number(plainCell(cell)) : null);

  for (const row of data) {
    if (transposed) {
      // "| CRITICAL | MAJOR | MINOR |" over "| 0 | 2 | 5 |": the cell under each label is its count.
      headerSeverities.forEach((sev, i) => {
        const n = sev ? asInt(row[i]) : null;
        if (n !== null) out[sev] += n;
      });
      continue;
    }
    // A closure table ("| M1 | MAJOR | CLOSED |") lists findings that are already resolved.
    if (row.some((c) => TABLE_CLOSED_CELL.test(plainCell(c)))) continue;
    const col = sevCol >= 0 ? sevCol : row.findIndex((c) => cellSeverity(c));
    const sev = col >= 0 ? cellSeverity(row[col]) : null;
    if (!sev) continue;
    // "| Severity | Count |" rows carry a count; so does a headerless "| MAJOR | 2 |" row.
    let n = 1;
    if (countCol >= 0 && countCol !== col && asInt(row[countCol]) !== null) n = asInt(row[countCol]);
    else if (countCol < 0 && col === 0 && asInt(row[1]) !== null) n = asInt(row[1]);
    out[sev] += n;
  }
}

/**
 * Findings reported in markdown tables: one finding per row of a findings table
 * ("| 1 | MAJOR | a.js:3 | bad |", or any table whose header has a Severity column), or N
 * for a count table ("| MAJOR | 2 |", "| Severity | Count |", or label columns over a row of numbers).
 * @param {string} src
 * @returns {{CRITICAL:number, MAJOR:number, MINOR:number, NIT:number}}
 */
function countTableFindings(src) {
  const out = { CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  let rows = [];
  const flush = () => {
    if (rows.length) tallyTable(rows, out);
    rows = [];
  };
  for (const line of src.split('\n')) {
    if (line.trim().startsWith('|')) rows.push(tableCells(line));
    else flush();
  }
  flush();
  return out;
}

/**
 * Count labelled severity findings in a review's final message.
 *
 * Reviewers report in four shapes, and each count below is a lower bound of
 * the truth, so the per-label result is the MAX of the four (never a sum, so
 * nothing is counted twice):
 *   1. labelled lines: "- MAJOR-1: ...", "**CRITICAL** ...", "3. NIT ...", and the
 *      security grades "- **M-1: ...**" / "**LOW: ...**" (HIGH->MAJOR, MEDIUM->MINOR, LOW->NIT);
 *   2. a bare label heading ("**MAJOR**", "## MINOR (3)") followed by list
 *      items: one finding per top-level item (a heading with no items = 1);
 *   3. prose counts: "two MAJOR ones", "7 MINOR and 3 NIT". "no CRITICAL
 *      issues" matches nothing, so it is not counted. HIGH/MEDIUM/LOW before
 *      "risk", "tier", "path", "file" ("a HIGH-risk path") is a risk tier, not a grade;
 *   4. markdown tables: a findings table is one finding per row, a count table
 *      ("| MAJOR | 2 |") is N (see countTableFindings).
 * A label whose remainder is only "none" / "0" / "no findings" is a summary line,
 * and a finding that merely starts with "No ..." or "None ..." is still a finding.
 * @param {string} text
 * @returns {{CRITICAL:number, MAJOR:number, MINOR:number, NIT:number, noFindings:boolean}}
 */
function countSeverities(text) {
  const src = String(text || '');
  const lineCounts = { CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  let section = null; // an open bare-label heading collecting list items
  let headingLabel = null; // the last bare-label heading, until a different heading replaces it

  const closeSection = () => {
    // Labelled lines under the heading are already counted; plain bullets then are their sub-bullets.
    if (section) lineCounts[section.label] += section.labelled > 0 ? 0 : section.items || 1;
    section = null;
  };

  for (const line of src.split('\n')) {
    const m = SEVERITY_LINE.exec(line);
    if (m) {
      if (SEVERITY_NONE.test(m[2])) {
        closeSection();
        continue;
      }
      if (BARE_LABEL_REMAINDER.test(m[2])) {
        closeSection();
        section = { label: canonicalSeverity(m[1]), items: 0, labelled: 0 };
        headingLabel = section.label;
        continue;
      }
      // A labelled line of the open section's own label belongs to it; any other
      // label starts something new, so the open section ends here.
      // An id like "M1" is ambiguous (MAJOR or MEDIUM): under a "## MAJOR" heading it is that
      // heading's own item; with no label heading above it, it is the security grade (M = MEDIUM).
      const ctx = section ? section.label : headingLabel;
      const label = ID_TOKEN.test(m[1]) && ctx ? ctx : canonicalSeverity(m[1]);
      if (section && section.label === label) section.labelled++;
      else closeSection();
      lineCounts[label]++;
      continue;
    }
    // A heading that is not a severity label ("## Your focus areas") ends the label context.
    if (/^#+\s/.test(line) || /^\*\*[^*]+\*\*:?\s*$/.test(line)) headingLabel = null;
    if (!section) continue;
    if (/^(?:[-*]|\d+\.)\s+\S/.test(line)) section.items++;
    else if (/^#+\s/.test(line) || /^\*\*[^*]+\*\*:?\s*$/.test(line) || (line.trim() && !/^\s/.test(line))) closeSection();
  }
  closeSection();

  const tableCounts = countTableFindings(src);
  const counts = { CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 0, noFindings: false };
  for (const label of SEVERITIES) {
    let prose = 0;
    for (const pm of src.matchAll(PROSE_COUNT)) {
      // Labels are uppercase only: "three nits" and "a high-risk write" are prose, not grades.
      if (pm[2] !== pm[2].toUpperCase()) continue;
      if (canonicalSeverity(pm[2]) === label) prose += NUMBER_WORDS[pm[1].toLowerCase()] ?? Number(pm[1]);
    }
    counts[label] = Math.max(lineCounts[label], prose, tableCounts[label]);
  }
  counts.noFindings = NO_FINDINGS.test(src);
  return counts;
}

/**
 * @param {{CRITICAL:number, MAJOR:number, MINOR:number, NIT:number}} counts
 * @returns {'major+'|'minor-only'|'clean'}
 */
function classifyReview(counts) {
  if (counts.CRITICAL > 0 || counts.MAJOR > 0) return 'major+';
  if (counts.MINOR > 0 || counts.NIT > 0) return 'minor-only';
  return 'clean';
}

// ── Subagents ───────────────────────────────────────────────────────────────

/**
 * Analyze every `agent-*.jsonl` under a subagents directory. `runs` counts agent
 * transcripts; `fixRounds.rounds` counts fix runs plus the rounds sent back to an
 * existing agent (`fixRounds.sentBack`), whose time moves from the agent's own role to fix.
 * With a window (SF-3.7) only events inside it count, and a run with no event inside it is not a run.
 * @param {string} dir
 * @param {{sinceMs: number|null, untilMs: number|null, untilExclusive?: boolean}|null} [win]  window in epoch ms (inclusive unless `untilExclusive`)
 * @param {Map<string, object[]>|null} [cache]  parsed-events cache shared across windows
 */
function analyzeSubagents(dir, win = null, cache = null) {
  const roles = {};
  for (const r of ROLES) roles[r] = { runs: 0, seconds: 0, outputTokens: 0, models: {}, pickedModels: {} };
  const reviews = [];
  let total = 0;
  let agentRuns = 0;
  let sentBack = 0;

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  } catch {
    // no subagents directory: an empty split, not an error
  }

  for (const f of files) {
    const events = filterWindow(loadEvents(path.join(dir, f), cache), win);
    if (!events.length) continue;

    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
    } catch {
      // no usable meta: fall back to the first prompt
    }

    const description = meta && typeof meta.description === 'string' && meta.description.trim() ? meta.description : null;
    // The meta file's agentType is authoritative for reviewers, auditors, QA and doc writers;
    // everything else (general-purpose, architect, ...) is read from the description.
    const role =
      roleFromAgentType(meta && meta.agentType) ||
      (description ? roleFromText(description) : roleFromText(firstPromptText(events).slice(0, 200)));
    const last = events.length - 1;
    const seconds = (events[last].__ms - events[0].__ms) / 1000;
    agentRuns++;

    // Fix rounds sent back to this agent split its time: what ran before the first one
    // stays with the run's own role, each round counts as a fix run. A review's own
    // transcript is never split (its yield is read from the final message).
    const starts = REVIEW_ROLES.has(role) ? [] : fixRoundStarts(events);
    const bucket = roles[role];
    const addModel = (b) => {
      if (meta && meta.model) b.models[meta.model] = (b.models[meta.model] || 0) + 1;
      if (meta && meta.pickedEffortModel) b.pickedModels[meta.pickedEffortModel] = (b.pickedModels[meta.pickedEffortModel] || 0) + 1;
    };

    // The run's own part ends at the event before the first fix round (idle time while
    // the agent waited to be resumed is dropped, not charged to either side).
    const ownEnd = starts.length ? starts[0] - 1 : last;
    const ownSeconds = (events[ownEnd].__ms - events[0].__ms) / 1000;
    bucket.runs++;
    bucket.seconds += ownSeconds;
    bucket.outputTokens += outputTokens(events.slice(0, ownEnd + 1));
    total += ownSeconds;
    addModel(bucket);

    starts.forEach((startIdx, k) => {
      const endIdx = k + 1 < starts.length ? starts[k + 1] - 1 : last;
      const roundSeconds = (events[endIdx].__ms - events[startIdx].__ms) / 1000;
      const fixBucket = roles.fix;
      fixBucket.runs++;
      fixBucket.seconds += roundSeconds;
      fixBucket.outputTokens += outputTokens(events.slice(startIdx, endIdx + 1));
      total += roundSeconds;
      addModel(fixBucket);
      sentBack++;
    });

    if (REVIEW_ROLES.has(role)) {
      const counts = countSeverities(lastAssistantText(events));
      reviews.push({ file: f, role, description: description || null, seconds, counts, class: classifyReview(counts) });
    }
  }

  const byRole = {};
  for (const r of ROLES) {
    const b = roles[r];
    byRole[r] = {
      runs: b.runs,
      seconds: b.seconds,
      hours: round(b.seconds / 3600, 3),
      share: total > 0 ? round(b.seconds / total, 4) : 0,
      outputTokens: b.outputTokens,
      models: b.models,
      pickedModels: b.pickedModels,
    };
  }

  const severities = { CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  const yieldTotals = { reviewCount: reviews.length, 'major+': 0, 'minor-only': 0, clean: 0, explicitNoFindings: 0 };
  for (const r of reviews) {
    for (const s of SEVERITIES) severities[s] += r.counts[s];
    yieldTotals[r.class]++;
    if (r.counts.noFindings) yieldTotals.explicitNoFindings++;
  }

  return {
    runs: agentRuns,
    totalSeconds: total,
    totalHours: round(total / 3600, 3),
    byRole,
    reviewYield: { ...yieldTotals, severities, reviews },
    fixRounds: { rounds: byRole.fix.runs, sentBack, seconds: byRole.fix.seconds, hours: byRole.fix.hours },
  };
}

// ── Session ─────────────────────────────────────────────────────────────────

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Epoch ms of one window bound: null when not given (undefined, null or ''), a number when Date.parse
 * accepts it; anything else throws, so a bad bound is never silently an open window.
 * @param {string|Date|number|null|undefined} value
 * @param {string} name  'since' or 'until' (error text)
 * @returns {number|null}
 */
function windowBound(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`invalid ${name}: ${String(value)}`);
  return ms;
}

/**
 * Events with since <= ts <= until (both ends inclusive), or since <= ts < until when the window is
 * `untilExclusive`; the same array when there is no window.
 */
function filterWindow(events, win) {
  if (!win) return events;
  const beforeEnd = (ms) => win.untilMs === null || (win.untilExclusive ? ms < win.untilMs : ms <= win.untilMs);
  return events.filter((e) => (win.sinceMs === null || e.__ms >= win.sinceMs) && beforeEnd(e.__ms));
}

/**
 * Analyze one session transcript plus its subagents.
 * @param {string} transcript path to `<session>.jsonl`
 * @param {{since?: string, until?: string, untilExclusive?: boolean, eventCache?: Map}} [opts]  SF-3.7 window,
 *   inclusive, Date.parse-able; either or both. Without one the report is exactly as before (no `window` key).
 *   With one the report gains `window: {since, until}` (ISO-8601, or null for the bound not given).
 *   `untilExclusive: true` makes the window half-open (since <= ts < until) so adjacent windows that share a
 *   boundary count a boundary event once; the reported `window` is unchanged. `eventCache` (a Map the caller
 *   owns) makes repeated calls over the same transcript parse each file once.
 */
function analyzeSession(transcript, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const sinceMs = windowBound(o.since, 'since');
  const untilMs = windowBound(o.until, 'until');
  const win = sinceMs !== null || untilMs !== null ? { sinceMs, untilMs, untilExclusive: o.untilExclusive === true } : null;
  const cache = o.eventCache instanceof Map ? o.eventCache : null;
  const events = filterWindow(loadEvents(transcript, cache), win);
  const main = splitMainThread(events);
  const subagents = analyzeSubagents(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents'), win, cache);
  const report = {
    transcript,
    wallSeconds: main.wallSeconds,
    wallHours: round(main.wallSeconds / 3600, 3),
    main,
    subagents,
  };
  if (win) {
    report.window = {
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null ? null : new Date(untilMs).toISOString(),
    };
  }
  return report;
}

// ── Transcript resolution ───────────────────────────────────────────────────

/**
 * The `~/.claude/projects/<dir>` folder name for a working directory: the absolute path with
 * every character that is not a letter or digit replaced by `-` (so `/`, `.`, `_`, spaces, and
 * the `\` and `:` of a Windows path all become `-`). A Windows absolute path is taken as is,
 * since `path.resolve` on another platform would treat it as relative.
 * @param {string} cwd
 */
function deriveProjectDirName(cwd) {
  const abs = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? cwd : path.resolve(cwd);
  return abs.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve a transcript argument (a path or a session id) to a file.
 * @param {string} arg
 * @param {{projectDir?: string, cwd?: string, home?: string}} [opts]
 * @returns {string}
 */
function resolveTranscript(arg, opts = {}) {
  if (/\.jsonl$/.test(arg) || /[\\/]/.test(arg)) return path.resolve(arg);
  const home = opts.home || os.homedir();
  const projects = path.join(home, '.claude', 'projects');
  let dir;
  if (opts.projectDir) {
    dir = path.resolve(opts.projectDir);
    if (!fs.existsSync(dir) && !path.isAbsolute(opts.projectDir)) dir = path.join(projects, opts.projectDir);
  } else {
    dir = path.join(projects, deriveProjectDirName(opts.cwd || process.cwd()));
  }
  return path.join(dir, `${arg}.jsonl`);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function hours(seconds) {
  return (seconds / 3600).toFixed(2);
}

function pct(part, whole) {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '-';
}

function modelList(models) {
  const keys = Object.keys(models);
  return keys.length ? keys.map((k) => `${k} x${models[k]}`).join(', ') : '-';
}

/**
 * @param {ReturnType<typeof analyzeSession>} report
 * @returns {string} markdown
 */
function renderMarkdown(report) {
  const { main, subagents: sa } = report;
  const wall = main.wallSeconds;
  const b = main.buckets;
  const lines = [];
  lines.push('# Session time split', '');
  lines.push(`Transcript: \`${report.transcript}\``);
  lines.push(`Span: ${main.startedAt || '-'} -> ${main.endedAt || '-'} = **${hours(wall)} h wall clock**`);
  if (report.window) lines.push(`Window: ${report.window.since || '-'} -> ${report.window.until || '-'}`);
  lines.push('');

  lines.push('## Main thread (wall clock)', '');
  lines.push('| Bucket | Hours | Share |', '|---|---:|---:|');
  const rows = [
    ['Waiting on owner', b.waitingOnOwner],
    ['Waiting on background agents', b.waitingOnAgents],
    ['Idle gaps > 30 min', b.idle],
    ['Own work', b.ownWork.total],
  ];
  for (const [name, s] of rows) lines.push(`| ${name} | ${hours(s)} | ${pct(s, wall)} |`);
  lines.push('', '### Own work by tool category', '');
  lines.push('| Category | Hours | Share of wall |', '|---|---:|---:|');
  const cats = Object.entries(b.ownWork.byCategory).sort((x, y) => y[1] - x[1]);
  for (const [name, s] of cats) lines.push(`| ${name} | ${hours(s)} | ${pct(s, wall)} |`);
  if (!cats.length) lines.push('| - | 0.00 | - |');

  lines.push('', `## Subagents (${sa.runs} runs, ${hours(sa.totalSeconds)} agent-hours, run in parallel)`, '');
  lines.push('| Role | Runs | Agent-hours | Share | Output tokens | Model |', '|---|---:|---:|---:|---:|---|');
  for (const r of ROLES) {
    const x = sa.byRole[r];
    if (!x.runs) continue;
    lines.push(`| ${r} | ${x.runs} | ${hours(x.seconds)} | ${pct(x.seconds, sa.totalSeconds)} | ${x.outputTokens.toLocaleString('en-US')} | ${modelList(x.models)} |`);
  }
  if (!sa.runs) lines.push('| - | 0 | 0.00 | - | 0 | - |');

  lines.push('', '## Fix rounds', '');
  const sentBackNote = sa.fixRounds.sentBack ? `; ${sa.fixRounds.sentBack} sent back to an existing agent (SendMessage)` : '';
  lines.push(`- Fix runs: **${sa.fixRounds.rounds}**, ${hours(sa.fixRounds.seconds)} agent-hours (${pct(sa.fixRounds.seconds, sa.totalSeconds)} of subagent time)${sentBackNote}`);

  const y = sa.reviewYield;
  lines.push('', '## Review yield (review + security runs, final message)', '');
  lines.push(`- Reviews: **${y.reviewCount}**; major+ (any CRITICAL/MAJOR): **${y['major+']}**; minor-only: **${y['minor-only']}**; clean: **${y.clean}** (${y.explicitNoFindings} stated "no findings")`);
  lines.push(`- Labelled findings: CRITICAL ${y.severities.CRITICAL}, MAJOR ${y.severities.MAJOR}, MINOR ${y.severities.MINOR}, NIT ${y.severities.NIT}`);
  return lines.join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: session-timesplit.js <transcript.jsonl | session-id> [--project-dir DIR] [--since TS] [--until TS] [--json] [-h | --help]';

/**
 * @param {string[]} argv
 * @returns {{target?:string, projectDir?:string, since?:string, until?:string, json:boolean, help?:boolean, error?:string}}
 */
function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { json: false, help: true };
    if (a === '--json') out.json = true;
    else if (a === '--project-dir' || a === '--since' || a === '--until') {
      // A value that looks like an option ("--json") means the value was left out.
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { json: false, error: `${a} needs a value` };
      out[a === '--project-dir' ? 'projectDir' : a.slice(2)] = argv[++i];
    } else if (a.startsWith('--project-dir=') || a.startsWith('--since=') || a.startsWith('--until=')) {
      const flag = a.slice(0, a.indexOf('='));
      const value = a.slice(flag.length + 1);
      if (!value) return { json: false, error: `${flag} needs a value` };
      out[flag === '--project-dir' ? 'projectDir' : flag.slice(2)] = value;
    } else if (a.startsWith('-') && a !== '-') return { json: false, error: `unknown option ${a}` };
    else if (out.target === undefined) out.target = a;
    else return { json: false, error: `unexpected argument ${a}` };
  }
  if (out.target === undefined) return { json: false, error: 'missing transcript or session id' };
  for (const name of ['since', 'until']) {
    if (out[name] !== undefined && Number.isNaN(Date.parse(out[name]))) return { json: false, error: `invalid --${name}: ${out[name]}` };
  }
  if (out.since !== undefined && out.until !== undefined && Date.parse(out.since) > Date.parse(out.until)) {
    return { json: false, error: '--since is after --until' };
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    return 2;
  }
  const transcript = resolveTranscript(args.target, { projectDir: args.projectDir });
  if (!fs.existsSync(transcript)) {
    process.stderr.write(`transcript not found: ${transcript}\n`);
    return 1;
  }
  let report;
  try {
    report = analyzeSession(transcript, { since: args.since, until: args.until });
  } catch (err) {
    process.stderr.write(`cannot read transcript ${transcript}: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
  return 0;
}

module.exports = {
  OWNER_WAIT_MIN_SECONDS,
  IDLE_GAP_SECONDS,
  parseEvents,
  humanKind,
  categorizeTool,
  splitMainThread,
  roleFromText,
  roleFromAgentType,
  continuationText,
  fixRoundStarts,
  canonicalSeverity,
  countSeverities,
  countTableFindings,
  classifyReview,
  analyzeSubagents,
  analyzeSession,
  deriveProjectDirName,
  resolveTranscript,
  renderMarkdown,
  parseArgs,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
