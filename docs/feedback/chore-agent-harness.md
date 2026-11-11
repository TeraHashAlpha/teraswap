# Feedback — chore/agent-harness (2026-11-11, off origin/main 26623b3)

Standing agent rules become repo config. Touched only the allowed paths (+ test files under scripts/). 5 feature commits, all SSH-signed.
- [x] C1 settings.json afa6937 · [x] C2 agents+hook d31db41 · [x] C3 agent-verify 12397b8 · [x] C4 skills 7034fc7 · [x] C5 template/lint/runbook 5ee35f0

## 1. Docs checked (read via subagent; code.claude.com/docs/en/…)
permissions.md · settings.md · settings-reference.md (truncated) · sub-agents.md · hooks.md · skills.md · cli-reference.md · goal.md. Deviations from the goal text:
- Skills: docs require `<name>/SKILL.md`; flat `.md` is undocumented. Done via git mv; a real session lists all 6 skills.
- Bypass: project `defaultMode` bypass is ignored by the harness anyway → set `disableBypassPermissionsMode: "disable"`; test forbids allow/ask/widening modes.
- Bash deny is positional (`git push *` misses `git -C . push`), so every rule has a `git * push` / `gh * pr` twin; `.env` exception uses the documented `!` negation (must follow its base rule).
- Per-agent frontmatter `hooks:` IS supported → used for recon + auditor (skipped if workspace trust is not accepted).
- Tests are vitest (`scripts/*.test.mjs` run in `npm test`), not node:test. Keeper CI runs **Node 20 only** (workflow), not several versions.
- Docs-agent could not confirm `claude --agent X "/goal …"` as one interactive line; `-p --agent` + prompt verified.

## 2. settings.json (66 deny rules, 0 allow) + tests (agent-settings: 9)
Real nested session in the worktree, `--allowedTools "Bash(ssh *)"` given on purpose: `ssh -V` → **DENIED** (deny beats allow); `git status --short` → **OK**; Read `.env.example` → OK; Read `.env.canary-harness` (fake, removed) → **DENIED**.
Known evasion: `sh -c`, `git push -uf` (combined short flags), aliases — intent signal, not a sandbox.

## 3. Agents — enforced vs prose
Enforced: model/effort/tools in frontmatter; recon+auditor have no Edit/Write/NotebookEdit and a PreToolUse hook (exit 2, fail-closed). Self-test of `--agent auditor`: `git commit` and `gh pr merge` refused by the hook, file create → no tool, `git status` OK.
Prose only: worktree/`npm ci`/feedback-first/signed commits/no CI polling/ask on false premise/report format/exit clause, no writes via Bash redirects.

## 4. agent-verify at 5ee35f0 — default run PASS (suite 8350/0, lint +0/+0, tsc 0, build ok, parity 111, rpc-budget 33)
`--codeql --keeper` run: codeql PASS (head 13 / base 13 / new 0); keeper **FAIL node20:MISSING** (only Node 25 installed; script refuses to substitute — `brew install node@20`); parity FAIL once (src/ui/v2/shell/sounds-parity.test.tsx, 5 s timeout + state leak; pre-existing, untouched) → 3/3 reruns pass, default rerun PASS. Possible overlap with a stray duplicate verify run; unconfirmed.
goal-lint: good sample (CONTROL:, Exit =, ssh/pm2 only on Do-NOT) → OK 408 chars rc 0; bad sample → 5 violations rc 1 (control-line, exit-clause, "CI-poll", pm2, ssh).

## 5. diff --stat origin/main...HEAD: 20 files, +1512 / −0 (4 skill renames at 93–95%)
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/agent-harness — no PR opened.

## Owner decisions / concerns
- `scripts/*.sh` is gitignored (.gitignore:49) → `agent-verify.sh` force-added; add `!scripts/agent-verify.sh` (out of scope here).
- goal-lint rejects "CI-poll" literally, but `_PROMPT-TEMPLATE.md` §1 CONTROL says "NO CI-poll"; this goal's line 1 also lacks `CONTROL:`. Template edit needed (out of scope).
- Read beyond the allow-list: `keeper-tests.yml` (grep/sed of run/node-version lines), `.gitignore` 44–56, import lines of 2 scripts tests, `git ls-files` name greps.
- Slip: one stray `git stash` of staged work; popped immediately, nothing lost.

## Round 2 — owner decisions (2026-11-11), 2 commits on top of faf07d6
- [x] D1 `.gitignore`: added `!scripts/agent-verify.sh` (only that line); `git check-ignore` now exits 1 (not ignored).
- [x] D2 `_PROMPT-TEMPLATE.md` "NO CI-poll" → "NO CI polling" (2 places, nothing else); its CONTROL block now passes goal-lint (OK 360 chars). Rule kept; CONTROL: is now checked on the FIRST NON-EMPTY line (+tests).
- [x] D3 `--keeper`: Node majors = ci.yml `keeper-suite` job (22) ∪ keeper-tests.yml (20); looked up via PATH, brew, nvm, fnm, volta; missing = FAIL, never substituted, one line `install: brew install node@20 node@22` (only missing majors). Fake-install tests (pass, fnm layouts, missing, failing) added. This Mac: both missing → FAIL by design; nothing installed without asking. Corrects "Node 20 only" in §1.
- Verified: agent-verify/goal-lint/settings/hooks tests 106 pass; check:bash3-compat, check:product-claims OK. Full `agent-verify.sh` NOT re-run (keeper cannot pass here); §4 results stand for 5ee35f0.
- diff --stat origin/main...HEAD: 22 files, +1642 / −2 (the 2 deletions = the template's two edited lines)
