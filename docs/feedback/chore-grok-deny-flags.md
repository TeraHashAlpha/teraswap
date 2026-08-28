## Feedback — CHORE-GROK-DENY-FLAGS (commit 1)

### Note
`GROK_DENY_FLAGS` in `scripts/grok-dispatch.sh` is applied to both the reported `--dry-run` command and the
real `--execute` invocation, using the same flags already verified in PR #432's `.grok/config.toml` TODO:
`--deny "Read(.env*)" --deny "Read(**/.env*)" --deny "Bash(security*)" --deny "Bash(git credential-*)"`.

## Feedback — CHORE-GROK-DENY-FLAGS (commit 2)

### How to install the interactive guard
Add this line to `~/.zshrc` (the repo owner's macOS shell):

```
source "/Users/tiagocruz/Desktop/Claude/dex-aggregator 2/scripts/grok-guard.sh"
```

After sourcing, a bare `grok ...` typed in that shell runs with the deny flags already applied; every other
argument passes through untouched. Verified by sourcing `scripts/grok-guard.sh` from both a real `bash -c`
and `zsh -c` subshell against a stub `grok` on `PATH` (see `scripts/grok-guard.test.mjs`) — not just static
inspection of the script.

### Edge case
`scripts/*.sh` is blanket-`.gitignore`d in this repo (see PR #431's finding). Added a narrow
`!scripts/grok-guard.sh` exception next to the existing `!scripts/grok-dispatch.sh` one — proven tracked via
`git check-ignore -v scripts/grok-guard.sh` (shows the negation rule firing) and `git ls-tree -r HEAD
--name-only | grep grok-guard.sh` (decisive: it's in the committed tree).

## Feedback — CHORE-GROK-DENY-FLAGS (commit 3)

### Manual canary check (run by hand — never automated, never against a real secret)

The obvious version of this check is dangerous: asking Grok to read `.env.production.local` to see if the
deny rule refuses would **send the real secret to xAI if the deny fails**. Use a disposable canary file
outside the repo instead, with both a guarded control (must refuse) and an unguarded control (must succeed —
proves the file really was readable, so the guarded refusal isn't just Grok not finding the file):

```bash
mkdir -p /tmp/grok-canary
echo "CANARY_DO_NOT_USE=dummy-value-12345" > /tmp/grok-canary/.env.canary
cd /tmp/grok-canary

# Guarded — MUST refuse, must NOT print dummy-value-12345
grok -p "cat .env.canary" --deny "Read(.env*)" --output-format json --no-auto-update

# Unguarded — MUST print dummy-value-12345 (proves the guarded run above was a real refusal,
# not the file simply being unreadable/missing)
grok -p "cat .env.canary" --output-format json --no-auto-update

rm -rf /tmp/grok-canary
```

If the guarded run ever prints `dummy-value-12345`, the deny rule is not working — stop using `grok` in this
repo and open an incident before it happens against a real `.env*` file.

### Note
`node scripts/check-agents-parity.mjs --write` recomputed the pin after the `CLAUDE.md`/`AGENTS.md`
"Grok Build launch" bullet: `3f821ebc3d2a4e53780ea23ae1b7e5b01536cf9daf3d240595ed2108214bff8c` (len=64, sha256
hex, never hand-typed). `node scripts/check-agents-parity.mjs` confirms green against the committed pair.
`.grok/config.toml`'s `TODO(security)` updated to note the flags are now wired in two places
(`scripts/grok-dispatch.sh` + `scripts/grok-guard.sh`) — the verified README quotes are kept unchanged, since
they remain the evidence for why no `[permissions]` table exists; no such table was added.
