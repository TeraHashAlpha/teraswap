# grok-guard.sh — source this to get a credential-guarded `grok` for interactive use.
#
# CHORE-GROK-DENY-FLAGS: scripts/grok-dispatch.sh is one credential guard, for scripted/headless
# dispatch. A hand-launched Grok TUI (`grok` typed straight into a terminal) goes through neither
# script and has NO guard at all — Grok Build has no [permissions] config table (see
# .grok/config.toml's TODO) and silently ignores one if added, so this repo's ONLY enforcement is
# CLI flags injected at invocation time. This file is that second injection point.
#
# Usage: source scripts/grok-guard.sh   (in ~/.zshrc, ~/.bashrc, or ad hoc before a session)
# After sourcing, a bare `grok ...` in this shell runs with the deny flags already applied; every
# other argument passes through untouched. `command grok` (or the full path) bypasses this on
# purpose if you ever need the unguarded binary — don't do that in this repo's tree.
#
# POSIX `name() { ... }` function syntax — plain "$@" pass-through, no bash/zsh-specific array
# syntax — so this works identically whether sourced from zsh (this repo owner's macOS shell) or
# bash. Must also pass scripts/check-bash3-compat.mjs like any other tracked .sh file.
#
# The flags below are hardcoded here, in parallel with GROK_DENY_FLAGS in scripts/grok-dispatch.sh
# — NOT shared code. This function is an interactive-shell construct (a shell function scoped to
# the shell it's sourced into); the dispatcher runs as its own non-interactive subshell/subprocess
# and never inherits a caller's shell functions, so it cannot rely on this being sourced. Do not
# "de-duplicate" by having the dispatcher assume this ran, or by deleting this file once the
# dispatcher has its own flags — they guard two different launch paths. Both lists must be updated
# together, verified against `grok --help` / ~/.grok/README.md's Permission Rules section — never
# extend either by guessing.
grok() {
  command grok \
    --deny "Read(.env*)" \
    --deny "Read(**/.env*)" \
    --deny "Bash(security*)" \
    --deny "Bash(git credential-*)" \
    "$@"
}
