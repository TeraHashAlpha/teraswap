---
name: audit-pr
description: Use when asked to audit a PR or branch head for TeraSwap — runs the read-only auditor agent in a detached worktree and ends with a fixed VERDICT line.
---

# Audit a PR

Delegate to the **`auditor`** subagent (it has no Edit/Write and a hook that refuses `git commit|push` and `gh` writes). Give it:

- the PR number or branch, and the **full head sha** (`gh pr view N --json headRefOid`);
- the scope (files/areas) and any open findings to re-check (`docs/security/AUDIT-TOTAL.md`);
- "Exit = the report is delivered on ANY verdict."

The auditor builds only in a detached worktree (`git worktree add --detach ... <sha>`, real `npm ci`, `scripts/agent-verify.sh`, `--codeql` when the
change is security-relevant). Findings are `[C|H|M|L] path:line — title — failure scenario`; the parent re-verifies every C and H before relaying.
The report's **last line** is exactly `VERDICT: 0C/0H → approved` or `VERDICT: blocked — nC/nH`. Medium/Low never change the verdict.
