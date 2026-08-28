# FIX-GROK-GUARD-CLAIMS — the deny flags don't protect .env*, and the CI check is red

> **Source/Context:** Amends PR #433 (`chore/grok-deny-flags`) before it merges, and fixes its red CI check.
> The owner ran four canary probes by hand and measured what Grok's `--deny` actually does: `Read(.env*)` and
> `Bash(*.env*)` are both bypassed (Grok routes around a denied read by choosing a different command — a
> `Bash(...)` deny glob matches the invoked command name, not its arguments); only `--deny "Bash(*)"`
> (blocking the whole shell) actually refuses, and that's unusable for real work. #433 therefore ships a
> guard that does not protect `.env*` and says in `CLAUDE.md` that it does. Not fund-flow → **no Auditor
> gate**, but this is now the sole credential guard and rides the next security review. SSH-signed noreply
> committer, dedicated worktree rebased on `chore/grok-deny-flags`. **4 droppable commits.**

## Requirements

### Commit 1 — fix the red CI check

1. `spawnSync zsh ENOENT` at `scripts/grok-guard.test.mjs`'s zsh leg — ubuntu-latest has no zsh. Install zsh
   in the `full-suite` CI job.
2. The test itself skips loudly (named `it.skip` + printed reason) when a shell binary is absent, and prints
   which legs actually ran — verified both with zsh present (both legs `RUN`) and with a stubbed `PATH`
   lacking zsh (zsh leg shows as a visible skip, not silently absent).

### Commit 2 — stop claiming the flags protect `.env*`

3. Rewrite the "Grok Build launch" rule in `CLAUDE.md`, mirrored verbatim into `AGENTS.md`: the `--deny`
   flags do NOT protect `.env*` (measured). What holds: (a) `--deny "Bash(*)"`, unusable for real work; (b)
   running in a git worktree that does not contain those files. `Read(.env*)`, `Bash(security*)`,
   `Bash(git credential-*)` kept as speed bumps and intent signals, labelled as such, never as enforcement.
4. Re-pin the parity hash in the same commit (`--write`, reviewed diff, never hand-typed, length sentinel).

### Commit 3 — the canary evidence

5. `docs/security/GROK-DENY-CANARY-2026-08-28.md`: all four runs (commands + Grok's reported replies), the
   disposable-canary method (outside the repo, its own `git init` dir, dummy value, both controls, never a
   real secret). Linked from `AGENTS.md`'s Pointers and `.grok/config.toml`'s `TODO(security)`.

### Commit 4 — the actual control: worktree outside the repo

6. `scripts/grok-dispatch.sh` creates its worktree outside the repo: `GROK_WORKTREE_BASE_DIR`, default
   `${TS_WORKTREE_BASE:-$HOME/ts-worktrees}`, never under `.claude/worktrees/`. Rejected outright (both
   `--dry-run` and `--execute`) if resolved under the repo root.
7. Tests: resolved worktree path outside the repo root (positive), an in-repo base dir rejected (negative),
   the exact-equality boundary rejected (negative), a custom outside-the-repo override honored (positive).

## Do NOT

- Install or run Grok Build, or call the xAI API.
- Read or print any real `.env*`/keychain output.
- Claim anywhere that a flag protects `.env*`.
- Add a `[permissions]` table to `.grok/config.toml`.
- Touch `contracts/`, `keeper/`, `src/lib/chains/`, or any swap/gate path.
- Hand-type any sha.
- Widen scope.

## Files affected (read ONLY these)

- `scripts/grok-guard.test.mjs`, `.github/workflows/ci.yml`
- `CLAUDE.md`, `AGENTS.md`
- `docs/security/GROK-DENY-CANARY-2026-08-28.md` (new)
- `.grok/config.toml`
- `scripts/grok-dispatch.sh`, `scripts/grok-dispatch.test.mjs`
- `scripts/check-bash3-compat.mjs`, `scripts/check-agents-parity.mjs` (read-only — run them, don't edit)
- `docs/Prompts/FIX-GROK-GUARD-CLAIMS.md` (this file), `docs/feedback/fix-grok-guard-claims.md`

## Expected output

Branch `fix/grok-guard-claims`, rebased on `chore/grok-deny-flags`, in a dedicated worktree. SSH-signed
noreply committer. Push + report — do not poll CI. Full suite green including the zsh leg (a green run that
skipped it is a regression), `bash -n` + shellcheck clean on both `.sh` files, both existing checks green.

## Quality criteria

- The zsh leg is proven to actually execute in a full-suite-style run (`CI=true npx vitest run ...`), not
  just present in the file.
- The worktree-outside-repo claim is verified directly (a scratch `git worktree add` outside the repo
  contains only tracked files), not just asserted.
- The rewritten CLAUDE.md/AGENTS.md wording is byte-identical between the two files.
- The re-pinned sha is computed by the script and carries a length sentinel.

---

### `/goal` paste for the Code Agent

```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the Files affected list above · FEEDBACK <= 1 screen.

Amends PR #433 before it merges — see docs/Prompts/FIX-GROK-GUARD-CLAIMS.md for the full spec (this file). Implement commit 1 (CI zsh install + loud skip), commit 2 (rewrite guard claims + re-pin parity), commit 3 (canary evidence doc), commit 4 (worktree outside the repo + mutation tests) as described there.
```
