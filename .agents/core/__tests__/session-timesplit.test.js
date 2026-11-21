import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ts = require('../../../.agents/core/session-timesplit');
const { createTmpDir } = require('./_helpers/tmp-dir.js');

const SCRIPT = path.resolve(__dirname, '../session-timesplit.js');
const SESSION_ID = 'sess-0001';

// ── Synthetic transcript builders ───────────────────────────────────────────

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (sec) => new Date(BASE + sec * 1000).toISOString();

const human = (sec, text) => ({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } });
const toolResult = (sec) => ({
  type: 'user',
  timestamp: at(sec),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});
const assistantTool = (sec, name, input, extra = {}) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }], ...extra },
});
const assistantText = (sec, text, extra = {}) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: { role: 'assistant', content: [{ type: 'text', text }], ...extra },
});

const jsonl = (events, extraLines = []) => [...events.map((e) => JSON.stringify(e)), ...extraLines].join('\n') + '\n';

/**
 * Main thread, offsets in seconds:
 *   0    human (first event)
 *   10   assistant Bash vitest       gap 10  -> own "thinking/writing reply"
 *   40   tool_result                 gap 30  -> own "verify (build/tests)"
 *   50   assistant Agent dispatch    gap 10  -> own "verify (build/tests)"
 *   250  task-notification           gap 200 -> waiting on background agents
 *   260  assistant text              gap 10  -> own "dispatch agents"
 *   360  human                       gap 100 -> waiting on owner
 *   370  assistant text              gap 10  -> own "thinking/writing reply"
 *   2370 assistant Edit src/a.ts     gap 2000 -> idle
 *   2400 human                       gap 30  -> own "write code" (a human reply within 60 s is not a wait)
 *   2500 system-reminder user        gap 100 -> own "write code" (injected text is not a human message)
 */
function mainEvents() {
  return [
    human(0, 'start the run'),
    assistantTool(10, 'Bash', { command: 'npx vitest run' }),
    toolResult(40),
    assistantTool(50, 'Agent', { description: 'x' }),
    human(250, '<task-notification>\n<task-id>a1</task-id>\n</task-notification>'),
    assistantText(260, 'dispatched'),
    human(360, 'looks fine, continue'),
    assistantText(370, 'continuing'),
    assistantTool(2370, 'Edit', { file_path: '/repo/src/a.ts' }),
    human(2400, 'quick follow-up'),
    human(2500, '<system-reminder>injected</system-reminder>'),
  ];
}

/** A subagent run: first event at t=0, last at `duration`, with output-token usage on its assistant events. */
function subagentEvents({ prompt, duration, lastText, tokens }) {
  return [
    human(0, prompt),
    assistantText(duration / 2, 'working', { id: 'm1', usage: { output_tokens: Math.floor(tokens / 4) } }),
    // Same message id streamed twice: the larger count wins, it is not summed.
    assistantText(duration / 2 + 1, 'working', { id: 'm1', usage: { output_tokens: tokens / 2 } }),
    assistantText(duration, lastText, { id: 'm2', usage: { output_tokens: tokens / 2 } }),
  ];
}

const REVIEW_MAJOR = ['Review done.', '- MAJOR-1: buffer overflow in parse()', '- MINOR-1: naming', '- NIT-1: typo'].join('\n');
const REVIEW_MINOR = ['- MINOR-1: dead branch', '- NIT-1: spacing'].join('\n');
const SECURITY_CLEAN = 'Audit complete. No findings; no CRITICAL issues.';

let tmp;
let transcript;
let projectDir;

function addSubagent(id, events, meta) {
  const dir = path.join('proj', SESSION_ID, 'subagents');
  tmp.write(path.join(dir, `agent-${id}.jsonl`), jsonl(events));
  if (meta) tmp.write(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'timesplit-test-' });
  projectDir = path.join(tmp.root, 'proj');
  // Noise a real transcript has: a blank line, malformed JSON, and a non user/assistant entry.
  transcript = tmp.write(
    path.join('proj', `${SESSION_ID}.jsonl`),
    jsonl(mainEvents(), ['', '{not json', JSON.stringify({ type: 'attachment', timestamp: at(99999) })]),
  );

  addSubagent(
    'r1',
    // The first assistant message carries a CRITICAL line; only the LAST message is read.
    [...subagentEvents({ prompt: 'p', duration: 600, lastText: REVIEW_MAJOR, tokens: 400 })].map((e, i) =>
      i === 1 ? assistantText(300, '- CRITICAL-9: stale, from an earlier message', { id: 'm1', usage: { output_tokens: 100 } }) : e,
    ),
    { agentType: 'code-reviewer', description: 'Review W1 wave', model: 'sonnet', pickedEffortModel: 'claude-opus-5-5', finished: true },
  );
  addSubagent('r2', subagentEvents({ prompt: 'p', duration: 120, lastText: REVIEW_MINOR, tokens: 80 }), {
    description: 'Code review: TR-9',
    model: 'sonnet',
  });
  addSubagent('f1', subagentEvents({ prompt: 'p', duration: 1200, lastText: 'All fixed.', tokens: 800 }), {
    description: 'Fix W1 findings',
    model: 'sonnet',
    pickedEffortModel: 'claude-opus-5-5',
  });
  addSubagent('b1', subagentEvents({ prompt: 'p', duration: 1800, lastText: 'Built.', tokens: 2000 }), {
    description: 'Implement TR-9 widget',
    model: 'opus',
  });
  addSubagent('s1', subagentEvents({ prompt: 'p', duration: 300, lastText: SECURITY_CLEAN, tokens: 200 }), {
    description: 'Security audit TR-9',
  });
  // No meta file: the role comes from the first prompt.
  addSubagent('n1', subagentEvents({ prompt: 'Investigate why the cache misses', duration: 60, lastText: 'Found it.', tokens: 40 }), null);
});

afterEach(() => {
  tmp.cleanup();
});

// ── Main thread ─────────────────────────────────────────────────────────────

describe('splitMainThread', () => {
  it('splitsWallClockIntoOwnerAgentsIdleAndOwnWorkBuckets', () => {
    const main = ts.analyzeSession(transcript).main;
    expect(main.startedAt).toBe(at(0));
    expect(main.endedAt).toBe(at(2500));
    expect(main.wallSeconds).toBe(2500);
    expect(main.buckets.waitingOnOwner).toBe(100);
    expect(main.buckets.waitingOnAgents).toBe(200);
    expect(main.buckets.idle).toBe(2000);
    expect(main.buckets.ownWork.total).toBe(200);
  });

  it('attributesOwnWorkToTheCategoryOfTheLastToolUsed', () => {
    const cats = ts.analyzeSession(transcript).main.buckets.ownWork.byCategory;
    expect(cats).toEqual({
      'thinking/writing reply': 20,
      'verify (build/tests)': 40,
      'dispatch agents': 10,
      'write code': 130,
    });
  });

  it('bucketsSumToTheWallClockSpan', () => {
    const { wallSeconds, buckets: b } = ts.analyzeSession(transcript).main;
    expect(b.waitingOnOwner + b.waitingOnAgents + b.idle + b.ownWork.total).toBe(wallSeconds);
  });

  it('treatsAHumanReplyWithinSixtySecondsAsOwnWorkNotWaiting', () => {
    const events = ts.parseEvents(jsonl([assistantText(0, 'hi'), human(60, 'quick')]));
    const main = ts.splitMainThread(events);
    expect(main.buckets.waitingOnOwner).toBe(0);
    expect(main.buckets.ownWork.total).toBe(60);
    const slow = ts.splitMainThread(ts.parseEvents(jsonl([assistantText(0, 'hi'), human(61, 'slow')])));
    expect(slow.buckets.waitingOnOwner).toBe(61);
  });

  it('countsATaskNotificationAsWaitingOnAgentsEvenAfterALongGap', () => {
    const events = ts.parseEvents(jsonl([assistantText(0, 'dispatch'), human(4000, '<task-notification>x</task-notification>')]));
    const main = ts.splitMainThread(events);
    expect(main.buckets.waitingOnAgents).toBe(4000);
    expect(main.buckets.idle).toBe(0);
  });

  it('returnsAllZeroForAnEmptyTranscript', () => {
    const main = ts.splitMainThread([]);
    expect(main.wallSeconds).toBe(0);
    expect(main.startedAt).toBe(null);
    expect(main.buckets.ownWork.total).toBe(0);
  });

  it('humanKindIgnoresToolResultsMetaAndSystemText', () => {
    expect(ts.humanKind(human(0, 'hello'))).toBe('human');
    expect(ts.humanKind(human(0, '<task-notification>x</task-notification>'))).toBe('notify');
    expect(ts.humanKind(toolResult(0))).toBe(null);
    expect(ts.humanKind({ ...human(0, 'x'), isMeta: true })).toBe(null);
    expect(ts.humanKind({ ...human(0, 'x'), isCompactSummary: true })).toBe(null);
    expect(ts.humanKind(human(0, '<system-reminder>x</system-reminder>'))).toBe(null);
    expect(ts.humanKind(human(0, '<local-command-stdout>x</local-command-stdout>'))).toBe(null);
    expect(ts.humanKind(assistantText(0, 'x'))).toBe(null);
  });
});

describe('categorizeTool', () => {
  it('mapsToolsToCategories', () => {
    expect(ts.categorizeTool('Agent', {})).toBe('dispatch agents');
    expect(ts.categorizeTool('SendMessage', {})).toBe('dispatch agents');
    expect(ts.categorizeTool('TaskUpdate', {})).toBe('bookkeeping');
    expect(ts.categorizeTool('Bash', { command: 'node .claude/core/commit.js' })).toBe('git/commit');
    expect(ts.categorizeTool('Bash', { command: 'npx vitest run' })).toBe('verify (build/tests)');
    expect(ts.categorizeTool('Bash', { command: 'curl https://x' })).toBe('infra/live checks');
    expect(ts.categorizeTool('Bash', { command: 'cat docs/.output/plans/p.md' })).toBe('bookkeeping');
    expect(ts.categorizeTool('Bash', { command: 'ls' })).toBe('shell (other)');
    expect(ts.categorizeTool('Edit', { file_path: '/r/src/a.ts' })).toBe('write code');
    expect(ts.categorizeTool('Edit', { file_path: '/r/notes.md' })).toBe('write docs');
    expect(ts.categorizeTool('Write', { file_path: '/r/src/__tests__/a.test.ts' })).toBe('write tests');
    expect(ts.categorizeTool('Read', { file_path: '/r/src/__tests__/a.test.ts' })).toBe('read code/docs');
    expect(ts.categorizeTool('Edit', { file_path: '/r/docs/TODO_x.md' })).toBe('bookkeeping');
    expect(ts.categorizeTool('Grep', {})).toBe('read code/docs');
    expect(ts.categorizeTool('mcp__t3__thread_send', {})).toBe('t3/thread ops');
    expect(ts.categorizeTool('WebFetch', {})).toBe('other tools');
  });
});

// ── Subagent roles ──────────────────────────────────────────────────────────

describe('roleFromText', () => {
  it.each([
    ['Fix TR-2.26 findings', 'fix'],
    ['Fix the broken build', 'fix'],
    ['Apply fixes from the review', 'fix'],
    ['Fix W1.4 review findings', 'fix'],
    ['Security audit TR-2.9', 'security'],
    ['Audit the RLS policies', 'security'],
    ['Review W1.6 Sheet extras', 'review'],
    ['Code review: TR-2.2 helper', 'review'],
    ['Write the QA checklist', 'tests'],
    ['Add unit tests for e1rm', 'tests'],
    ['Update the README', 'docs'],
    ['Draft the CHANGELOG entry', 'docs'],
    ['Write docs for the API', 'docs'],
    ['Research caching options', 'research'],
    ['Investigate the flaky sync', 'research'],
    ['Implement TR-9 widget', 'build'],
    ['TR-2.7 session-screen mock', 'build'],
    ['', 'build'],
    // Tests means a test-only run; a build that mentions a test is still a build.
    ['TR-2.18 setup + guided test', 'build'],
    ['TR-2.1 round 1: baseline + tests', 'build'],
    ['Implement the parser with tests for it', 'build'],
    ['Tests: ST-5.2 sweep + ST-5.3 canary', 'tests'],
    ['Write tests for the board checker', 'tests'],
    ['Tests for the vault linter', 'tests'],
    ['QA the Sheet flow', 'tests'],
  ])('mapsDescription_%s_to_%s', (description, role) => {
    expect(ts.roleFromText(description)).toBe(role);
  });

  it('isCaseInsensitive', () => {
    expect(ts.roleFromText('SECURITY AUDIT')).toBe('security');
    expect(ts.roleFromText('fix the REVIEW findings')).toBe('fix');
  });
});

describe('analyzeSubagents', () => {
  const sub = () => ts.analyzeSession(transcript).subagents;

  it('countsRunsAndAgentSecondsPerRole', () => {
    const s = sub();
    expect(s.runs).toBe(6);
    expect(s.totalSeconds).toBe(4080);
    expect(s.byRole.build.runs).toBe(1);
    expect(s.byRole.build.seconds).toBe(1800);
    expect(s.byRole.fix.runs).toBe(1);
    expect(s.byRole.fix.seconds).toBe(1200);
    expect(s.byRole.review.runs).toBe(2);
    expect(s.byRole.review.seconds).toBe(720);
    expect(s.byRole.security.runs).toBe(1);
    expect(s.byRole.security.seconds).toBe(300);
    expect(s.byRole.research.runs).toBe(1);
    expect(s.byRole.research.seconds).toBe(60);
    expect(s.byRole.tests.runs).toBe(0);
    expect(s.byRole.docs.runs).toBe(0);
  });

  it('reportsHoursAndShareOfSubagentTime', () => {
    const s = sub();
    expect(s.totalHours).toBe(1.133);
    expect(s.byRole.fix.hours).toBe(0.333);
    expect(s.byRole.fix.share).toBe(0.2941);
    expect(s.byRole.build.share).toBe(0.4412);
  });

  it('sumsOutputTokensOncePerMessageId', () => {
    const s = sub();
    // f1: ids m1 (max of 200 and 400 = 400) + m2 (400) = 800.
    expect(s.byRole.fix.outputTokens).toBe(800);
    expect(s.byRole.build.outputTokens).toBe(2000);
    // r1: m1 (max of 100 and 200 = 200) + m2 (200) = 400; r2: 20/40 -> m1 40 + m2 40 = 80.
    expect(s.byRole.review.outputTokens).toBe(480);
  });

  it('reportsTheModelPerRoleFromTheMetaFile', () => {
    const s = sub();
    expect(s.byRole.review.models).toEqual({ sonnet: 2 });
    expect(s.byRole.review.pickedModels).toEqual({ 'claude-opus-5-5': 1 });
    expect(s.byRole.fix.models).toEqual({ sonnet: 1 });
    expect(s.byRole.build.models).toEqual({ opus: 1 });
    expect(s.byRole.security.models).toEqual({});
  });

  it('fallsBackToTheFirstPromptWhenThereIsNoMetaFile', () => {
    expect(sub().byRole.research.runs).toBe(1);
  });

  it('returnsAnEmptySplitWhenThereIsNoSubagentsDirectory', () => {
    const lone = tmp.write('lone/solo.jsonl', jsonl([human(0, 'a'), assistantText(10, 'b')]));
    const s = ts.analyzeSession(lone).subagents;
    expect(s.runs).toBe(0);
    expect(s.totalSeconds).toBe(0);
    expect(s.byRole.fix.share).toBe(0);
  });
});

// ── Review yield and fix rounds ─────────────────────────────────────────────

describe('review yield', () => {
  const yieldOf = () => ts.analyzeSession(transcript).subagents.reviewYield;

  it('classifiesEachReviewAndSecurityRun', () => {
    const y = yieldOf();
    expect(y.reviewCount).toBe(3);
    expect(y['major+']).toBe(1);
    expect(y['minor-only']).toBe(1);
    expect(y.clean).toBe(1);
    expect(y.explicitNoFindings).toBe(1);
    const byDesc = Object.fromEntries(y.reviews.map((r) => [r.description, r.class]));
    expect(byDesc).toEqual({
      'Review W1 wave': 'major+',
      'Code review: TR-9': 'minor-only',
      'Security audit TR-9': 'clean',
    });
  });

  it('totalsSeveritiesFromTheLastAssistantMessageOnly', () => {
    const y = yieldOf();
    // r1's earlier "CRITICAL-9" line is in a non-final message and must not count.
    expect(y.severities).toEqual({ CRITICAL: 0, MAJOR: 1, MINOR: 2, NIT: 2 });
  });

  it('doesNotCountFixOrBuildRunsAsReviews', () => {
    expect(yieldOf().reviews.map((r) => r.role).sort()).toEqual(['review', 'review', 'security']);
  });
});

describe('fix rounds', () => {
  it('countsFixRunsAndTheirAgentHours', () => {
    const f = ts.analyzeSession(transcript).subagents.fixRounds;
    expect(f.rounds).toBe(1);
    expect(f.seconds).toBe(1200);
    expect(f.hours).toBe(0.333);
  });
});

describe('fix rounds sent back to an existing agent', () => {
  const coordinator = (sec, text) => ({
    type: 'user',
    timestamp: at(sec),
    isMeta: true,
    message: { role: 'user', content: `The coordinator sent a message while you were working:\n${text}` },
  });
  const systemNotice = (sec) => ({
    type: 'user',
    timestamp: at(sec),
    isMeta: true,
    message: { role: 'user', content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.' },
  });
  const turn = (sec, id, tokens, text = 'working') => assistantText(sec, text, { id, usage: { output_tokens: tokens } });

  /** A second session in its own folder so the shared six-agent fixture stays untouched. */
  function sessionWith(agents) {
    const t = tmp.write('proj2/sess-2.jsonl', jsonl([human(0, 'go')]));
    for (const [id, events, meta] of agents) {
      tmp.write(path.join('proj2', 'sess-2', 'subagents', `agent-${id}.jsonl`), jsonl(events));
      tmp.write(path.join('proj2', 'sess-2', 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta));
    }
    return ts.analyzeSession(t).subagents;
  }

  /**
   * A build run whose own work ends at t=300, then two rounds are sent back:
   *   0 prompt | 100 m1 (100 tok) | 200 decision (not a fix) | 250 notice | 300 m2 (200 tok)
   *   340 coordinator "Round 2" | 500 m3 (300 tok)           -> fix round 1: 160 s
   *   600 plain user "Address the review findings" | 900 m4 (400 tok) -> fix round 2: 300 s
   */
  const buildThenTwoFixRounds = () => [
    human(0, 'Implement ST-2.3'),
    turn(100, 'm1', 100),
    coordinator(200, 'Main Agent decision: Option 1. Proceed. SECURITY DEFINER function as planned.'),
    systemNotice(250),
    turn(300, 'm2', 200),
    coordinator(340, 'Round 2 for board_check.py. Security and code review found issues; fix all.'),
    turn(500, 'm3', 300),
    human(600, 'Address the review findings above.'),
    turn(900, 'm4', 400),
  ];

  it('countsEachLaterFixMessageAsAFixRoundAndSplitsItsTimeFromTheBuild', () => {
    const s = sessionWith([['b2', buildThenTwoFixRounds(), { description: 'ST-2.3 board checker impl', model: 'sonnet' }]]);
    expect(s.runs).toBe(1);
    expect(s.byRole.build.runs).toBe(1);
    expect(s.byRole.build.seconds).toBe(300);
    expect(s.byRole.build.outputTokens).toBe(300);
    expect(s.byRole.fix.runs).toBe(2);
    expect(s.byRole.fix.seconds).toBe(460);
    expect(s.byRole.fix.outputTokens).toBe(700);
    expect(s.byRole.fix.models).toEqual({ sonnet: 2 });
    expect(s.fixRounds).toEqual({ rounds: 2, sentBack: 2, seconds: 460, hours: 0.128 });
  });

  it('dropsTheIdleGapBeforeAResumedRoundInsteadOfChargingItToEitherSide', () => {
    const s = sessionWith([['b2', buildThenTwoFixRounds(), { description: 'ST-2.3 board checker impl' }]]);
    // The span is 900 s; the 40 s and 100 s gaps before each round are idle time, not agent work.
    expect(s.totalSeconds).toBe(760);
  });

  it('doesNotCountADecisionAMessageOrASystemNoticeAsAFixRound', () => {
    const events = [human(0, 'Implement x'), turn(100, 'm1', 50), coordinator(150, 'Main Agent decision: Option 1. Proceed.'), systemNotice(200), turn(300, 'm2', 50)];
    const s = sessionWith([['b3', events, { description: 'Implement x' }]]);
    expect(s.byRole.fix.runs).toBe(0);
    expect(s.fixRounds.sentBack).toBe(0);
    expect(s.byRole.build.seconds).toBe(300);
  });

  it('addsASentBackRoundToAnAgentThatWasAlreadyAFixRunWithoutMovingItsTime', () => {
    const events = [human(0, 'Fix W1 findings'), turn(200, 'm1', 100), coordinator(260, 'Round 2: two findings remain'), turn(500, 'm2', 100)];
    const s = sessionWith([['f2', events, { description: 'Fix W1 findings' }]]);
    expect(s.byRole.fix.runs).toBe(2);
    expect(s.fixRounds.sentBack).toBe(1);
    expect(s.byRole.fix.seconds).toBe(200 + 240);
  });

  it('neverSplitsAReviewRunsTranscriptAndKeepsReadingItsFinalMessage', () => {
    const events = [human(0, 'Review W1'), turn(100, 'm1', 50), coordinator(150, 'Round 2: re-review the fix'), turn(300, 'm2', 50, '- MINOR-1: leftover')];
    const s = sessionWith([['r9', events, { description: 'Review W1 wave' }]]);
    expect(s.byRole.fix.runs).toBe(0);
    expect(s.byRole.review.seconds).toBe(300);
    expect(s.reviewYield.reviews[0].class).toBe('minor-only');
  });

  it('keepsTotalAgentTimeAtTheSumOfOwnAndFixSegmentsNotTheirOverlap', () => {
    const s = sessionWith([['b2', buildThenTwoFixRounds(), { description: 'ST-2.3 board checker impl' }]]);
    expect(s.byRole.build.seconds + s.byRole.fix.seconds).toBe(s.totalSeconds);
    expect(s.byRole.fix.share).toBe(0.6053);
  });

  it('rendersHowManyFixRoundsWereSentBackToAnExistingAgent', () => {
    const t = tmp.write('proj2/sess-2.jsonl', jsonl([human(0, 'go')]));
    tmp.write('proj2/sess-2/subagents/agent-b2.jsonl', jsonl(buildThenTwoFixRounds()));
    tmp.write('proj2/sess-2/subagents/agent-b2.meta.json', JSON.stringify({ description: 'Impl x' }));
    const md = ts.renderMarkdown(ts.analyzeSession(t));
    expect(md).toContain('## Subagents (1 runs, 0.21 agent-hours');
    expect(md).toContain('Fix runs: **2**, 0.13 agent-hours (60.5% of subagent time); 2 sent back to an existing agent (SendMessage)');
  });

  it('fixRoundStartsReadsOnlyLaterFixMessagesNotTheFirstPromptOrToolResults', () => {
    const events = ts.parseEvents(
      jsonl([
        human(0, 'Round 1: build it'),
        toolResult(10),
        coordinator(20, 'fix these findings'),
        coordinator(30, 'thanks, carry on'),
        human(40, 'Round 3 now'),
        human(50, '<system-reminder>fix the review findings</system-reminder>'),
      ]),
    );
    expect(ts.fixRoundStarts(events)).toEqual([2, 4]);
    expect(ts.continuationText(events[1])).toBe(null);
    expect(ts.continuationText(events[2])).toBe('fix these findings');
  });

  it.each([
    ['Round 2 for board_check.py', true],
    ['fix these findings', true],
    ['Please address the review before you finish', true],
    ['Security review findings to fold in: MAJOR 1', true],
    ['Fix the broken import', true],
    ['Main Agent decision: Option 1. Proceed.', false],
    ['Use a SECURITY DEFINER function', false],
    ['Looks good, carry on', false],
  ])('classifiesTheMessage_%s_asFixRound_%s', (text, isFix) => {
    const events = ts.parseEvents(jsonl([human(0, 'start'), coordinator(10, text)]));
    expect(ts.fixRoundStarts(events).length).toBe(isFix ? 1 : 0);
  });
});

describe('countSeverities', () => {
  it('countsLabelledLineShapes', () => {
    const text = ['- CRITICAL-1: a', '* MAJOR-2: b', '1. **MINOR** c', '## NIT: d', '  [MINOR] e', 'MAJOR: f'].join('\n');
    const c = ts.countSeverities(text);
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([1, 2, 2, 1]);
  });

  it('isCaseSensitiveAndIgnoresUnlabelledMentions', () => {
    const c = ts.countSeverities('major issue here\nThe MAJOR risk is low\nNo CRITICAL findings\nminor nit');
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([0, 0, 0, 0]);
  });

  it('skipsSummaryLinesThatSayNone', () => {
    const c = ts.countSeverities('CRITICAL: none\n- MAJOR: 0\nNIT - nil\n- MINOR-1: real');
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([0, 0, 1, 0]);
  });

  it('countsListItemsUnderABareLabelHeading', () => {
    const text = ['**MAJOR**', '1. **First** thing', '   - sub bullet', '2. **Second** thing', '', '**MINOR** (each reproduced)', '- one', '- two', '- three'].join('\n');
    const c = ts.countSeverities(text);
    expect([c.MAJOR, c.MINOR]).toEqual([2, 3]);
  });

  it('countsABareHeadingWithNoItemsAsOneFinding', () => {
    expect(ts.countSeverities('## CRITICAL\nSomething broke.').CRITICAL).toBe(1);
  });

  it('doesNotDoubleCountLabelledItemsUnderTheirOwnHeading', () => {
    const c = ts.countSeverities('## MAJOR\n- MAJOR-1: a\n- MAJOR-2: b');
    expect(c.MAJOR).toBe(2);
  });

  it('readsProseCountsAndTakesTheLargerOfEachShape', () => {
    const prose = ts.countSeverities('I found no CRITICAL issues, but two MAJOR ones, and 7 MINOR and 3 NIT.');
    expect([prose.CRITICAL, prose.MAJOR, prose.MINOR, prose.NIT]).toEqual([0, 2, 7, 3]);
    const both = ts.countSeverities('two MAJOR\n- MAJOR-1: a');
    expect(both.MAJOR).toBe(2);
  });

  it('flagsAnExplicitNoFindingsStatement', () => {
    expect(ts.countSeverities('Reviewed. No findings.').noFindings).toBe(true);
    expect(ts.countSeverities('- MINOR-1: x').noFindings).toBe(false);
  });

  it('mapsSecurityGradesHighMediumLowToMajorMinorNit', () => {
    const c = ts.countSeverities(['- **H-1 (HIGH, pre-existing):** a', '- **M-1: b**', '- **M-2: c**', '- **L-1:** d', '8. **LOW: e**', '- CRITICAL-1: f'].join('\n'));
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([1, 1, 2, 2]);
  });

  it('countsASecurityGradeHeadingWithItsLabelledItemsOnce', () => {
    const text = ['**MEDIUM**', '- **M-1: a**', '', '**LOW findings, with fixes:**', '- **L-1:** x', '- **L-2:** y', '- **L-3:** z'].join('\n');
    const c = ts.countSeverities(text);
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([0, 0, 1, 3]);
  });

  it('countsPlainItemsUnderAHighHeading', () => {
    const c = ts.countSeverities('## HIGH\n- one\n- two\n\n## MEDIUM (1)\n- three');
    expect([c.MAJOR, c.MINOR, c.NIT]).toEqual([2, 1, 0]);
  });

  it('readsMAsMajorUnderAMajorHeadingEvenAfterAParagraphAndMAsMediumWithNoHeading', () => {
    const under = ts.countSeverities(
      ['## MAJOR', '**M1. a**', '- sub one', '- sub two', 'A plain paragraph between findings.', '**M2. b**', '## MINOR', '- m-1 x', '- m-2 y'].join('\n'),
    );
    expect([under.MAJOR, under.MINOR]).toEqual([2, 2]);
    const bare = ts.countSeverities('- **M-1, a**\n- **M-2, b**\n- **L-1, c**');
    expect([bare.MAJOR, bare.MINOR, bare.NIT]).toEqual([0, 2, 1]);
  });

  it('doesNotLetAnUnrelatedHeadingKeepTheLabelContext', () => {
    const c = ts.countSeverities('## MAJOR\n- MAJOR-1: a\n## Focus areas\n- **M-1** passes');
    expect([c.MAJOR, c.MINOR]).toEqual([1, 1]);
  });

  it('readsGradedProseCountsButOnlyInUppercase', () => {
    const graded = ts.countSeverities('It has no CRITICAL, HIGH or MEDIUM findings. I found 4 LOW findings and 1 NIT.');
    expect([graded.CRITICAL, graded.MAJOR, graded.MINOR, graded.NIT]).toEqual([0, 0, 0, 5]);
    const prose = ts.countSeverities('This is a high-risk write. I also listed three nits and a low priority item.');
    expect([prose.CRITICAL, prose.MAJOR, prose.MINOR, prose.NIT]).toEqual([0, 0, 0, 0]);
  });

  it('skipsGradedSummaryLinesThatSayNone', () => {
    const c = ts.countSeverities('HIGH findings: none\n- MEDIUM: 0\nLOW - nil\n- L-1: real');
    expect([c.MAJOR, c.MINOR, c.NIT]).toEqual([0, 0, 1]);
  });

  it('canonicalSeverityMapsEveryVocabulary', () => {
    expect(['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'HIGH', 'MEDIUM', 'LOW', 'H-1', 'M2', 'L-3'].map(ts.canonicalSeverity)).toEqual([
      'CRITICAL',
      'MAJOR',
      'MINOR',
      'NIT',
      'MAJOR',
      'MINOR',
      'NIT',
      'MAJOR',
      'MINOR',
      'NIT',
    ]);
  });

  it('classifiesAMediumOnlyAuditAsMinorOnlyAndAHighAuditAsMajorPlus', () => {
    expect(ts.classifyReview(ts.countSeverities('**MEDIUM**\n- **M-1: a**'))).toBe('minor-only');
    expect(ts.classifyReview(ts.countSeverities('- **L-1: a**'))).toBe('minor-only');
    expect(ts.classifyReview(ts.countSeverities('- **H-1: a**'))).toBe('major+');
    expect(ts.classifyReview(ts.countSeverities('No findings.'))).toBe('clean');
  });

  it('classifyReviewOrdersMajorPlusOverMinorOnlyOverClean', () => {
    expect(ts.classifyReview({ CRITICAL: 1, MAJOR: 0, MINOR: 0, NIT: 0 })).toBe('major+');
    expect(ts.classifyReview({ CRITICAL: 0, MAJOR: 1, MINOR: 5, NIT: 5 })).toBe('major+');
    expect(ts.classifyReview({ CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 1 })).toBe('minor-only');
    expect(ts.classifyReview({ CRITICAL: 0, MAJOR: 0, MINOR: 0, NIT: 0 })).toBe('clean');
  });
});

// ── Resolution, args, rendering ─────────────────────────────────────────────

describe('transcript resolution', () => {
  it('derivesTheProjectDirNameFromTheCwd', () => {
    expect(ts.deriveProjectDirName('/srv/code/Example.App')).toBe('-srv-code-Example-App');
  });

  it('usesAPathAsIs', () => {
    expect(ts.resolveTranscript('/a/b/c.jsonl')).toBe('/a/b/c.jsonl');
  });

  it('resolvesASessionIdUnderAnExplicitProjectDir', () => {
    expect(ts.resolveTranscript(SESSION_ID, { projectDir })).toBe(path.join(projectDir, `${SESSION_ID}.jsonl`));
  });

  it('resolvesASessionIdUnderTheDerivedProjectDir', () => {
    const got = ts.resolveTranscript('abc', { cwd: '/x/y.z', home: '/h' });
    expect(got).toBe(path.join('/h', '.claude', 'projects', '-x-y-z', 'abc.jsonl'));
  });

  it('triesARelativeProjectDirUnderClaudeProjects', () => {
    const got = ts.resolveTranscript('abc', { projectDir: 'no-such-relative-dir-xyz', home: '/h' });
    expect(got).toBe(path.join('/h', '.claude', 'projects', 'no-such-relative-dir-xyz', 'abc.jsonl'));
  });
});

describe('parseArgs', () => {
  it('parsesTargetProjectDirAndJson', () => {
    expect(ts.parseArgs(['s1', '--project-dir', '/p', '--json'])).toEqual({ target: 's1', projectDir: '/p', json: true });
    expect(ts.parseArgs(['--project-dir=/q', 's2'])).toEqual({ target: 's2', projectDir: '/q', json: false });
  });

  it('rejectsMissingTargetUnknownOptionsAndExtraArguments', () => {
    expect(ts.parseArgs([]).error).toMatch(/missing/);
    expect(ts.parseArgs(['--bogus', 'x']).error).toMatch(/unknown option/);
    expect(ts.parseArgs(['a', 'b']).error).toMatch(/unexpected argument/);
    expect(ts.parseArgs(['a', '--project-dir']).error).toMatch(/needs a value/);
  });
});

describe('renderMarkdown', () => {
  it('rendersTheSectionsAndLabelledValues', () => {
    const md = ts.renderMarkdown(ts.analyzeSession(transcript));
    expect(md).toContain('**0.69 h wall clock**');
    expect(md).toContain('| Waiting on owner | 0.03 | 4.0% |');
    expect(md).toContain('| Idle gaps > 30 min | 0.56 | 80.0% |');
    expect(md).toContain('## Subagents (6 runs, 1.13 agent-hours');
    expect(md).toContain('| fix | 1 | 0.33 | 29.4% | 800 | sonnet x1 |');
    expect(md).toContain('Fix runs: **1**, 0.33 agent-hours');
    expect(md).toContain('Reviews: **3**; major+ (any CRITICAL/MAJOR): **1**; minor-only: **1**; clean: **1**');
    expect(md).toContain('Labelled findings: CRITICAL 0, MAJOR 1, MINOR 2, NIT 2');
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else out[full] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

describe('CLI', () => {
  it('printsTheFullReportAsJsonForATranscriptPath', () => {
    const r = run([transcript, '--json']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.wallSeconds).toBe(2500);
    expect(report.main.buckets.waitingOnOwner).toBe(100);
    expect(report.main.buckets.waitingOnAgents).toBe(200);
    expect(report.main.buckets.idle).toBe(2000);
    expect(report.main.buckets.ownWork.total).toBe(200);
    expect(report.subagents.runs).toBe(6);
    expect(report.subagents.byRole.fix.runs).toBe(1);
    expect(report.subagents.reviewYield['major+']).toBe(1);
    expect(report.subagents.fixRounds.rounds).toBe(1);
  });

  it('resolvesASessionIdWithProjectDir', () => {
    const r = run([SESSION_ID, '--project-dir', projectDir, '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).subagents.runs).toBe(6);
  });

  it('printsMarkdownByDefault', () => {
    const r = run([transcript]);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('# Session time split')).toBe(true);
  });

  it('exitsOneWhenTheTranscriptIsMissing', () => {
    const r = run([path.join(tmp.root, 'nope.jsonl')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/transcript not found/);
    expect(r.stdout).toBe('');
  });

  it('exitsTwoOnBadUsage', () => {
    const none = run([]);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/Usage:/);
    expect(run(['--bogus']).status).toBe(2);
  });

  it('neverWritesIntoTheTranscriptDirectory', () => {
    const before = snapshot(tmp.root);
    expect(run([transcript, '--json']).status).toBe(0);
    expect(run([transcript]).status).toBe(0);
    expect(snapshot(tmp.root)).toEqual(before);
  });
});

describe('NIT headings and N-n ids', () => {
  it('counts items under a **NITs** heading and N-1 ids as NIT', () => {
    const { countSeverities } = require('../session-timesplit');
    const counts = countSeverities(['**NITs**', '- N-1: rename x', '- N-2: typo in y', '', 'MAJOR-1: real bug'].join('\n'));
    expect(counts.NIT).toBe(2);
    expect(counts.MAJOR).toBe(1);
  });
});

// ── Final-review fixes (M1, M2, m1-m5, n2) ──────────────────────────────────

const sev = (text) => {
  const c = ts.countSeverities(text);
  return [c.CRITICAL, c.MAJOR, c.MINOR, c.NIT];
};

describe('countSeverities: a finding that merely starts with "No", "nil", "None", "0" or "zero" (M1)', () => {
  it.each([
    ['- MAJOR: No validation on the upload path', [0, 1, 0, 0]],
    ['**MAJOR** No auth check on /admin', [0, 1, 0, 0]],
    ['- MAJOR: nil pointer dereference in handler', [0, 1, 0, 0]],
    ['- MAJOR: None returned from get_user is unchecked', [0, 1, 0, 0]],
    ['- MINOR: 0-length buffer not handled', [0, 0, 1, 0]],
    ['- MINOR: zeroing the buffer is skipped', [0, 0, 1, 0]],
  ])('countsTheFinding_%s', (text, expected) => {
    expect(sev(text)).toEqual(expected);
  });

  it('stillSkipsEverySummaryLineThatSaysNone', () => {
    const summaries = ['CRITICAL: none', '- MAJOR: 0', 'NIT - nil', '- MAJOR: no findings', '- MINOR: No issues found', '- MAJOR: 0 (all closed)', '## MINOR (0)', 'HIGH findings: none'];
    for (const line of summaries) expect(sev(line)).toEqual([0, 0, 0, 0]);
  });

  it('classifiesAReviewWhoseOnlyFindingReadsNoValidationAsMajorPlus', () => {
    expect(ts.classifyReview(ts.countSeverities('- MAJOR: No validation on the upload path'))).toBe('major+');
  });
});

describe('countSeverities: markdown tables (M2)', () => {
  it('countsOneFindingPerRowOfAFindingsTable', () => {
    const table = ['| # | Sev | File | Issue |', '|---|---|---|---|', '| 1 | **MAJOR** | a.js:3 | bad |', '| 2 | MINOR | b.js:9 | meh |', '| 3 | MINOR | c.js:1 | meh |'].join('\n');
    expect(sev(table)).toEqual([0, 1, 2, 0]);
  });

  it('countsAHeaderlessFindingsRowOnce', () => {
    expect(sev('| 1 | MAJOR | a.js:3 | bad |')).toEqual([0, 1, 0, 0]);
  });

  it('readsTheCountColumnOfASeverityCountTable', () => {
    const table = ['| Severity | Count | Notable |', '|---|---:|---|', '| CRITICAL | 0 | - |', '| MAJOR | 2 | auth |', '| MINOR | 5 | naming |', '| NIT | 1 | typo |'].join('\n');
    expect(sev(table)).toEqual([0, 2, 5, 1]);
  });

  it('readsAHeaderlessLabelAndCountRow', () => {
    expect(sev('| MAJOR | 2 |')).toEqual([0, 2, 0, 0]);
  });

  it('readsLabelColumnsOverARowOfNumbers', () => {
    const table = ['| CRITICAL | MAJOR | MINOR | NIT |', '|---|---|---|---|', '| 0 | 2 | 5 | 1 |'].join('\n');
    expect(sev(table)).toEqual([0, 2, 5, 1]);
  });

  it('doesNotCountClosedRowsOfAClosureTable', () => {
    const table = ['| ID | Sev | Status |', '|---|---|---|', '| M1 | MAJOR | CLOSED |', '| M2 | MAJOR | OPEN |'].join('\n');
    expect(sev(table)).toEqual([0, 1, 0, 0]);
  });

  it('keepsTableCountsAndLineCountsAsAMaxNotASum', () => {
    const text = ['- MAJOR-1: a', '- MAJOR-2: b', '', '| Severity | Count |', '|---|---|', '| MAJOR | 2 |'].join('\n');
    expect(sev(text)).toEqual([0, 2, 0, 0]);
  });

  it('classifiesATableOnlyReviewAsMajorPlusNotClean', () => {
    expect(ts.classifyReview(ts.countSeverities('| 1 | MAJOR | a.js:3 | bad |'))).toBe('major+');
  });

  it('ignoresATableWithNoSeverityCell', () => {
    expect(sev(['| File | Result |', '|---|---|', '| a.js | ok |'].join('\n'))).toEqual([0, 0, 0, 0]);
  });
});

describe('countSeverities: risk-tier words are not grades (m1)', () => {
  it('doesNotCountAHighRiskPathAsAMajorFinding', () => {
    const c = ts.countSeverities('This touches a HIGH-risk path; no findings.');
    expect([c.CRITICAL, c.MAJOR, c.MINOR, c.NIT]).toEqual([0, 0, 0, 0]);
    expect(c.noFindings).toBe(true);
  });

  it('doesNotCountCountedRiskTierFilesAsFindings', () => {
    expect(sev('Risk tier: one HIGH file, two MEDIUM files. Verdict: clean.')).toEqual([0, 0, 0, 0]);
    expect(sev('Touches 3 LOW risk paths and a MEDIUM tier surface.')).toEqual([0, 0, 0, 0]);
  });

  it('doesNotCountALineThatStartsWithAHighRiskNote', () => {
    expect(sev('HIGH-risk surface touched: auth middleware')).toEqual([0, 0, 0, 0]);
  });

  it('stillCountsGradedFindingsNextToTheSameWords', () => {
    expect(sev('I found 2 HIGH findings and 3 MEDIUM issues.')).toEqual([0, 2, 3, 0]);
    expect(sev('- HIGH: path traversal in the upload handler')).toEqual([0, 1, 0, 0]);
  });
});

describe('categorizeTool: product code and agent waits (m2)', () => {
  it.each([
    ['src/dashboard/Chart.tsx', 'write code'],
    ['app/dashboard/page.tsx', 'write code'],
    ['src/components/Timeline.tsx', 'write code'],
    ['src/billing/changelog-view.ts', 'write code'],
    ['/srv/code/Example.App/.claude/hooks/guard.cjs', 'write code'],
    ['/srv/code/Example.App/tools/lint.mjs', 'write code'],
    ['/srv/code/Example.App/scripts/sync.py', 'write code'],
    ['/srv/code/Example.App/docs/notes.md', 'write docs'],
    ['/srv/code/Example.App/docs/guide.MDX', 'write docs'],
    ['/srv/code/Example.App/README.txt', 'write docs'],
  ])('filesEditedAt_%s_as_%s', (file, category) => {
    expect(ts.categorizeTool('Edit', { file_path: file })).toBe(category);
  });

  it('stillFilesRealBookkeepingPathsAsBookkeeping', () => {
    for (const file of ['/srv/code/Example.App/Board/Tasks.md', '/srv/code/Example.App/docs/work/timeline.md', '/srv/code/Example.App/CHANGELOG.md', '/srv/code/Example.App/docs/work/todo/TODO_x.md']) {
      expect(ts.categorizeTool('Edit', { file_path: file })).toBe('bookkeeping');
    }
    expect(ts.categorizeTool('Bash', { command: 'cat Board/Tasks.md' })).toBe('bookkeeping');
    expect(ts.categorizeTool('Bash', { command: 'ls src/dashboard' })).toBe('shell (other)');
  });

  it('filesTaskOutputAndTaskStopAsWaitingOnAgentsNotBookkeeping', () => {
    expect(ts.categorizeTool('TaskOutput', { task_id: 'a1' })).toBe('waiting/agent ops');
    expect(ts.categorizeTool('TaskStop', { task_id: 'a1' })).toBe('waiting/agent ops');
    expect(ts.categorizeTool('TaskUpdate', {})).toBe('bookkeeping');
    expect(ts.categorizeTool('TodoWrite', {})).toBe('bookkeeping');
  });
});

describe('roles: agentType first, then build and fix intent (m3)', () => {
  it.each([
    ['Build review screen', 'build'],
    ['Implement reviews list API', 'build'],
    ['Implement audit log table', 'build'],
    ['Add security headers middleware', 'build'],
    ['Address review findings for W2', 'fix'],
    ['Resolve W3 findings', 'fix'],
    ['Round 2 fixes', 'fix'],
    ['Security fixes for M-1', 'fix'],
    // The text rules that already held keep holding.
    ['Review W1.6 Sheet extras', 'review'],
    ['Security audit TR-2.9', 'security'],
    ['Add unit tests for e1rm', 'tests'],
  ])('mapsDescription_%s_to_%s', (description, role) => {
    expect(ts.roleFromText(description)).toBe(role);
  });

  it('mapsAgentTypeToItsRoleAndLeavesOtherTypesToTheDescription', () => {
    expect(ts.roleFromAgentType('code-reviewer')).toBe('review');
    expect(ts.roleFromAgentType('security-auditor')).toBe('security');
    expect(ts.roleFromAgentType('qa-engineer')).toBe('tests');
    expect(ts.roleFromAgentType('doc-writer')).toBe('docs');
    expect(ts.roleFromAgentType('example:Code-Reviewer')).toBe('review');
    expect(ts.roleFromAgentType('general-purpose')).toBe(null);
    expect(ts.roleFromAgentType(undefined)).toBe(null);
  });

  it('readsTheRoleFromAgentTypeBeforeTheDescriptionAndKeepsBuildRunsOutOfReviewYield', () => {
    const t = tmp.write('proj3/sess-3.jsonl', jsonl([human(0, 'go')]));
    const add = (id, meta, lastText) => {
      tmp.write(path.join('proj3', 'sess-3', 'subagents', `agent-${id}.jsonl`), jsonl(subagentEvents({ prompt: 'p', duration: 100, lastText, tokens: 40 })));
      tmp.write(path.join('proj3', 'sess-3', 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta));
    };
    add('a', { agentType: 'general-purpose', description: 'Implement audit log table' }, '- MAJOR-1: not a review at all');
    add('b', { agentType: 'code-reviewer', description: 'Check the W2 diff' }, '- MINOR-1: naming');
    add('c', { agentType: 'general-purpose', description: 'Address review findings for W2' }, 'Done.');
    const s = ts.analyzeSession(t).subagents;
    expect(s.byRole.build.runs).toBe(1);
    expect(s.byRole.review.runs).toBe(1);
    expect(s.byRole.fix.runs).toBe(1);
    expect(s.byRole.security.runs).toBe(0);
    expect(s.reviewYield.reviewCount).toBe(1);
    expect(s.reviewYield.severities).toEqual({ CRITICAL: 0, MAJOR: 0, MINOR: 1, NIT: 0 });
  });
});

describe('fix-round messages need an instruction, not just the word findings (m4)', () => {
  const coordinator = (sec, text) => ({
    type: 'user',
    timestamp: at(sec),
    isMeta: true,
    message: { role: 'user', content: `The coordinator sent a message while you were working:\n${text}` },
  });

  it.each([
    ['Proceed with Option 1. The review findings are for later.', false],
    ['Please also add the audit log findings to your report.', false],
    ['Thanks. The security findings look fine.', false],
    ['Fold in the security review findings below', true],
    ['Security review findings to fold in: MAJOR 1', true],
    ['Please resolve the code review findings', true],
    ['Address the review findings above', true],
  ])('classifiesTheMessage_%s_asFixRound_%s', (text, isFix) => {
    const events = ts.parseEvents(jsonl([human(0, 'start'), coordinator(10, text)]));
    expect(ts.fixRoundStarts(events).length).toBe(isFix ? 1 : 0);
  });
});

describe('deriveProjectDirName replaces every non-alphanumeric character (m5, TG1)', () => {
  it.each([
    ['/srv/code/Example.App', '-srv-code-Example-App'],
    ['/srv/code/Example_App', '-srv-code-Example-App'],
    ['/srv/code/My App 2', '-srv-code-My-App-2'],
    ['/srv/.hidden/Example.App', '-srv--hidden-Example-App'],
    ['/srv/code/Example+App~1', '-srv-code-Example-App-1'],
  ])('derivesTheFolderNameOf_%s_as_%s', (cwd, name) => {
    expect(ts.deriveProjectDirName(cwd)).toBe(name);
  });

  it('derivesTheFolderNameOfAWindowsPath', () => {
    expect(ts.deriveProjectDirName('C:\\srv\\Example.App')).toBe('C--srv-Example-App');
    expect(ts.deriveProjectDirName('D:/srv/Example_App')).toBe('D--srv-Example-App');
  });

  it('resolvesABareSessionIdForACwdWithAnUnderscoreAndASpace', () => {
    const got = ts.resolveTranscript('abc', { cwd: '/srv/My_App 2', home: '/h' });
    expect(got).toBe(path.join('/h', '.claude', 'projects', '-srv-My-App-2', 'abc.jsonl'));
  });
});

describe('parseArgs: option values and help (n2)', () => {
  it('rejectsAnOptionTakenAsTheProjectDirValue', () => {
    expect(ts.parseArgs(['s1', '--project-dir', '--json']).error).toMatch(/needs a value/);
    expect(ts.parseArgs(['s1', '--project-dir=']).error).toMatch(/needs a value/);
  });

  it('rejectsAnUnknownShortOption', () => {
    expect(ts.parseArgs(['-x', 's1']).error).toMatch(/unknown option/);
  });

  it('parsesHelpFlagsWithoutATarget', () => {
    expect(ts.parseArgs(['-h']).help).toBe(true);
    expect(ts.parseArgs(['--help']).help).toBe(true);
    expect(ts.parseArgs(['s1', '--help']).help).toBe(true);
  });

  it('printsTheUsageAndExitsZeroForHelp', () => {
    for (const flag of ['-h', '--help']) {
      const r = run([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^Usage: session-timesplit\.js/);
      expect(r.stderr).toBe('');
    }
  });

  it('exitsTwoWhenTheProjectDirValueIsMissing', () => {
    const r = run([SESSION_ID, '--project-dir', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/needs a value/);
  });
});

// ── SF-3.7 window flags ─────────────────────────────────────────────────────
//
// PINNED CONTRACT (SF-3.7, AC 1: `session-timesplit.js` accepts `--since` and `--until`, limits analysis to that
// window, and behaves exactly as before without them).
//
//   CLI     session-timesplit.js <transcript.jsonl | session-id> [--project-dir DIR] [--since TS] [--until TS] [--json]
//           `--since TS` and `--since=TS` (same for `--until`). TS is anything Date.parse accepts (ISO-8601 in practice).
//           Exit 2 with the message on stderr (parseArgs error text in brackets): a missing value (end of argv, or the next
//           argv starts with `--`) [`--since needs a value`, same for --until]; an unparseable TS [`invalid --since: {value}`,
//           same for --until]; `--since` later than `--until` [`--since is after --until`; equal is allowed].
//   parseArgs(argv)   -> the same object as before plus `since` / `until` (the raw strings) ONLY when given; invalid
//                        input is { json:false, error } exactly like the existing option errors.
//   analyzeSession(transcript, { since, until } = {})   (since/until: Date.parse-able strings, either or both)
//                     The window is INCLUSIVE at both ends: only main-thread events with since <= ts <= until are
//                     analyzed, and the same filter applies to every subagent transcript. A subagent run with no event
//                     in the window is not a run (not counted). With a window the report gains
//                     `window: { since, until }` (each ISO-8601 via new Date(x).toISOString(), or null when not given);
//                     WITHOUT a window the report has no `window` key at all and is identical to today's.
//   renderMarkdown(report)  with `report.window` prints one line `Window: {since|-} -> {until|-}`; without it, no
//                     "Window:" text anywhere.

describe('SF-3.7 window flags', () => {
  const WIN_SESSION = 'win-sess';
  let winTranscript;

  const usage = (id, tokens) => ({ id, usage: { output_tokens: tokens } });

  beforeEach(() => {
    // Main thread: one event every 10 s from 0 to 50, no tool use, so every gap is "own work / thinking".
    winTranscript = tmp.write(
      path.join('proj', `${WIN_SESSION}.jsonl`),
      jsonl([
        human(0, 'go'),
        assistantText(10, 'a'),
        assistantText(20, 'b'),
        assistantText(30, 'c'),
        assistantText(40, 'd'),
        assistantText(50, 'e'),
      ]),
    );
    const dir = path.join('proj', WIN_SESSION, 'subagents');
    // w1 spans 5..55 (50 s, 70 output tokens); w2 sits at 100..110 (10 s, 5 tokens), outside every window below.
    tmp.write(
      path.join(dir, 'agent-w1.jsonl'),
      jsonl([human(5, 'p'), assistantText(25, 'x', usage('a', 10)), assistantText(35, 'y', usage('b', 20)), assistantText(55, 'z', usage('c', 40))]),
    );
    tmp.write(path.join(dir, 'agent-w1.meta.json'), JSON.stringify({ description: 'Implement widget' }));
    tmp.write(path.join(dir, 'agent-w2.jsonl'), jsonl([human(100, 'p'), assistantText(110, 'q', usage('d', 5))]));
    tmp.write(path.join(dir, 'agent-w2.meta.json'), JSON.stringify({ description: 'Implement other' }));
  });

  it('analyzeSession_withoutAWindow_hasNoWindowKeyAndIsUnchangedByEmptyOptions', () => {
    const plain = ts.analyzeSession(winTranscript);

    expect('window' in plain).toBe(false);
    expect(ts.analyzeSession(winTranscript, {})).toEqual(plain);
    expect(plain.wallSeconds).toBe(50);
    expect(plain.subagents.runs).toBe(2);
    expect(plain.subagents.byRole.build.seconds).toBe(60);
    expect(plain.subagents.byRole.build.outputTokens).toBe(75);
  });

  it('analyzeSession_sinceAndUntil_limitsMainThreadToEventsInsideTheInclusiveWindow', () => {
    const r = ts.analyzeSession(winTranscript, { since: at(20), until: at(40) });

    expect(r.main.startedAt).toBe(at(20));
    expect(r.main.endedAt).toBe(at(40));
    expect(r.wallSeconds).toBe(20);
    expect(r.main.buckets.ownWork.total).toBe(20);
    expect(r.main.buckets.ownWork.byCategory).toEqual({ 'thinking/writing reply': 20 });
  });

  it('analyzeSession_sinceAndUntil_limitsSubagentTimeAndTokensToEventsInsideTheWindow', () => {
    const r = ts.analyzeSession(winTranscript, { since: at(20), until: at(40) });

    expect(r.subagents.runs).toBe(1); // w2 has no event inside the window: not a run
    expect(r.subagents.byRole.build.runs).toBe(1);
    expect(r.subagents.byRole.build.seconds).toBe(10); // events at 25 and 35
    expect(r.subagents.byRole.build.outputTokens).toBe(30); // messages a (10) and b (20); c is at 55
  });

  it('analyzeSession_sinceOnly_dropsEarlierEventsAndKeepsEverythingAfter', () => {
    const r = ts.analyzeSession(winTranscript, { since: at(30) });

    expect(r.wallSeconds).toBe(20); // events at 30, 40, 50
    expect(r.subagents.runs).toBe(2);
    expect(r.subagents.byRole.build.seconds).toBe(30); // w1 35..55 = 20, w2 100..110 = 10
    expect(r.subagents.byRole.build.outputTokens).toBe(65); // b 20 + c 40 + d 5
    expect(r.window).toEqual({ since: at(30), until: null });
  });

  it('analyzeSession_untilOnly_dropsLaterEventsAndKeepsEverythingBefore', () => {
    const r = ts.analyzeSession(winTranscript, { until: at(25) });

    expect(r.wallSeconds).toBe(20); // events at 0, 10, 20
    expect(r.subagents.runs).toBe(1); // w2 starts at 100
    expect(r.subagents.byRole.build.seconds).toBe(20); // w1 5..25
    expect(r.subagents.byRole.build.outputTokens).toBe(10);
    expect(r.window).toEqual({ since: null, until: at(25) });
  });

  it('analyzeSession_windowWithNoEvents_yieldsAnEmptyReportNotAnError', () => {
    const r = ts.analyzeSession(winTranscript, { since: at(5000), until: at(6000) });

    expect(r.wallSeconds).toBe(0);
    expect(r.main.startedAt).toBeNull();
    expect(r.main.endedAt).toBeNull();
    expect(r.subagents.runs).toBe(0);
  });

  it('analyzeSession_window_isReportedAsNormalisedIsoStrings', () => {
    const r = ts.analyzeSession(winTranscript, { since: '2026-01-01T00:00:20Z', until: '2026-01-01T00:00:40Z' });

    expect(r.window).toEqual({ since: '2026-01-01T00:00:20.000Z', until: '2026-01-01T00:00:40.000Z' });
  });

  it('renderMarkdown_withAWindow_printsTheWindowLineAndWithoutOneNeverMentionsIt', () => {
    const windowed = ts.renderMarkdown(ts.analyzeSession(winTranscript, { since: at(20), until: at(40) }));
    const plain = ts.renderMarkdown(ts.analyzeSession(winTranscript));

    expect(windowed).toContain(`Window: ${at(20)} -> ${at(40)}`);
    expect(plain).not.toContain('Window:');
  });

  it('parseArgs_sinceAndUntil_acceptsSpacedAndEqualsFormsAndKeepsTheRawStrings', () => {
    const spaced = ts.parseArgs(['s1', '--since', '2026-01-01T00:00:10Z', '--until', '2026-01-01T00:00:50Z', '--json']);
    const equals = ts.parseArgs(['--since=2026-01-01T00:00:10Z', '--until=2026-01-01T00:00:50Z', 's1']);

    expect(spaced).toEqual({ target: 's1', json: true, since: '2026-01-01T00:00:10Z', until: '2026-01-01T00:00:50Z' });
    expect(equals).toEqual({ target: 's1', json: false, since: '2026-01-01T00:00:10Z', until: '2026-01-01T00:00:50Z' });
  });

  it.each([
    ['sinceWithoutAValue', ['s1', '--since'], /--since needs a value/],
    ['untilFollowedByAnOption', ['s1', '--until', '--json'], /--until needs a value/],
    ['emptyEqualsForm', ['s1', '--since='], /--since needs a value/],
    ['unparseableSince', ['s1', '--since', 'not-a-date'], /invalid --since/],
    ['unparseableUntil', ['s1', '--until=2026-99-99'], /invalid --until/],
    ['sinceAfterUntil', ['s1', '--since', '2026-01-01T00:00:40Z', '--until', '2026-01-01T00:00:20Z'], /--since is after --until/],
  ])('parseArgs_%s_returnsAnErrorNamingTheFlag', (_name, argv, pattern) => {
    expect(ts.parseArgs(argv).error).toMatch(pattern);
  });

  it('parseArgs_sinceEqualToUntil_isAllowedAsASingleInstantWindow', () => {
    const parsed = ts.parseArgs(['s1', '--since', at(20), '--until', at(20)]);

    expect(parsed.error).toBeUndefined();
    expect(parsed.since).toBe(at(20));
    expect(parsed.until).toBe(at(20));
  });

  it('CLI_sinceAndUntil_printWindowedJsonReport', () => {
    const r = run([winTranscript, '--since', at(20), '--until', at(40), '--json']);

    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.wallSeconds).toBe(20);
    expect(report.subagents.runs).toBe(1);
    expect(report.window).toEqual({ since: at(20), until: at(40) });
  });

  it('CLI_withoutWindowFlags_printsTheSameReportAsBeforeWithNoWindowKey', () => {
    const r = run([winTranscript, '--json']);

    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect('window' in report).toBe(false);
    expect(report).toEqual(JSON.parse(JSON.stringify(ts.analyzeSession(winTranscript))));
  });

  it.each([
    ['unparseableSince', ['--since', 'not-a-date'], /invalid --since/],
    ['missingValue', ['--since'], /--since needs a value/],
    ['sinceAfterUntil', ['--since', at(40), '--until', at(20)], /--since is after --until/],
  ])('CLI_%s_exitsTwoWithTheMessageAndUsageOnStderrAndNothingOnStdout', (_name, extra, message) => {
    const r = run([winTranscript, ...extra]);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toMatch(/Usage:/);
    expect(r.stdout).toBe('');
  });
});

describe('n4 window options: half-open until and a shared parse cache (used by run-trace)', () => {
  const N_SESSION = 'n4-sess';
  let n4Transcript;

  beforeEach(() => {
    // Main thread events at 0, 10, 20, 30, 40, 50 s; one subagent at 5, 25, 35, 55 s.
    n4Transcript = tmp.write(
      path.join('proj', `${N_SESSION}.jsonl`),
      jsonl([human(0, 'go'), assistantText(10, 'a'), assistantText(20, 'b'), assistantText(30, 'c'), assistantText(40, 'd'), assistantText(50, 'e')]),
    );
    const dir = path.join('proj', N_SESSION, 'subagents');
    tmp.write(path.join(dir, 'agent-a.jsonl'), jsonl([human(5, 'p'), assistantText(25, 'x'), assistantText(35, 'y'), assistantText(55, 'z')]));
    tmp.write(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ description: 'Implement widget' }));
  });

  it('analyzeSession_untilExclusive_dropsAnEventExactlyAtUntilAndKeepsTheReportedWindow', () => {
    const inclusive = ts.analyzeSession(n4Transcript, { since: at(0), until: at(30) });
    const exclusive = ts.analyzeSession(n4Transcript, { since: at(0), until: at(30), untilExclusive: true });

    expect(inclusive.wallSeconds).toBe(30); // events 0, 10, 20, 30
    expect(exclusive.wallSeconds).toBe(20); // events 0, 10, 20
    expect(exclusive.window).toEqual({ since: at(0), until: at(30) });
  });

  it('analyzeSession_untilExclusive_appliesToSubagentEventsToo', () => {
    const exclusive = ts.analyzeSession(n4Transcript, { since: at(0), until: at(25), untilExclusive: true });
    const inclusive = ts.analyzeSession(n4Transcript, { since: at(0), until: at(25) });

    expect(exclusive.subagents.byRole.build.seconds).toBe(0); // 5 only: a single event spans 0 s
    expect(inclusive.subagents.byRole.build.seconds).toBe(20); // 5 .. 25
  });

  it('analyzeSession_twoAdjacentExclusiveWindows_countABoundaryEventOnce', () => {
    const first = ts.analyzeSession(n4Transcript, { since: at(0), until: at(30), untilExclusive: true });
    const second = ts.analyzeSession(n4Transcript, { since: at(30), until: at(60) });

    expect(first.wallSeconds + second.wallSeconds).toBe(20 + 20); // 0..20 and 30..50; the 30 s event is in the second only
  });

  it('analyzeSession_untilExclusiveWithoutAnUntil_isTheOpenWindowAndUnchanged', () => {
    expect(ts.analyzeSession(n4Transcript, { since: at(10), untilExclusive: true })).toEqual(ts.analyzeSession(n4Transcript, { since: at(10) }));
  });

  it('analyzeSession_untilExclusiveWithoutAWindow_hasNoWindowKey', () => {
    expect('window' in ts.analyzeSession(n4Transcript, { untilExclusive: true })).toBe(false);
  });

  it('analyzeSession_eventCache_readsEachFileOnceAndEveryWindowMatchesTheUncachedReport', () => {
    const windows = [{ since: at(0), until: at(20) }, { since: at(20), until: at(40) }, { since: at(40), until: at(60) }, {}, { since: at(0), until: at(30), untilExclusive: true }];
    const cache = new Map();
    const expected = windows.map((w) => ts.analyzeSession(n4Transcript, w));
    const spy = vi.spyOn(fs, 'readFileSync');
    let cached;
    try {
      cached = windows.map((w) => ts.analyzeSession(n4Transcript, { ...w, eventCache: cache }));
      const reads = spy.mock.calls.map((c) => String(c[0])).filter((f) => f.endsWith('.jsonl'));
      expect(reads.filter((f) => f === n4Transcript).length).toBe(1);
      expect(reads.filter((f) => f.endsWith('agent-a.jsonl')).length).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(cached).toEqual(expected);
    expect(cache.size).toBe(2);
    // The cached events are reused unchanged: a reversed order over the same cache still matches.
    expect([...windows].reverse().map((w) => ts.analyzeSession(n4Transcript, { ...w, eventCache: cache }))).toEqual([...expected].reverse());
  });

  it('analyzeSession_eventCache_aMissingTranscriptStillThrowsAndCachesNothing', () => {
    const cache = new Map();

    expect(() => ts.analyzeSession(path.join(path.dirname(n4Transcript), 'nope.jsonl'), { eventCache: cache })).toThrow();
    expect(cache.size).toBe(0);
  });

  it('analyzeSession_aNonMapEventCache_isIgnored', () => {
    expect(ts.analyzeSession(n4Transcript, { eventCache: {} })).toEqual(ts.analyzeSession(n4Transcript));
  });
});
