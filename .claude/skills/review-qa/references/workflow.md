# QA — Test Generation

Generate automated tests for code. Uses the `qa-engineer` skill for patterns and conventions.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:qa
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle scope detection, test framework discovery, and test execution. The `qa-engineer` agent handles test planning and generation. Do NOT write tests inline — delegate via Task tool. You DO handle running the tests and committing.

**Agent**: `qa-engineer` (via Task tool with `subagent_type: "qa-engineer"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Determine Scope (main agent)

**If INPUT is a story number:**
- Read story from `docs/work/backlog.md` to get acceptance criteria
- Find the implementation files (from git log or story's files-changed)

**If INPUT is a file path:**
- Read the file to understand what to test
- Check if tests already exist for this file

**If INPUT is a module name:**
- Find all files in the module
- Identify which have tests and which don't

**If no INPUT:**
- Run coverage analysis to find untested code
- Prioritize: business logic > data access > API endpoints > UI

### 2. Detect Test Framework (main agent)

- Check for test projects: `*.Tests.csproj`, `jest.config.*`, `karma.conf.*`, `playwright.config.*`
- Read existing tests to match patterns and conventions
- Read `docs/architecture/overview.md` Testing Strategy section

**Runtime and verification.** In an adopter, the Step 4 run (`gate.js` or the detected test command) executes the application's own build and test commands and never the Domdhi.Agents toolkit suite, including after agent-file edits; in Domdhi.Agents itself it runs the toolkit's Node build and Vitest suite, and toolkit tests stay under `.agents/core/__tests__/` and `.agents/hooks/__tests__/`. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments and dispatch the QA role as `.agents/adapters/codex/execution.md` describes. Note that discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran: claim completion only from the Step 4 test output with zero failures and the Step 5 commit hash.

**2b. Bootstrap (if no test framework detected):**

If no test framework is found:
1. Detect the project runtime from package files: `package.json` (Node), `*.csproj` (dotnet), `requirements.txt`/`pyproject.toml` (Python), `Cargo.toml` (Rust), `go.mod` (Go)
2. Suggest the standard test framework for the detected runtime:
   - Node → Jest or Vitest (check if either is already a devDependency)
   - .NET → xUnit or NUnit (check existing test projects)
   - Python → pytest
   - Rust → built-in `cargo test`
   - Go → built-in `go test`
3. Present the suggestion to the user with the install command (e.g., `npm install -D jest`)
4. **Wait for user confirmation before installing** — never auto-install
5. If confirmed, run the install command and create a minimal test config file
6. If declined, skip test generation and report "No test framework — skipped"

### 3. Delegate to Agent (main agent → qa-engineer)

Use the Task tool with `subagent_type: "qa-engineer"` to plan and generate tests.

**Task prompt must include**:
1. The source files to test (contents or paths)
2. Acceptance criteria from the story (if applicable)
3. Test framework and conventions discovered in Step 2
4. Existing test patterns and examples from the project
5. The `qa-engineer` agent auto-loads the `qa-engineer` skill via frontmatter.
6. Instruction to: map AC → test names, identify test types (unit/integration/e2e), plan test data and mocks, generate tests using Arrange-Act-Assert pattern
7. Instruction to include both happy path AND error paths
8. Instruction to follow naming convention: `{Method}_{Scenario}_{ExpectedResult}`
9. The verified project constraints and architecture conventions loaded in Step 2, with their source paths (or "none" when absent)

### 4. Run Tests + Auto-Fix Loop (main agent)

- Execute the test suite to verify new tests pass
- Run the project's test command (e.g., `npm test`, `dotnet test`, `pytest`, `cargo test`)
- Use `gate.js` for structured build/test execution and failure analysis

**If tests fail — auto-fix loop (max 3 attempts):**

For each attempt:
1. Read the failure output — identify which tests failed and why
2. Dispatch `qa-engineer` agent with failure context: the failing test name, error message, relevant source file, and the test file
3. Agent fixes the test or the source (whichever is actually wrong), returns with status
4. Commit the fix: `fix: /qa — {test name} fix attempt {N}`
5. Re-run the full test suite
6. If all pass → exit loop, proceed to Step 5
7. If still failing → next attempt

After 3 failed attempts: stop, report which tests are still failing with their error output, and ask the user for guidance. Do NOT continue to Step 5 with failing tests.

### 5. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 6. Report (main agent)

```markdown
## QA Complete

**Scope**: {what was tested}
**Tests generated**: {count}
  - Unit: {count}
  - Integration: {count}
  - E2E: {count}
**All passing**: {yes/no}

### Test Inventory
| Test | Type | AC Covered | Status |
|------|------|-----------|--------|
| {name} | Unit | {AC reference} | Pass |

### Auto-Fix Attempts
| Test | Attempts | Result |
|------|----------|--------|
| {name} | {0-3} | {Fixed / Still failing} |

### Coverage Notes
{What's still untested and why}

**Committed**: {hash} — `feat: /qa — {summary}`
```
