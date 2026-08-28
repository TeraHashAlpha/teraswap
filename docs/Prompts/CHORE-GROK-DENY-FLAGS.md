# CHORE-GROK-DENY-FLAGS — wire the verified deny flags into both launch paths

> **Source/Context:** Follow-up to `chore/grok-deny-rules` (PR #432, merged). PR #432 established that Grok
> Build has no `[permissions]` config table — `--allow`/`--deny` are CLI-flag-only — and documented the
> verified flag syntax in `.grok/config.toml`'s TODO without wiring it up anywhere. Two holes remained: the
> dispatcher didn't pass the flags, and a hand-launched Grok TUI had none at all. This is the only thing
> between a Grok run and this repo's `.env*` files. Not fund-flow → **no Auditor gate**, but this is now the
> sole credential guard and rides the next security review. SSH-signed noreply committer, dedicated worktree
> off `origin/main`. **3 droppable commits.**

## Requirements

### Commit 1 — dispatcher passes the flags

1. `scripts/grok-dispatch.sh` passes the verified deny flags on every `grok` invocation, `--dry-run` and
   `--execute` alike.
2. Defined once as `GROK_DENY_FLAGS`, an indexed-array constant (bash 3.2 has no `declare -A`) next to the
   model table.
3. Comment explains the dispatcher keeps its own copy even after commit 2 adds a wrapper, since the wrapper
   is an interactive-shell function the dispatcher's non-interactive subshell never inherits.
4. Tests: exact flag list asserted in the `--dry-run` command (positive control, both approval-mode paths),
   plus a scratch copy of the script with one flag deleted proven to fail the same assertion (negative
   control).

### Commit 2 — versioned shell guard

5. `scripts/grok-guard.sh`: POSIX-sh `grok()` function injecting the same flags, passing everything else
   through. Verified sourced from both bash and zsh against a stub `grok`.
6. Lives in the repo (narrow `.gitignore` exception, same pattern as `grok-dispatch.sh`), not a dotfile.
   Exact `source` line for `~/.zshrc` in `docs/feedback/chore-grok-deny-flags.md`.
7. `CLAUDE.md`/`AGENTS.md` gain a verbatim "Grok Build launch" rule: only `scripts/grok-dispatch.sh` or a
   shell that sourced `scripts/grok-guard.sh` carries the guard.

### Commit 3 — re-pin parity + TODO update

8. `node scripts/check-agents-parity.mjs --write` after the `CLAUDE.md` edit; reviewed the `AGENTS.md` diff
   (exactly the new bullet); sha logged with a length sentinel in the feedback file.
9. `.grok/config.toml`'s TODO updated to note the flags are now wired in two places; the verified README
   quotes kept unchanged as the evidence for why no `[permissions]` table exists. No such table added.
10. Manual canary check (never against a real secret) added to the feedback file — a disposable
    `/tmp/grok-canary/.env.canary` with a dummy value, guarded control must refuse, unguarded control must
    succeed (proving the refusal is real, not the file being missing).

## Do NOT

- Install or run Grok Build, or call the xAI API (verification used `--dry-run` and a stubbed `grok` on
  `PATH`).
- Read or print any real `.env*`/keychain output.
- Add a `[permissions]` table to `.grok/config.toml` — confirmed silently ignored.
- Invent deny globs beyond the four already verified in PR #432.
- Touch `contracts/`, `keeper/`, `src/lib/chains/`, or any swap/gate path.
- Hand-type any sha.
- Widen scope beyond the files below.

## Files affected (read ONLY these)

- `scripts/grok-dispatch.sh`, `scripts/grok-dispatch.test.mjs`
- `scripts/grok-guard.sh` (new), `scripts/grok-guard.test.mjs` (new)
- `scripts/check-bash3-compat.mjs` (read-only — run it, don't edit it)
- `scripts/check-agents-parity.mjs` (read-only — run it, don't edit it)
- `.grok/config.toml`
- `.gitignore`
- `CLAUDE.md`, `AGENTS.md`
- `package.json`, `vitest.config.ts`, `.github/workflows/ci.yml` (unchanged — already wired from prior PRs)
- `docs/Prompts/CHORE-GROK-DENY-FLAGS.md` (this file), `docs/feedback/chore-grok-deny-flags.md`

## Expected output

Branch `chore/grok-deny-flags` off up-to-date `origin/main` (PR #432 already merged) in a dedicated worktree.
SSH-signed noreply committer. Push + report — do not poll CI. Full suite green, both existing checks
(`check:agents-parity`, `check:bash3-compat`) green, `bash -n` + shellcheck clean on both `.sh` files,
`scripts/grok-guard.sh` proven tracked (`git check-ignore -v` + `git ls-tree`).

## Quality criteria

- The mutation-test pattern (drop a flag, prove the assertion fails) is real for both the dispatcher and the
  guard, not asserted by inspection.
- `scripts/grok-guard.sh` actually runs correctly sourced from real bash and zsh subshells, not just parsed.
- The canary check never touches a real secret and has both a guarded and unguarded control.
- The re-pinned sha is computed by the script and carries a length sentinel.

---

### `/goal` paste for the Code Agent

```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the Files affected list above · FEEDBACK <= 1 screen.

Follow-up to chore/grok-deny-rules (PR #432, merged). See docs/Prompts/CHORE-GROK-DENY-FLAGS.md for the full spec (this file). Implement commit 1 (dispatcher deny flags + mutation tests), commit 2 (grok-guard.sh + verbatim launch rule), commit 3 (re-pin parity + TODO update + canary check) as described there.
```
