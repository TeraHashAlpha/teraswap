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

## Round 3 — A77 fixes (blocked 0C/4H): 4 SSH-signed commits on top of 60bf973, no force-push
- [x] C1 d242a31 · [x] C2 19aa99c · [x] C3 c15c0ab · [x] C4 this commit (hash in the push report)
- **Premise gap, closed:** the A77 tables were not in the session; I asked, the owner pasted them (2026-11-11 13:22). Their rows are now `A77_TABLE_A`, `A77_H4_READONLY`, `A77_TABLE_B_*` in `scripts/agent-hooks.test.mjs` (46 Table A rows refused, 9 H-4 rows refused for recon/auditor, 19 Table B rows allowed for all agents, 18 for auditor/recon). Two rows were NOT satisfied by the first push and are fixed in the next commit: `node -e` naming `.env` (now refused via an interpreter-text check; `process.env.HOME` stays allowed) and read-only `git fetch a:b` (now refused). The owner accepted "via an npm script / script file" as runbook-only.
- **Corrections to §3/§5 above:** the read-only hook is in `settings.json` keyed on `agent_type` (not frontmatter); the branch is 26 files vs origin/main, not 20/22.

**1. Finding → commit → test.** H-1/H-2/H-3 ordinary spellings bypass the pattern denies → C1 `command-guard.mjs` + `shell-parse.mjs` + settings wiring → Table A/B + fail-closed tests in `agent-hooks.test.mjs`. H-4/M-1/M-2 read-only guard flat, frontmatter-only, verbs missing → C2 → 101 refused / 66 allowed + `agent_type` protocol tests. M-3 `npx --no-install`, M-4 compare link, M-5 CodeQL by rule+file+message, lows (UTF-8 bytes, Do-NOT shapes) → C3 → `agent-verify.test.mjs`, `goal-lint.test.mjs`. `gh api *-X*` matched any path containing `-X` → C1 (patterns now anchor on a word start; test pins it). MultiEdit dropped → C1.

**2. Tables after the fix** (full lists: `TABLE_A`/`TABLE_B` in `scripts/agent-hooks.test.mjs`). **A, refused (262):** ssh-family 41 · pm2 8 · security 5 · cast/forge 16 · push force 48 · push delete 10 · git credential/alias 6 · gh pr 28 · gh api 29 · npm audit fix 13 · .env 34 · history 15 · bare shell 9. **B, allowed (125):** `git commit -m "… push --force …"`, `grep -rn "git push" docs`, `git push -u origin chore/x`, `gh pr view|diff|checks|list|status`, `gh api` GET (also `-X GET`, a path containing `-X`), `cast call`, `forge test`, `.env.example`, quoted mentions.
Live (nested `claude -p`, haiku): recon `git pull -h` → refused by readonly-guard, `git status --short` → ran; implementer `env gh pr create --help` → refused by command-guard (a spelling the patterns miss), `git log --oneline -1` → ran. A `-uf` push probe was declined by the model, not the hook: not counted. Re-run at 7ca93bc: recon `git pull -h` → refused by readonly-guard, `git status --short` → ran; implementer `git log --oneline -1` → ran; implementer `node -e ….env…` was declined by the model, so the exact settings command (`node …/command-guard.mjs || exit 2`, fed that Bash call) was run directly: exit 2 "`.env` named inside an interpreter program"; `git log` through it → exit 0.

**3. Still depends on prose.** Everything under "What this cannot stop" in the runbook: scripts/interpreters (`node -e`, `python`, `bash x.sh`), aliases and functions, names built from variables, Bash-redirect writes by recon/auditor, `grep -r` over a dir holding `.env`, non-Bash tools. Backstops: main protection, owner-only merges, signed commits.
Decisions to confirm: `git push` args that start with an expansion are refused; refused beyond the list: `git credential*`, `forge create/--resume`, `cast rpc eth_send*`, `gh alias|codespace`, `-c alias.|credential.|core.sshCommand`, `git add|rm|mv` for read-only agents; `cast … send|s|publish` in any position and `awk '/.env/'` over-refuse. Findings: `npx --no-install` still resolves a copy from npx's cache (measured) → also require `node_modules/.bin/{vitest,tsc}`; docs say only exit 2 blocks (crash/timeout proceed) → `|| exit 2` + `onFailure: "block"`; PreToolUse has no agent-type matcher → script reads `agent_type`; macOS is case-insensitive → `GIT`, `.ENV` lower-cased. Read beyond the list: grep of `scripts/codeql-local.sh` for the SARIF path.

**4. Evidence (re-run after the A77-rows commit).** Suite 468 files / 8998 pass (`npm test`, 0 fail); `check:bash3-compat` OK (4 files); `gen-claude-state.mjs --check` current (no regen needed); eslint on the touched files clean; diff 26 files vs origin/main (5 commits); compare https://github.com/TeraHashAlpha/teraswap/compare/main...chore/agent-harness (no PR opened). Not re-run: `agent-verify.sh --keeper` (Node 20/22 absent here).

## Round 4 — A77b fixes (0C/3H): 4 signed commits on 962a533, no force-push
**Premise gap, CLOSED 15:13:** the owner pasted the A77b report; every probe in it is now a test (`A77b report probes`, exit 2/0 through both hooks for main, implementer, recon, auditor). Report vs. my reconstruction: one gap (M-6 second clause, a write verb after the action: `gh pr view 5 merge` passed) fixed; `gh pr checkout` is allowed for recon/auditor too, as the report lists it. Docs re-read: `Edit()` covers Write, `ask` is denied in `-p`, only exit 2 blocks, `agent_type` confirmed.

**1. Finding → commit → test** (`scripts/agent-hooks.test.mjs`)
- H-6, H-7, M-6, M-8, M-9 → 3ffae67 → `allow-list: gh|cast|forge|git`, `A77b M-6`
- H-5, M-10, lows → code in 3ffae67, tests + `settings.json` `ask` in c70c80e → `A77b H-5|M-10|lows`
- M-7 → parser 3ffae67, test c70c80e · runbook/agent files → c081a0f → `runbook (A77b …)` · 184cb57 count fix
- Bugs the tests caught: `>>` target left as an argument; `[` made an invalid glob; `cd .claude/hooks && echo x > a.mjs`.

**2. Allow-lists** (full tables: runbook "Allow-lists")
- gh: `pr view|diff|checks|list|status|checkout`, `run view|list`, `repo view`, `issue view|list`, `api` GET; only `-R` before the command (48 unlisted refused)
- cast: read subcommands + `<≤3 words> --help` (34 refused); forge: no `--broadcast|--resume|create` (20)
- recon/auditor git: the goal's list, no `-c`/`--output` (73 refused)
- Report-driven: a write verb after the action is refused (`gh pr view 5 merge`); `commit` stays refused for recon/auditor by design (heredoc test runs for main/implementer).
- To confirm: now refused `gh auth status|release|workflow|codeql`, `git merge-base|rev-list|stash list|remote get-url`; added `gh --version`, `config --get-all`.

**Reads (disclosed):** hooks, settings, tests, runbook and this file were read before editing; `scripts/agent-verify.sh`, `scripts/goal-lint.mjs`, `agents/implementer.md`, `launch.json` and `skills/*` only after the stop hook flagged it. No conflict: `agent-verify.sh` runs `git merge-base` and `gh codeql` inside the script (the guard sees only `bash scripts/agent-verify.sh`; a direct `gh codeql` by an agent is now refused), and `audit-pr`/`run-goal` use only permitted forms (`gh pr view`, `git worktree add --detach`).

**3. Still prose:** scripts/interpreters, aliases, run-time names and env prefixes, recursive reads, exotic wrappers, redirect writes by recon/auditor outside `.claude/`, non-Bash tools (runbook "What this cannot stop").

**4. Evidence:** `npm test` 468 files / 9561 pass (re-run after the report); bash3-compat OK; `gen-claude-state --check` current; parity OK; live nested `claude -p --agent X --model haiku` at 1c95e00, one denied + one allowed per type: recon `git rev-list --count HEAD` → refused (readonly-guard, not on the allow-list) / `git log --oneline -1` → ran; auditor `git merge-base HEAD origin/main` → refused (readonly-guard) / `git status --short` → ran; implementer `gh pr -t view merge 5` → refused (command-guard) / `git log --oneline -1` → ran. (Write commands were declined by recon's own model 3 times before this, so an unlisted read was used.) `--keeper` not run (no Node 20/22). `git diff --stat origin/main`: 26 files, +3411/−4. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/agent-harness

## Round 5 — A77c fixes (0C/4H, all parser gaps): new commits on 05379a3, no force-push
- [x] C1 layer 0 raw-text scan · [x] C2 parser fails closed · [ ] C3 read-only git cannot move refs · [ ] C4 runbook and lows
- **Premise, applied conservatively (not asked: the goal's "in its new form" covers it):** layer 0 refuses by design some rows the earlier tables allowed (a quoted `.env` / `ssh` / `cast send` in a `grep` pattern, `test -f .env.local`, `ls .env*`, `cast send --help`, `gh api -X GET`, `which ssh`, `git add .claude/hooks/x`, `cd .claude && ls`). Each was moved to a refused list or rewritten to a form without the word; list in the evidence block.
