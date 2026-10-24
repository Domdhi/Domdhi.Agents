# Security Review

Security audit of code for vulnerabilities, OWASP compliance, secret exposure, and attack surface analysis. Uses the `security-auditor` agent. The auditor writes its findings to `docs/.output/findings/reviews/` and never modifies the system under audit.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:security
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle scope detection and context gathering. The `security-auditor` agent handles the actual security analysis. Do NOT perform the review inline — delegate via Task tool. You DO handle the final report output.

**Agent**: `security-auditor` (via Task tool with `subagent_type: "security-auditor"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Determine Scope (main agent)

**If INPUT is a file path or directory:**
- Read the specific file(s) or list directory contents

**If INPUT is a PR number:**
- Run `gh pr diff {number}` to get the diff

**If INPUT is a git range (e.g., "HEAD~3"):**
- Run `git diff {range}` to get the diff

**If no INPUT:**
- Run `git diff` for unstaged changes
- If no unstaged changes, run `git diff HEAD~1` for last commit

### 2. Gather Security Context (main agent)

- Read `docs/architecture/overview.md` — Auth & Authorization section, Security ADRs, API design
- Read `docs/product/requirements.md` — Security requirements, NFRs related to security
- Search for security-relevant files:
  ```
  Glob: *.env*, .env.example, docker-compose*, Dockerfile*
  Glob: **/auth/**, **/middleware/**, **/security/**
  Glob: **/config/**, **/secrets/**
  ```
- Check memory for known security constraints:
  ```bash
  node .claude/core/memory-manager.js search "security"
  node .claude/core/memory-manager.js list constraints
  ```

**Runtime and verification.** This audit changes no application code and runs no build or test gate; any recommended remediation is verified by the application's own `gate.js` commands in an adopter, never the Domdhi.Agents toolkit suite (including after agent-file edits), and by the toolkit's Node build and Vitest suite only in Domdhi.Agents itself. In Codex, run each `.claude/core/` command in this workflow (telemetry, memory search, `commit.js`) as `.codex/core/` with the same arguments and dispatch the auditor as `.agents/adapters/codex/execution.md` describes. Note that discovery alone (an installed skill, a listed command or a loaded file) never proves this audit ran: claim completion only from the Step 4 audit written to `docs/.output/findings/reviews/` with redacted secrets and its Step 5 commit hash.

### 3. Delegate to Agent (main agent → security-auditor)

Use the Task tool with `subagent_type: "security-auditor"` to perform the audit.

**Task prompt must include**:
1. The diff, file contents, or directory listing to audit
2. Architecture security context (auth model, security ADRs, API design)
3. Security requirements from PRD (if any)
4. Known security constraints from memory
5. The `security-auditor` agent auto-loads the `code-review` skill via frontmatter (for severity classification)
6. Instruction to perform a full OWASP Top 10 assessment against the code in scope
7. Instruction to scan for hardcoded secrets, credentials, API keys, tokens in all files
8. Instruction to verify authorization on every protected endpoint (not just authentication)
9. Instruction to check input validation at all system boundaries
10. Instruction to think in attack chains — how LOW findings combine into higher-severity paths
11. Instruction to classify findings by severity: CRITICAL > HIGH > MEDIUM > LOW
12. Instruction to include for each finding: severity, OWASP category, proof conditions, attack scenario, remediation
13. The verified project constraints and architecture conventions loaded in Step 2, with their source paths (or "none" when absent)

> **MANDATORY — redact secrets in the report.** When a finding quotes a discovered credential, NEVER write the full value into the audit file. Redact to a non-recoverable, non-matching form: show at most a short identifying prefix then mask the rest, e.g. `CG-abc…[REDACTED]` or `sk-ant-…[REDACTED]`. Report the **location** (`file:line`) precisely so it can be found and rotated — the location, not the value, is what makes the finding actionable. This is both why the report stays safe to commit and why the commit-time secret scan won't block it. (A non-redacted full key written into `docs/.output/findings/reviews/` is exactly how a live key once leaked — the output dir is no longer a scanner blind spot.)

### 4. Persist Output (main agent)

Write the full audit to disk before reporting:

```bash
mkdir -p docs/.output/findings/reviews
```

Write the complete audit output (OWASP assessment + all findings) to:
`docs/.output/findings/reviews/{YYMMDD-HHMM}-security-audit.md`

File format:
```markdown
# Security Audit — {YYYY-MM-DD}

**Scope**: {files/PR/diff audited}
**Findings**: {critical} critical, {high} high, {medium} medium, {low} low

{full report content — threat model, OWASP table, findings, attack chains, secret scan}
```

### 5. Commit (main agent)

Stage and commit the audit output file:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:security — {N} findings ({critical}C/{high}H/{medium}M/{low}L)
```

Then run:

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-security-audit.md
node .claude/core/commit.js
```

### 6. Report (main agent)

Read the agent's output and present the final report, including the output file path:

```markdown
## Security Review Complete

**Scope**: {files/PR/diff reviewed}
**Findings**: {critical} critical, {high} high, {medium} medium, {low} low
**Output**: `docs/.output/findings/reviews/{YYMMDD-HHMM}-security-audit.md`

### Threat Model
{Attack surface summary — endpoints, inputs, auth boundaries, third-party integrations identified by the auditor}

### OWASP Top 10 Assessment
| Category | Status | Notes |
|----------|--------|-------|
| A01: Broken Access Control | {PASS/FAIL/NA} | {details} |
| A02: Cryptographic Failures | {PASS/FAIL/NA} | {details} |
| A03: Injection | {PASS/FAIL/NA} | {details} |
| A04: Insecure Design | {PASS/FAIL/NA} | {details} |
| A05: Security Misconfiguration | {PASS/FAIL/NA} | {details} |
| A06: Vulnerable Components | {PASS/FAIL/NA} | {details} |
| A07: Auth Failures | {PASS/FAIL/NA} | {details} |
| A08: Data Integrity Failures | {PASS/FAIL/NA} | {details} |
| A09: Logging Failures | {PASS/FAIL/NA} | {details} |
| A10: SSRF | {PASS/FAIL/NA} | {details} |

### Findings
{For each finding: severity, OWASP category, file:line, description, attack scenario, remediation}

### Attack Chains
{Any combinations of lower-severity findings that create higher-severity paths}

### Secret Scan
{Results of secret/credential scan — CLEAN, or list of exposures with REDACTED values (`CG-abc…[REDACTED]`) + precise `file:line` locations to rotate. Never the full secret.}

### Recommended Actions
{Prioritized list of remediations — CRITICAL first, then HIGH, etc.}
```
