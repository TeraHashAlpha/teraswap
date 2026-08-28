## Feedback — FIX-GROK-GUARD-CLAIMS (commit 1)

### Note
`.github/workflows/ci.yml`'s `full-suite` job now installs zsh (`sudo apt-get install -y zsh`) before `npm
ci`. `scripts/grok-guard.test.mjs` prints `grok-guard.test.mjs shell legs: bash=RUN, zsh=RUN` (or `SKIPPED
(binary not found on PATH)` per-shell) unconditionally, and a missing shell now produces a named
`vitest.skip` entry (visible with a ↓ marker) instead of just not existing — verified locally by pointing
`PATH` at a directory with no `zsh` binary and confirming the skip line appears.

## Feedback — FIX-GROK-GUARD-CLAIMS (commit 4)

### Security concern (the reason this PR exists)
The `--deny` flags PR #433 shipped are not enforcement — see `docs/security/GROK-DENY-CANARY-2026-08-28.md`.
The real fix is this commit: `scripts/grok-dispatch.sh` now refuses to resolve a worktree base dir under the
repo root, in both `--dry-run` and `--execute`, before anything else runs (a config error, not a per-spec
judgment call — same early-exit shape as "spec file not found"). Verified manually:

```bash
# default (no override) resolves outside the repo:
./scripts/grok-dispatch.sh <spec> <branch> --dry-run   # worktree: /Users/<user>/ts-worktrees/<branch>

# an in-repo override is rejected outright, even in --dry-run:
TS_WORKTREE_BASE="$(pwd)/.claude/worktrees" ./scripts/grok-dispatch.sh <spec> <branch> --dry-run  # exit 1
```

Also confirmed directly (not just asserted) that a fresh `git worktree add` outside the repo holds only
tracked files — a scratch worktree at `/tmp/ts-worktrees-test/...` contained `.env.example` and nothing else
matching `.env*`, matching the goal's claim about the existing `chore-grok-dispatch` worktree.

### Edge case
The old worktree-targeting test (`grok-dispatch.test.mjs`, "worktree targeting" describe block) asserted the
worktree path contained `.claude/worktrees/` — the exact thing this fix removes. Replaced with four tests:
default base dir outside the repo (positive), an in-repo `TS_WORKTREE_BASE` rejected (negative), the same
rejection at the exact-equality boundary (negative), and a custom outside-the-repo `TS_WORKTREE_BASE` honored
(positive). The negative-control probes use this test file's own computed `REPO_ROOT` (the worktree the test
suite happens to run from) rather than trying to independently recompute the script's internal `MAIN_ROOT` —
since every git worktree of this repo nests under the same main checkout, any path under `REPO_ROOT` is also
under `MAIN_ROOT`, so the probe is valid regardless of which worktree the test suite runs from.
