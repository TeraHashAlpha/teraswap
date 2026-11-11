---
name: run-goal
description: Use when starting or resuming a /goal for a TeraSwap task — lints the goal text, picks the agent, and fixes the exit and evidence steps.
---

# Run a goal

1. **Lint the goal text first:** save it to a file and run `node scripts/goal-lint.mjs FILE`. Fix every `FAIL` line before starting
   (≤ 4000 chars, line 1 `CONTROL:`, an `Exit =` clause, no banned phrases, risky commands only on Do-NOT lines, audits say `ANY verdict`).
2. **Pick the agent** (model tiers: `docs/Prompts/_PROMPT-TEMPLATE.md` §0):
   - implementation / chore → `implementer`
   - read-only investigation → `recon`
   - audit of a PR or branch head → `auditor` (see the `audit-pr` skill)
3. **Setup:** dedicated worktree outside the repo (`${TS_WORKTREE_BASE:-$HOME/ts-worktrees}/<slug>`), branch off `origin/main`, real `npm ci`,
   `docs/feedback/<branch>.md` in the **first commit**.
4. **Verify:** `scripts/agent-verify.sh` (`--codeql` for security-relevant changes, `--keeper` when keeper code is touched). Paste the EVIDENCE block.
5. **Exit:** push the branch and report the compare link. Do not open the PR, do not poll CI, do not force-push.
   If a premise in the goal is false, ask; the owner's answer supersedes the goal text — record it in the feedback file.
