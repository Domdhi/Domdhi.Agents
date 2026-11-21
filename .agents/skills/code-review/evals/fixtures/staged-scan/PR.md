# PR #231 — secret-scanner: scan the staged content in git pre-commit mode

## Why

The Claude Code hook mode of `secret-scanner.cjs` only sees Write/Edit tool calls. Anything staged by a
script, a codemod or a human at a terminal reaches `git commit` unscanned. This PR adds a `--git-precommit`
mode that scans exactly what is about to be committed, and wires it as the `.git/hooks/pre-commit` entry.

## What changed

- `secret-scanner.cjs`: new `runGitPrecommit()`. It lists the staged files, reads each file's STAGED content
  (`git show :<path>`, not the working copy), runs `scanContent()` on it and blocks the commit (exit 1) on any
  finding.
- Every staged file that can carry content is scanned. Deleted files are skipped because they have no staged
  content to read.
- New `__tests__/secret-scanner-precommit.test.js`: builds a throwaway git repo per case.

## Diff

```diff
--- a/.claude/hooks/secret-scanner.cjs
+++ b/.claude/hooks/secret-scanner.cjs
@@ -221,3 +221,48 @@ async function runClaudeHook() {
     process.exit(0);
 }

+/**
+ * Git pre-commit mode: scans staged files
+ */
+async function runGitPrecommit() {
+    const { execFileSync } = require('child_process');
+
+    let stagedFiles;
+    try {
+        stagedFiles = execFileSync(
+            'git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
+            { cwd: getProjectRoot(), encoding: 'utf8', windowsHide: true }
+        ).trim().split('\n').filter(Boolean);
+    } catch {
+        console.error('Failed to get staged files');
+        process.exit(1);
+    }
+
+    const allFindings = [];
+
+    for (const file of stagedFiles) {
+        if (shouldSkipPath(file)) continue;
+
+        // Get the staged content (not the working copy)
+        let content;
+        try {
+            content = execFileSync(
+                'git', ['show', `:${file}`],
+                { cwd: getProjectRoot(), encoding: 'utf8', windowsHide: true }
+            );
+        } catch (err) {
+            console.error(
+                `[secret-scanner] WARNING: could not read staged content for "${file}" ` +
+                `(${(err && err.message) || 'unknown error'}); skipping.`
+            );
+            continue;
+        }
+
+        allFindings.push(...scanContent(content, file));
+    }
+
+    if (allFindings.length > 0) {
+        recordScannerBlock();
+        console.error(formatFindings(allFindings));
+        console.error('\nCommit blocked. Remove secrets and try again.');
+        process.exit(1);
+    }
+
+    process.exit(0);
+}
```

```diff
--- /dev/null
+++ b/__tests__/secret-scanner-precommit.test.js
@@ -0,0 +1,52 @@
+const FAKE_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'; // built at runtime so this file is not itself a finding
+
+function precommit(repo) {
+  return spawnSync('node', [HOOK, '--git-precommit'], { cwd: repo, encoding: 'utf8' });
+}
+
+test('blocks a newly added file that contains a key', () => {
+  const repo = makeRepo();
+  fs.writeFileSync(path.join(repo, 'config.js'), `const KEY = "${FAKE_KEY}";\n`);
+  git(repo, 'add', 'config.js');
+  expect(precommit(repo).status).toBe(1);
+});
+
+test('blocks a modified file that gains a key', () => {
+  const repo = makeRepo({ 'app.js': 'const a = 1;\n' });
+  fs.appendFileSync(path.join(repo, 'app.js'), `const KEY = "${FAKE_KEY}";\n`);
+  git(repo, 'add', 'app.js');
+  expect(precommit(repo).status).toBe(1);
+});
+
+test('allows a clean commit', () => {
+  const repo = makeRepo({ 'app.js': 'const a = 1;\n' });
+  fs.appendFileSync(path.join(repo, 'app.js'), 'const b = 2;\n');
+  git(repo, 'add', 'app.js');
+  expect(precommit(repo).status).toBe(0);
+});
+
+test('does not scan a deleted file', () => {
+  const repo = makeRepo({ 'old.js': `const KEY = "${FAKE_KEY}";\n` });
+  git(repo, 'rm', 'old.js');
+  expect(precommit(repo).status).toBe(0);
+});
```

## Test result

`npm test -- secret-scanner-precommit` → 4/4 pass.
