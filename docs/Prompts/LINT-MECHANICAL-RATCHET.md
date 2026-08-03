NO CI-poll · read ONLY package.json, .github/workflows/ci.yml, and the files the lint JSON flags · FEEDBACK <= 1 screen

Repo TeraHashAlpha/teraswap. Fresh worktree /tmp/wt-lint-ratchet off origin/main. Prefix EVERY Bash call with `cd /tmp/wt-lint-ratchet &&` — cwd resets between calls. Run `npm ci` once first.

STEP 0 — BASELINE. `npx eslint . --max-warnings 128 ; echo "EXIT=$?"` → expect EXIT=0 and `128 problems (0 errors, 128 warnings)`. Also `npx tsc --noEmit ; echo "EXIT=$?"` — record the exit code. If either differs from expectation, STOP and report before editing anything.

CONTEXT
The lint ceiling is 128 with exactly 128 warnings — zero headroom, so the next warning introduced anywhere reds an unrelated PR. Decision: clean the mechanical warnings, then lower the ceiling to the measured post-cleanup count in the SAME PR, so the ceiling becomes a decided ratchet and the remaining debt is the real kind (react-hooks/* refactors, handled in a separate PR).

TASK — two commits
Work list = lint output only: `npx eslint . -f json > /tmp/l.json`, act ONLY on messages whose ruleId is `@typescript-eslint/no-unused-vars`, plus unused eslint-disable directives. Nothing else.

Commit 1 `chore(lint): underscore-prefix unused vars, drop orphan eslint-disables`
- Unused function args → rename with `_` prefix.
- Unused local vars / destructured bindings → `_` prefix.
- Unused import specifiers → delete the specifier; keep the statement if other specifiers remain; delete the whole line only if it becomes empty.
- Orphan eslint-disable directives → remove via `npx eslint . --fix`; this is the ONLY use of --fix. Inspect the diff afterwards and revert any hunk that is not a disable-directive removal.
Do NOT touch react-hooks/* warnings, import/no-anonymous-default-export, any logic, or any file the JSON does not flag.

Commit 2 `chore(lint): ratchet --max-warnings 128 -> <N>`
- `grep -rn "max-warnings" package.json .github/workflows/` and update EVERY occurrence to N = the exact post-cleanup count. A number expressed in several places desyncs; after this commit all occurrences must read N.

VERIFY — paste the tail of each
1. `npm run lint ; echo "EXIT=$?"` → EXIT=0 and exactly `N problems (0 errors, N warnings)`.
2. `npx eslint . --max-warnings <N-1> ; echo "EXIT=$?"` (substitute the literal number) → EXIT=1. Gate still goes red.
3. `npx tsc --noEmit ; echo "EXIT=$?"` → same exit code as baseline. Proves no rename touched a live symbol.
4. `npx vitest run <the .test.ts files you edited> ; echo "EXIT=$?"` → pass.
5. Arithmetic must reconcile and be stated: N = 128 − (warnings removed). If it does not reconcile, you changed coverage — out of scope.

STOP CONDITION
Any fix needing more than a rename or specifier-delete, any typecheck/test delta vs baseline, or arithmetic that does not reconcile → STOP, report the exact discrepancy, wait.

DELIVERY
Add spec file docs/Prompts/LINT-MECHANICAL-RATCHET.md containing this goal verbatim, committed in the same branch. Branch `chore/lint-mechanical-cleanup-ratchet`. SSH-signed commits. Push exactly `git push -u origin chore/lint-mechanical-cleanup-ratchet`. Never `:main`, never `HEAD:main`, never open a PR — the owner merges manually. Exit condition: branch pushed + compare link printed.
