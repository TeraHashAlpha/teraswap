# Agent harness — standing rules as repository configuration

> Owner's standing rules for coding agents live in `.claude/**` and a few scripts, not in prose repeated in every `/goal`.
> Schema checked against the current Claude Code docs (hooks, sub-agents, permissions) on 2026-11-11; evidence in `docs/feedback/chore-agent-harness.md`.
> Related: `CLAUDE.md` (normative), `AGENTS.md` (Grok parity), `docs/Prompts/_PROMPT-TEMPLATE.md` (goal shape).

## What is enforced, and where

Two layers, both in `.claude/settings.json`. A refusal in either one stops the call (a hook's exit 2 stops it before permission rules are evaluated; `permissions.deny` beats any allow).

| Piece | What it does | Enforced by tooling | Stays prose (agent discipline) |
|---|---|---|---|
| `.claude/hooks/command-guard.mjs` + `shell-parse.mjs` | PreToolUse hook on `Bash` for EVERY session and agent. Tokenises the command (splits on `&&` `\|\|` `;` `\|` newlines, strips quotes, backslashes, `env`, `command`, `VAR=x`, `sudo`, `timeout`, `xargs`, `npx X`, reduces argv0 to its lower-cased basename, recurses into `sh\|bash\|zsh -c`, `eval`, `$( )`, backticks, `find -exec`) and refuses: `ssh` `scp` `sftp` `ssh-add` and `rsync` over ssh; `pm2`; keychain `security`; `git credential*`; `cast send\|publish`; `forge … --broadcast`; every `git push` force form (`-f` inside combined flags, `--force*`, `+refspec`, `--mirror`) and remote delete (`--delete`, `-d`, `:ref`, `--prune`); every `gh pr` subcommand except `view diff checks list status`; `gh api` unless provably a GET; `npm audit … fix`; any argument whose basename is `.env` or `.env.*` (except `.env.example`); `history`, `fc` and shell-history files. A quoted mention (commit message, grep pattern) is not an access | the hook | what is listed under "What this cannot stop" |
| `.claude/hooks/readonly-guard.mjs` | PreToolUse hook on `Bash`, acts only when the hook input's `agent_type` is `recon` or `auditor` (the docs give PreToolUse no agent-type matcher; the script keys on the field). On top of the guard above it refuses `commit push pull am cherry-pick rebase revert tag config clean restore reset stash add rm mv`, `merge` without `--no-commit`, `checkout -b`, `switch -c`, `fetch` with a refspec or scp-style remote (`origin a:b`, `a:b`), `branch` writes, `remote` writes and every `gh` command not on a read list. Allows `merge --no-commit`, `gh pr checks`, `git worktree add\|remove`, and quoted mentions | the hook | writes through Bash itself |
| `.claude/settings.json` | `permissions.deny` patterns (second layer) for the same families, `.env*` and history files for the Read/Edit tools, no `allow`, bypass mode disabled; the two hooks, each run as `node … \|\| exit 2` with `onFailure: "block"` because the docs say any other exit code, a crash or a timeout lets the call proceed | Claude Code | — |
| `scripts/agent-settings.test.mjs`, `scripts/agent-hooks.test.mjs` | Table-driven: Table A (spellings that must be refused), Table B (actions that must stay allowed), the fail-closed protocol, the wiring in `settings.json` | `npm test` | — |
| `.claude/agents/implementer.md` | Sonnet, full edit tools; rules: dedicated worktree, real `npm ci`, feedback in first commit, SSH-signed noreply, no CI polling, no force-push, no PR, ask on false premise, fixed REPORT, exit clause | tool list + the two layers | everything behavioural |
| `.claude/agents/recon.md`, `auditor.md` | Haiku / Opus, no Edit/Write/NotebookEdit; auditor ends with a `VERDICT:` line and detaches a worktree for build/test. They carry no hook of their own (frontmatter hooks are skipped without workspace trust) | tool list + `readonly-guard.mjs` | no writes through Bash redirects, detached-worktree discipline, verdict format |
| `scripts/agent-verify.sh` | One command, fixed EVIDENCE block: suite, lint delta, tsc, build, v1/v2 parity, rpc-budget; `--codeql` (alerts compared by rule + file + message, head vs base), `--keeper` (CI's Node majors). Missing tool or project-local `vitest`/`tsc` = FAIL; `npx --no-install` only. Compare link only for a github.com origin, never credentials. Never polls CI | script | pasting the block verbatim |
| `scripts/goal-lint.mjs goal.md` | Lints a `/goal`: ≤ 4000 BYTES (as `wc -c`), first non-empty line `CONTROL:`, has `Exit =`, no `no Monitor` / `CI-poll`, `pm2`/`ssh`/`cast send` only on Do-NOT lines (`Do NOT …`, `1. Do NOT …`, `- [ ] Do NOT …`, or under a `Do NOT:` label), audit goals (`READ-ONLY`) say `ANY verdict` | script | — |
| `.claude/skills/*/SKILL.md`, `.github/pull_request_template.md` | project skills; the owner's DRAFT PR template | harness loads them | — |

## Start an agent with a goal

Run from the main checkout (so project settings and hooks apply); the agent creates its own worktree. Lint first, then start:

```sh
node scripts/goal-lint.mjs goal.md && claude --agent implementer "/goal $(cat goal.md)"
node scripts/goal-lint.mjs goal.md && claude --agent recon "/goal $(cat goal.md)"
node scripts/goal-lint.mjs goal.md && claude --agent auditor "/goal $(cat goal.md)"
claude -p --agent implementer "$(cat goal.md)"
```

Lines 1-3: interactive, for implementation, read-only recon, and read-only audit (the goal must say `READ-ONLY` and `ANY verdict`). Line 4: unattended; `-p --agent` plus a prompt is verified. If the interactive form misbehaves, start `claude --agent implementer` and paste `/goal …`. Override the model with `--model opus` for fund-flow, contract or gate work (`_PROMPT-TEMPLATE.md` §0).

## Verify and audit

```sh
scripts/agent-verify.sh
scripts/agent-verify.sh --codeql --keeper
```

`--keeper` runs the keeper suite on every Node major CI uses (22 in `ci.yml`'s `keeper-suite` job, 20 in `keeper-tests.yml`), looked up via PATH, brew, nvm, fnm and volta. A missing major is FAIL with the line `install: brew install node@20 node@22` (only the missing ones); it never substitutes another version. `--codeql` needs `gh extension install github/gh-codeql`.

## What this cannot stop

The guards read the command text the agent sends to the Bash tool. They are an accident-and-drift barrier, not a sandbox. Still possible:

- **Commands hidden in a script file or an interpreter.** `bash script.sh`, `source f`, `npm run x`, `make`, `node -e '…'`, `python3 -c '…'`, `perl -e`, a git hook, a `package.json` script. The guard sees `node` or `python3`, not what it runs; the one exception is a `.env*` or shell-history file named inside an interpreter's own arguments (`node -e "…readFileSync('.env')…"`), which is refused. The A77 auditor accepted this residual for "via an npm script" and "via a script file".
- **Aliases and shell functions.** One defined in the agent's own command line (`alias p='git push -f'; p`) or in the owner's shell/git config (`alias.*`). `git -c alias.*=` and `gh alias` are refused; existing aliases are not known to the guard.
- **Names built at run time.** A command name or flag assembled by `$VAR`, brace expansion or globbing (`/usr/bin/s*h`). A bare-expansion command name, `eval "$X"`, `sh -c "$X"`, and a `git push` argument starting with an expansion are refused; the rest is not.
- **Writes by the read-only agents through Bash itself.** Redirects (`echo x > f`), `tee`, `sed -i`, `cp`, `mv`, `rm`. `recon` and `auditor` have no Edit/Write tools; the rest is prose in their agent files.
- **Reads that never name the file.** `grep -r KEY .`, or `find . -type f -exec cat {} +` over a directory holding a `.env`. The `Read(.env*)` / `Edit(.env*)` deny rules cover the Read and Edit tools only.
- **Anything that is not the Bash tool.** MCP tools, `WebFetch`, the Edit/Write tools of the implementer.
- **Other callers of the same binary.** `ssh` reached through `git` (a `core.sshCommand` set in a config file the agent edited), scripts started by `npm` lifecycle hooks.

The backstops are outside this config: `main` branch protection (CI green required, unsigned commits rejected: CLAUDE.md "Do NOT" #11, #12), owner-only merges and PR creation (#14), SSH-signed commits, and secrets that are not in the agent's worktree (`scripts/grok-dispatch.sh` creates it outside the repo). A mistake the guards miss should still be stopped there; anything that must hold belongs in GitHub settings, not here.

## Known gaps / owner decisions

- The guard fails closed: if `node` itself is missing, every Bash call is blocked. That is intended.
- `git push` with an argument that begins with an expansion (`git push origin "$BRANCH"`) is refused: write the branch literally.
- Subagent frontmatter hooks need the folder's workspace trust accepted, otherwise they are skipped (docs). That is why the read-only guard now lives in `settings.json`.
- When Claude Code changes the hook or permission schema, update `.claude/**` and re-run `npm test`; the tests pin the contract.
