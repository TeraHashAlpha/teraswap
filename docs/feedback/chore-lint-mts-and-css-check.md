# chore/lint-mts-and-css-check — feedback

## Owner answers (asked once, 2026-11-26, before building; they supersede the goal text)
1. lint-delta: run `npm run lint` itself on HEAD and on a merge-base worktree (HEAD's `node_modules` linked); same pass rule
   (errors and warnings delta <= 0); files deleted by the branch do not offset; a crash on either side is FAIL "lint crashed";
   FAIL too if `npm run lint` fails on HEAD.
2. Premise false: no line in CLAUDE.md / AGENTS.md lists agent-verify's checks. Add one line to both.

## Tasks
- [ ] A. lint config: `.mts` / `.cts` / `.d.mts` / `.d.cts` as `.ts`
- [ ] B. lint-delta: CI's command, crash = FAIL, stub-eslint test
- [ ] C. v1 stylesheet check: script, fixtures, tests, agent-verify + CI build step
- [ ] D. CLAUDE.md + AGENTS.md line, state block
- [ ] Evidence 1-4, one `agent-verify --codeql` run, push
