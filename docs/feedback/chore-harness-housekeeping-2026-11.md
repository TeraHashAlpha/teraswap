# chore/harness-housekeeping-2026-11 — FEEDBACK (no PR; owner opens it)
Base: origin/main 22179224 (PR #691). Own worktree `~/ts-worktrees/harness-housekeeping`, real `npm ci`. Long tables, if any, go to `chore-harness-housekeeping-2026-11.evidence.md`.

## Checklist
- [x] Commit 0: this file
- [ ] Commit 1: AGENTS.md pin hashes CLAUDE.md without the generated state block
- [ ] Commit 2: agent-verify `--keeper` fake-install tests isolated from the real machine
- [ ] Commit 3: agent-verify and the runbook never tell an agent to install Node
- [ ] Commit 4: audit allow-list, zod renewed to 2026-12-22, uuid reachability measured
- [ ] Verify: `scripts/agent-verify.sh --codeql`, `gen-claude-state.mjs --check`, `check-agents-parity.mjs`, `audit-gate.mjs`
- [ ] Push (literal branch name, no force), compare link

## Premise differences found while reading
- `docs/feedback/chore-dependabot-alerts-2026-11.md` and its `.evidence.md` are NOT on origin/main; they live only on `origin/chore/dependabot-alerts-2026-11` (read with `git show`). Section "Allowlist proposals" there is the source for commit 4.
- The generated block (`<!-- state:begin -->` .. `<!-- state:end -->`, CLAUDE.md lines 155-179) is built from contracts (DEPLOYMENTS.md), workflow names, ADR files and test-runner commands (`gen-claude-state.mjs:6-18`). It does not read runbooks, and test counts were already removed from it. "ADR, workflow or contract added" is the accurate trigger, not "runbook".
- Cause of the four tests (read, to be reproduced in commit 2): `find_node_major` (`agent-verify.sh:209-222`) also tries the absolute `/opt/homebrew/opt/node@N/bin/node` and `/usr/local/opt/node@N/bin/node`, which the test's fake `HOME`/`PATH` cannot hide. The default Node being v26 is not the cause; installed brew `node@20`/`node@22` is. The Dependabot branch's "Verify closure" reached the same reading with `sandbox-exec`.
