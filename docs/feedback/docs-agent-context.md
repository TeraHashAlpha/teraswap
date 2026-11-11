# Feedback — docs/agent-context

Goal: make agent context true again and keep it true. Three commits after this one. Rule for every sentence put
in a context file: measured at origin/main (26623b3), and named here with the file:line or command that proves it.
Anything unproven goes under "Not verified", never into the file. NO CI polling. No PR (owner opens it).

## Checklist
- [x] Worktree `~/ts-worktrees/docs-agent-context` off origin/main 26623b3, real `npm ci`, SSH-signed noreply committer
- [x] C1 root CLAUDE.md true again (header, Stack, Key references, Current state, Conventions); AGENTS.md pin regenerated
- [x] C2 scoped CLAUDE.md x3, <= 40 lines each, every rule cites its source
- [ ] C3 `scripts/gen-claude-state.mjs` (+ test) + ONE ci.yml step running `--check`
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, build, `check:agents-parity`
- [ ] Evidence 1-4 written here (<= 1 screen), branch pushed, compare link reported
