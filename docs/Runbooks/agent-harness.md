# Agent harness — standing rules as repository configuration

> Owner's standing rules for coding agents live in `.claude/**` and a few scripts, not in prose repeated in every `/goal`.
> Schema checked against the current Claude Code docs (hooks, sub-agents, permissions) on 2026-11-11; evidence in `docs/feedback/chore-agent-harness.md`.
> Related: `CLAUDE.md` (normative), `AGENTS.md` (Grok parity), `docs/Prompts/_PROMPT-TEMPLATE.md` (goal shape).

## What is enforced, and where

Three layers; a refusal in ANY of them stops the call (a hook's exit 2 stops it before permission rules are evaluated; `permissions.deny` beats any allow).
- **Layer 0, raw-text scan** (`raw-scan.mjs`): does not parse. It looks for forbidden NAMES anywhere in the command text (quotes and backslashes removed), so a parser gap cannot hide them. It over-refuses on purpose; one exemption (below).
- **Layer 1, parser and rules** (`shell-parse.mjs`, `command-guard.mjs`, `readonly-guard.mjs`): tokenises, unwraps `sh -c` / `eval` / `$( )` / wrappers and decides on argv. Anything it cannot classify (unterminated quote, unknown redirection operator, nesting deeper than 3) is refused, naming the construct.
- **Layer 2, `permissions.deny` patterns** in `settings.json`: Claude Code's own positional matcher, kept as the last line and as the only one for the Read and Edit tools.
- Layers 0 and 1 are one hook per file, each run as `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<file>.mjs" \|\| exit 2` with `onFailure: "block"`, so a crash or a timeout blocks too.

| Piece | What it does | Enforced by tooling | Stays prose (agent discipline) |
|---|---|---|---|
| `.claude/hooks/command-guard.mjs` + `shell-parse.mjs` + `raw-scan.mjs` | PreToolUse hook on `Bash` for EVERY session and agent. Layer 0 (next section) runs first, then layer 1, which tokenises the command (splits on `&&` `\|\|` `;` `\|` newlines and at unquoted `<` `>` `>\|` `>&`, strips quotes, backslashes, `env`, `command`, `VAR=x`, `sudo`, `timeout` and the GNU names `gtimeout` `gnice` `gnohup` `gstdbuf` `gtime` `gxargs` `genv`, `arch`, `nocorrect`, `xargs`, `npx X` / `pnpm X` / `yarn X` / `bunx X`, reduces argv0 to its lower-cased basename, recurses into `sh\|bash\|zsh\|csh\|tcsh\|fish -c`, `eval`, `$( )` (heredoc bodies skipped), backticks, `find -exec`, the operand of `<<<`). **Allow-lists** (below) for `gh`, `cast`, `forge`. **Deny rules** for: `ssh` `scp` `sftp` `ssh-add` `ssh-copy-id` and `rsync` over ssh; `pm2`; keychain `security`; `git credential*` and `git-credential-*`; every `git push` force / mirror (any abbreviation, or via `-c`/`git config remote.*.mirror`) / delete form; `npm audit fix`; `script` and `coproc`; any word or redirect target (of every command, compound closers and wrappers included) whose basename is `.env` or `.env.*` (except `.env.example`, and except for `test`, `[`, `[[`, `ls`, which only name files), shell-history files by name, glob, brace or `$HISTFILE`; and writes to the harness itself (`.claude/settings*.json`, `.claude/hooks/`, paths normalised against the hook's `cwd` and any `cd`: `>` `>>` `>\|` `tee` `rm` `mv` `cp` `sed -i` `truncate` `chmod` `curl -o` `tar` `unzip` `find -delete` `git checkout\|restore\|rm`). This parser treats a quoted mention (commit message, grep pattern) as data, but layer 0 still refuses the words outside a lone `git commit` | the hook | what is listed under "What this cannot stop" |
| `.claude/hooks/readonly-guard.mjs` | PreToolUse hook on `Bash`, acts only when the hook input's `agent_type` is `recon` or `auditor` (the docs give PreToolUse no agent-type matcher; the script keys on the field). On top of the guard above, `git` is an **allow-list** for them (below). Its parser reads quoted mentions as data (layer 0, in the other hook, still refuses the words) | the hook | writes through Bash itself |
| `.claude/settings.json` | `permissions.deny` patterns (layer 2) for the same families, `.env*` and history files for the Read/Edit tools, `permissions.ask` on `Edit(/.claude/settings*.json)` and `Edit(/.claude/hooks/**)` (project and `~/.claude`; the docs: an `Edit` rule covers Write, and an `ask` call is denied in `claude -p`), no `allow`, bypass mode disabled; the two hooks, each run as `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<file>.mjs" \|\| exit 2` with `onFailure: "block"` because the docs say any other exit code, a crash or a timeout lets the call proceed | Claude Code | — |
| `scripts/agent-settings.test.mjs`, `scripts/agent-hooks.test.mjs` | Table-driven: Table A (spellings that must be refused), Table B (actions that must stay allowed), the fail-closed protocol, the wiring in `settings.json` | `npm test` | — |
| `.claude/agents/implementer.md` | Sonnet, full edit tools; rules: dedicated worktree, real `npm ci`, feedback in first commit, SSH-signed noreply, no CI polling, no force-push, no PR, ask on false premise, fixed REPORT, exit clause | tool list + the two layers | everything behavioural |
| `.claude/agents/recon.md`, `auditor.md` | Haiku / Opus, no Edit/Write/NotebookEdit; auditor ends with a `VERDICT:` line and detaches a worktree for build/test. They carry no hook of their own (frontmatter hooks are skipped without workspace trust) | tool list + `readonly-guard.mjs` | no writes through Bash redirects, detached-worktree discipline, verdict format |
| `scripts/agent-verify.sh` | One command, fixed EVIDENCE block: suite, lint delta, tsc, build, v1/v2 parity, rpc-budget; `--codeql` (alerts compared by rule + file + message, head vs base), `--keeper` (CI's Node majors). Missing tool or project-local `vitest`/`tsc` = FAIL; `npx --no-install` only. Compare link only for a github.com origin, never credentials. Never polls CI | script | pasting the block verbatim |
| `scripts/goal-lint.mjs goal.md` | Lints a `/goal`: ≤ 4000 BYTES (as `wc -c`), first non-empty line `CONTROL:`, has `Exit =`, no `no Monitor` / `CI-poll`, `pm2`/`ssh`/`cast send` only on Do-NOT lines (`Do NOT <text>`, `1. Do NOT <text>`, `- [ ] Do NOT <text>`, or under a `Do NOT:` label), audit goals (`READ-ONLY`) say `ANY verdict` | script | — |
| `.claude/skills/*/SKILL.md`, `.github/pull_request_template.md` | project skills; the owner's DRAFT PR template | harness loads them | — |

## Layer 0 — the raw-text scan

Runs first on the whole command: lower-cased, quotes and backslashes removed, whitespace collapsed, `//` and `/./` folded (`C"a"t  .E\nv` is `cat .env`). No tokenising, so it does not matter how the shell would have split, quoted or nested the words. It refuses when the text contains:

| Rule | Text it refuses |
|---|---|
| env | `.env` or `.env.<anything>` except the tracked templates `.env.example` and `.env.<name>.example` (`.env.executor.example`; `.env.example.bak` is not one), also glued to a flag (`base64 -i.env`, `grep -f.env`). `process.env.HOME`, `os.environ`, `import.meta.env` and `src/env.ts` pass |
| harness | `.claude/settings`, `.claude/hooks`, a glob that can match `.claude` (`.cl*`, `.c?aude`) or its children (`.claude/set*`), a `cd`, `pushd`, `git -C` or `--work-tree` into `.claude`, unless the whole command is a pure reader: `cat` `head` `tail` `grep` `rg` `wc` `ls` `stat` `diff` `jq` `git diff\|log\|show\|blame\|ls-files` (also after `git -C DIR`), joined by `\|` only, optionally after a leading `cd DIR &&`, with no `>` `<` `;` `&` `$` or backtick. A `cd` or `-C` INTO `.claude` is never a read |
| credentials | `gh` with `auth`; `--show-token`; `git-credential`; `git credential` |
| cast | `cast` with `send` `publish` `mktx` `wallet` `erc20` (a variable called `$WALLET` is not the subcommand); `--broadcast` |
| push | after a `push` word, up to the next `\|` `&&` `;` or newline: `-f` or `-d` (also inside a cluster such as `-uf`), `--force*`, `--mirror`, `--delete`, `--prune` (any abbreviation), or a refspec starting ` +`, ` :` or containing `:+`. `git stash push` is not a push. The whole command is scanned instead when that tail holds `$` or a backtick, or the command uses `xargs` / `parallel` |
| gh writes | `gh` with `pr` or `api` and any of `merge` `create` `new` `ready` `close` `edit` `review` `comment` `-X` `--method` `-f` `-F` `--field` `--raw-field` `--input` `method-override`; the short flags are looked for in the pipeline segment (split at `\|`) that holds `gh`, so `gh pr diff 5 \| grep -F x` runs (whole command when that segment holds `$`, a backtick, `xargs` or `parallel`) |
| remote shells | the words `ssh` `scp` `sftp` `ssh-add` `ssh-agent` `ssh-copy-id` `pm2` (also inside a path such as `~/.ssh`); the keychain command `security` (not as a flag value: `git log --grep=security` runs); `--upload-pack`; `--receive-pack` |
| history | `zsh_history` `zhistory` `bash_history` `sh_history` `histfile` `fish_history` `python_history` `node_repl_history` `zsh_sessions` `.history` |

**The one exemption.** A lone `git commit` (flags and quoted message literals only), also right after `git add <plain words> &&`, whose message holds no `$`, backtick or `<` outside a `<<'EOF'` body may mention these words. The message literals are removed and the rest of the command (the `git add` words included) is still scanned, so `git commit -m "docs: ssh and .env"` and `git add -A && git commit -m "docs: ssh"` run, `git commit -F .env` and `git add .claude/hooks/x && git commit -m x` do not.

**It over-refuses on purpose.** A quoted mention anywhere else is refused as well: `grep -n "ssh" README.md`, `test -f .env.local`, `ls .env*`, `cast send --help`, `gh api -X GET`, `which ssh`, `git add .claude/hooks/x` (use `git add -u`), `cd .claude && ls` (use `ls .claude`), and a pipeline that mixes `push` with another tool's `-f` in ONE segment, such as `git push origin x \| tail -f log` (fine since A77d: the pipe ends the tail) but not `xargs git push -f` or `git push origin x $(tail -f log)` (an `xargs` or an expansion brings flags in from elsewhere). Phrase around it: run the two commands as two calls, or write the flag out of reach of `push` (`git push origin x` then `eslint -f json`). `git stash push -m "a + b"` passes layers 0 and 1 but layer 2's `git * push * +*` pattern cannot tell stash from push and still denies it: write `a plus b`. Or run it yourself (next-but-one section).

## Allow-lists

Two rounds of deny-lists each left new spellings, so the riskiest tools run only in the listed forms; everything else is refused. Over-refusing a rare legitimate command is accepted; under-refusing is not.

**`gh`** (all agents, read-only included). The one flag allowed before the command is `-R/--repo`; no flag may sit between command and action (`gh pr -t view merge 5` is `gh pr merge 5`: cobra takes `view` as the value of `-t`).

| Command | Permitted |
|---|---|
| `gh pr` | `view` `diff` `checks` `list` `status`; `checkout` for the implementer and the main session only (it creates or moves a local branch: `recon` and `auditor` fetch and detach instead). A write verb anywhere after the action is refused |
| `gh run` | `view` `list` |
| `gh repo` | `view` |
| `gh issue` | `view` `list` |
| `gh api` | only when provably a GET: no `-f/-F/--field/--raw-field/--input`, `-X/--method` only `GET`, no method-override header |
| `gh`, `gh --version`, `gh --help` | yes |
| everything else | refused: `auth *` (`gh auth token`, `--show-token`), `config`, `secret`, `ssh-key`, `extension`, `alias`, `codespace`, `release`, `workflow`, `search`, `status`, `pr create`, `pr merge`, `pr comment`, `pr edit`, `pr review`, and every other `pr` or `issue` action not listed above |

**`cast`** (all agents). The subcommand must be the first argument; a flag in front of it is refused.

| Permitted | Refused |
|---|---|
| `call` `balance` `block` `block-number` `tx` `receipt` `code` `storage` `chain-id` `gas-price` `nonce` `logs` `estimate` `sig` `keccak` `4byte*` `abi-*` `calldata*` `to-*` `from-*`, `--help` `--version` `-V`, and `cast <up to 3 words> --help\|-h` (so `cast send --help` works) | `send` `publish` `mktx` `erc20 transfer\|approve` `wallet` `keystore` `rpc` `run` and every alias or subcommand not listed |

**`forge`**: everything runs except `--broadcast`, `--resume`, `create` (and its alias `c`).

**`git` for `recon` and `auditor`** (the implementer and the main session are not held to this list; `-c`, `--exec-path`, `--config-env` are refused for them because they can run a command):

| Command | Permitted |
|---|---|
| `status` `log` `diff` `show` `rev-parse` `rev-list` `merge-base` `name-rev` `shortlog` `for-each-ref` `show-ref` `diff-tree` `ls-files` `ls-tree` `cat-file` `blame` `describe` | any arguments except `--output` (writes a file) |
| `stash` | `stash list` only (no `push` `pop` `drop` `clear` `apply` `save`) |
| `reflog` | `reflog`, `reflog show`, `reflog <ref>`; not `expire` `delete`, not `--output` |
| `symbolic-ref` | `symbolic-ref [-q] [--short] [--no-recurse] <name>`; a second argument, `-d` and `-m` write |
| `verify-commit` | `[-v] [--raw] <commit>` |
| `grep` | as above, and not `-O`, `--open-files-in-pager`, `--no-index`, `--untracked` |
| `remote` | `remote`, `remote -v` |
| `branch` | no arguments, or list flags (`--list -l -a -r --show-current -v --contains --merged --points-at <commit>`); a bare name creates a branch: refused |
| `tag` | no arguments, `-l`/`--list [pattern]`, `--contains`, `--points-at` |
| `config` | `--get`, `--get-all`, `--get-regexp <key>` (optionally with a scope flag) |
| `fetch` | without a refspec (`origin`, `origin main`, `origin pull/5/head`, `--all`, `--tags`). Refused: `a:b`, `+x`, `--depth`, `--deepen`, `--shallow-*`, `--unshallow`, `--prune`, `--refmap` (shallow and prune rewrite `.git`) |
| `worktree` | `add --detach <path> [<commit>]` (`--detach` is REQUIRED: `git worktree add ../x` creates a branch named `x`; no `-b`/`-B`), `remove`, `list`. `remove --force` only where the effective directory is a linked worktree (below) |
| `checkout` | `--detach [<commit>]` only, and only where the effective directory is a linked worktree (below) |
| `merge` | `--no-commit --no-ff <commit>` (both REQUIRED: a fast-forward moves the checked-out branch; `--ff` and `--ff-only` refused) only where the effective directory is a linked worktree (below); `--abort`, `--quit` anywhere |
| everything else | refused: `commit push pull add rm mv reset clean stash push|pop|drop|clear restore apply rebase cherry-pick revert switch reflog expire|delete update-ref symbolic-ref <name> <ref> gc init clone submodule notes archive bundle` and every other subcommand |

## Read-only agents work in a linked worktree, never in the main checkout

A77d H-11. `recon` and `auditor` may run `git checkout --detach`, `git merge --no-commit --no-ff` and `git worktree remove --force`, but those change the HEAD, the index or the worktrees of the checkout they run in. So `readonly-guard.mjs` looks at WHERE they run: the hook's `cwd`, moved by a LEADING `cd DIR &&` and by `git -C DIR`. If that directory is the main checkout (its `.git` is a directory) they are refused; in a linked worktree (its `.git` is a file) they run. A directory it cannot determine is refused too: no `cwd`, `cd "$X"`, a `cd` that is not a leading `cd DIR &&` (a subshell, `; cd`, `|| cd`, inside `sh -c`), `env -C`, `GIT_DIR=`, `--git-dir`, `--work-tree`. (`$CLAUDE_PROJECT_DIR` is not a rule of its own: an agent started inside a linked worktree has it set to that worktree, so the `.git` test decides.)

So the shape is: create the worktree from anywhere (`git worktree add --detach <path> <sha>` is allowed in the main checkout), then address it on every call, because Claude Code resets a `cd` that ends outside the project directory:

```sh
git worktree add --detach "$HOME/ts-worktrees/audit-x" <sha>
cd "$HOME/ts-worktrees/audit-x" && git checkout --detach <sha>      # or: git -C "$HOME/ts-worktrees/audit-x" checkout --detach <sha>
```

`git fetch` stays allowed everywhere: it updates remote-tracking refs and tags, never the checkout (owner ruling).

**A checkout whose branch has no `.claude/` has NO guard.** The hooks and `permissions.deny` come from the `.claude/settings.json` of the directory Claude Code starts in. Until this PR is merged, every branch cut from `main` has none of it, the main checkout included when it sits on such a branch. One line to check a branch before pointing an agent at it (prints `guarded` or `NO GUARD`):

```sh
git cat-file -e <branch>:.claude/hooks/readonly-guard.mjs 2>/dev/null && echo guarded || echo "NO GUARD"
```

Start `recon`/`auditor` from a checkout that prints `guarded`, and let them make the linked worktree for the audited commit.

## When a refused command is legitimate

The agent reports it; it does not look for another spelling. You run it yourself, as ONE line in your own terminal (or `! <command>` at the Claude Code prompt, which runs it in your shell, outside the hooks):

```sh
gh pr create --draft --fill          # PR creation is yours (CLAUDE.md "Do NOT" #14)
gh auth status                       # the guard refuses all of gh auth
cast send <contract-address> "<function-signature>" --rpc-url <url> --private-key <key>   # only you hold keys; replace the <angle> parts
sed -i '' 's/a/b/' .claude/hooks/command-guard.mjs  # or edit the file; Edit/Write on it asks you first
```

Editing the harness itself (`.claude/settings*.json`, `.claude/hooks/`) works through the Edit/Write tools, which ask you; a Bash write to those paths is refused.

## Start an agent with a goal

Run from a checkout whose branch has `.claude/` (see the previous section; the project settings and hooks come from there); the agent creates its own worktree. Lint first, then start:

```sh
node scripts/goal-lint.mjs goal.md && claude --agent implementer "/goal $(cat goal.md)"
node scripts/goal-lint.mjs goal.md && claude --agent recon "/goal $(cat goal.md)"
node scripts/goal-lint.mjs goal.md && claude --agent auditor "/goal $(cat goal.md)"
claude -p --agent implementer "$(cat goal.md)"
```

Lines 1-3: interactive, for implementation, read-only recon, and read-only audit (the goal must say `READ-ONLY` and `ANY verdict`). Line 4: unattended; `-p --agent` plus a prompt is verified. If the interactive form misbehaves, start `claude --agent implementer` and paste `/goal <the goal text>`. Override the model with `--model opus` for fund-flow, contract or gate work (`_PROMPT-TEMPLATE.md` §0).

## Verify and audit

```sh
scripts/agent-verify.sh
scripts/agent-verify.sh --codeql --keeper
```

`--keeper` runs the keeper suite on every Node major CI uses (22 in `ci.yml`'s `keeper-suite` job, 20 in `keeper-tests.yml`), looked up via PATH, brew, nvm, fnm and volta. A missing major is FAIL with the line `install: brew install node@20 node@22` (only the missing ones); it never substitutes another version. `--codeql` needs `gh extension install github/gh-codeql`.

## What this cannot stop

The guards read the command text the agent sends to the Bash tool. They are an accident-and-drift barrier, not a sandbox. Still possible:

- **Script files and interpreters.** `bash script.sh`, `source f`, `npm run x`, `make`, `node -e '<program>'`, `python3 -c '<program>'`, `perl -e`, `osascript`, a git hook, a `package.json` script. The guard sees `node` or `python3`, not what it runs; the exceptions are a `.env*` or shell-history file named inside an interpreter's own arguments, which is refused. A script that writes `.claude/hooks/` is not seen either. The A77 auditor accepted this residual for "via an npm script" and "via a script file".
- **Aliases and shell functions.** One defined in the agent's own command line (`alias p='git push -f'; p`, `f() { git push -f; }; f`) or in the owner's shell/git config (`alias.*`). `git -c alias.*=`, `git config alias.*` and `gh alias` are refused; existing aliases are not known to the guard.
- **Names built at run time.** A command name or flag assembled by `$VAR`, brace expansion or globbing (`/usr/bin/s*h`, `$(echo ssh) host`). A bare-expansion command name, `eval "$X"`, `sh -c "$X"`, a `git push` argument starting with an expansion and `$HISTFILE` are refused; the rest is not. Environment-variable prefixes that change what a tool runs (`GIT_SSH_COMMAND=<program>`, `GIT_EXTERNAL_DIFF=<program>`, `GIT_PAGER=<program>`, `LD_PRELOAD=<library>`, `BASH_ENV=<file>`) are not inspected.
- **Recursive reads that never name the file.** `grep -r KEY .`, `rg KEY`, `find . -type f -exec cat {} +`, `cat $(ls -a)` over a directory holding a `.env`. The `Read(.env*)` / `Edit(.env*)` deny rules do stop more than the Read and Edit tools: also the file commands Claude Code recognises in Bash (`cat`, `head`, `tail`, `sed`, `tee`) and the targets of redirects (`> f`, `< f`) (Claude Code permissions docs, "What Read and Edit rules cover"). They do not stop a command that reads files without naming them, or a script that opens them itself. Only the OS sandbox stops those.
- **Exotic shells and wrappers.** `csh`, `tcsh`, `fish -c` and the GNU-prefixed coreutils names (`gtimeout`, `gnice`, `gnohup`, `gstdbuf`, `gtime`, `gxargs`, `genv`) are unwrapped like their BSD names. Any other wrapper is not: `su -c`, `chroot`, `watch`, `parallel`, `flock`, `ionice`, `unbuffer`, `chpst`, `setpriv`, `osascript -e 'do shell script "<command>"'`, `python3 -c 'import os; os.system("<command>")'` run a command that layer 1 does not read (layer 0 still sees a forbidden name in their arguments). `script` and `coproc` are refused outright.
- **Writes by the read-only agents through Bash itself.** `recon` and `auditor` have no Edit/Write tools, but redirects (`echo x > f`), `tee`, `sed -i`, `cp`, `mv`, `rm` into the audited tree are not stopped (only the harness paths above are). The rest is prose in their agent files.
- **Paths into the harness reached by another route.** `.claude/` paths are normalised (`.claude//settings.json`, `./.claude/./hooks`, `a/../`) and resolved against the hook's `cwd` and any `cd` in the same command line; `git -C .claude` and a `cd` into it are refused by layer 0. A symlink to the harness, a path held in a variable and `find . -delete` with a pattern that happens to match it are not seen.
- **Anything that is not the Bash tool.** MCP tools, `WebFetch`, the Edit/Write tools of the implementer (the harness paths are `ask` rules, everything else is the implementer's job).
- **Other callers of the same binary.** `ssh` reached through `git` (a `core.sshCommand` set in a config file the agent edited), scripts started by `npm` lifecycle hooks.

The backstops are outside this config: `main` branch protection (CI green required, unsigned commits rejected: CLAUDE.md "Do NOT" #11, #12), owner-only merges and PR creation (#14), SSH-signed commits, and secrets that are not in the agent's worktree (`scripts/grok-dispatch.sh` creates it outside the repo). A mistake the guards miss should still be stopped there; anything that must hold belongs in GitHub settings, not here.

## Known gaps / owner decisions

- The guard fails closed: if `node` itself is missing, every Bash call is blocked. That is intended.
- `git push` with an argument that begins with an expansion (`git push origin "$BRANCH"`) is refused: write the branch literally.
- Subagent frontmatter hooks need the folder's workspace trust accepted, otherwise they are skipped (docs). That is why the read-only guard now lives in `settings.json`.
- When Claude Code changes the hook or permission schema, update `.claude/**` and re-run `npm test`; the tests pin the contract.
