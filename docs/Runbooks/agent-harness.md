# Agent harness — standing rules as repo configuration

> Owner's standing rules for coding agents live in `.claude/**` and a few scripts, not in prose repeated in every `/goal`.
> Schema checked against the current Claude Code docs on 2026-11-11 (see `docs/feedback/chore-agent-harness.md`).
> Related: `CLAUDE.md` (normative), `AGENTS.md` (Grok parity), `docs/Prompts/_PROMPT-TEMPLATE.md` (goal shape).

## Pieces

| Piece | What it does | Enforced by tooling | Stays prose (agent discipline) |
|---|---|---|---|
| `.claude/settings.json` | `permissions.deny` for `ssh`/`scp`/`ssh-add`/`pm2`/`cast send`/keychain `security`/`git credential*`, every force-push form, `gh pr create\|merge\|ready\|close`, `gh api` writes, `npm audit fix`, shell-history files, `.env*` read/edit (except `.env.example`). No `allow`, bypass mode disabled | deny beats any allow (docs: "deny, then ask, then allow") | Deny rules match the command text, so `sh -c '…'`, `-uf`-style combined flags and aliases can evade them — an intent signal, not a sandbox (same lesson as `GROK-DENY-CANARY-2026-08-28`) |
| `scripts/agent-settings.test.mjs` | Fails if a required deny is missing, an `allow`/bypass appears, or a deny is so broad it blocks `git commit/push`, `npm ci/test/build`, `gh pr view`, foundry | `npm test` | — |
| `.claude/agents/implementer.md` | Sonnet, full edit tools; rules: dedicated worktree, real `npm ci`, feedback in first commit, SSH-signed noreply, no CI polling, no force-push, no PR, ask on false premise, fixed REPORT, exit clause | tool list + settings deny | everything behavioural |
| `.claude/agents/recon.md` | Haiku, no Edit/Write/NotebookEdit, PreToolUse guard hook | tools + hook | no writes through Bash redirects |
| `.claude/agents/auditor.md` | Opus, no Edit/Write/NotebookEdit, guard hook, detached worktree for build/test, `C/H/M/L` with `file:line`, last line `VERDICT: …`, the report is the exit | tools + hook | detached-worktree discipline, verdict format |
| `.claude/hooks/readonly-guard.mjs` | PreToolUse hook (exit 2 = block) refusing `git commit\|push\|merge\|rebase\|tag\|reset\|…` and any `gh` outside a read list. Fails closed | hook | `bash -c`/`eval`/aliases can evade it |
| `scripts/agent-verify.sh` | One command → fixed EVIDENCE block: suite, lint delta, tsc, build, v1/v2 parity, rpc-budget; `--codeql` (full security-extended, head vs base), `--keeper` (CI's Node majors). Failure or missing tool = FAIL + non-zero exit. Never polls CI, never prints env values | script | pasting the block verbatim |
| `scripts/goal-lint.mjs FILE` | Lints a `/goal` text: ≤ 4000 chars, first non-empty line `CONTROL:`, has `Exit =`, no `no Monitor` / `CI-poll`, `pm2`/`ssh`/`cast send` only on Do-NOT lines, audit goals (`READ-ONLY`) say `ANY verdict` | script | — |
| `.claude/skills/*/SKILL.md` | `adapter`, `api-route`, `security-fix`, `supabase-migration` (moved from flat files, content unchanged), plus `run-goal`, `audit-pr` | harness loads them | — |
| `.github/pull_request_template.md` | what/why, evidence block, "Auditor required?", feedback path — for the owner's DRAFT PR | — | — |

## Start an agent with a goal (one line each)

Run from the main checkout (so project settings and hooks apply); the agent creates its own worktree. Lint first:

```sh
# implementer — implementation / chore
node scripts/goal-lint.mjs goal.md && claude --agent implementer "/goal $(cat goal.md)"
# recon — read-only investigation
node scripts/goal-lint.mjs goal.md && claude --agent recon "/goal $(cat goal.md)"
# auditor — read-only audit of a PR/branch head (goal must say READ-ONLY and ANY verdict)
node scripts/goal-lint.mjs goal.md && claude --agent auditor "/goal $(cat goal.md)"
```

Unattended: `claude -p --agent <name> "$(cat goal.md)"` (verified for `--agent` + prompt). The interactive `--agent <name> "/goal …"` form is the documented
`--agent` flag plus an initial prompt; the docs show no combined example — if it misbehaves, start `claude --agent <name>` and paste `/goal …`.
Override the model for a task with `--model` (fund-flow/contract/gate work → Opus; see `_PROMPT-TEMPLATE.md` §0).

## Verify and audit

```sh
scripts/agent-verify.sh                    # default checks
scripts/agent-verify.sh --codeql --keeper  # security-relevant or keeper changes
```

`--keeper` runs the keeper suite on every Node major CI uses (22 in `ci.yml`'s `keeper-suite` job, 20 in `keeper-tests.yml`), looked up via PATH, brew, nvm, fnm and volta. A missing major is FAIL with a one-line `brew install node@N …` hint; it never substitutes another version
(local Node 25 hides cancelled tests). `--codeql` needs `gh extension install github/gh-codeql`.

## Known gaps / owner decisions

- `scripts/*.sh` is gitignored (`.gitignore:49`); `agent-verify.sh` now has a `!scripts/agent-verify.sh` exception (like grok-dispatch/guard), so it is no longer force-add only.
- `_PROMPT-TEMPLATE.md` §1's CONTROL header used to say `NO CI-poll`, which `goal-lint` rejects; the template now says `NO CI polling` (owner decision 2026-11-11).
- Subagent frontmatter hooks need the folder's workspace trust accepted, otherwise they are skipped (docs).
- When Claude Code changes the schema, update `.claude/**` and re-run `npm test` (the tests pin the contract).
