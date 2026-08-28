## Feedback — CHORE-GROK-DISPATCH (commit 2)

### Edge case
- Repo-wide `.gitignore` has `scripts/*.sh` under "local dev only — never deployed" (no `.sh` script
  is currently tracked at all — `fork-test.sh`, `deal-tokens.sh`, `check-fee.sh` referenced in
  `package.json` are local-only). The spec requires `scripts/grok-dispatch.sh` as a real, reviewed,
  unit-tested PR deliverable, which conflicts with that convention as written. Added a narrow
  `!scripts/grok-dispatch.sh` exception rather than renaming the script away from bash (the spec is
  explicit about `bash, set -euo pipefail`) or silently letting the file drop out of the diff.

### Assumption that turned out wrong
- `resolve_grok_model`'s table was originally sketched as a bash associative array
  (`declare -A`), which needs bash 4+. macOS ships bash 3.2 by default and `/usr/bin/env bash`
  resolves to it here — confirmed via `bash --version`. Rewrote as a `case` function, and separately
  found `${var,,}` (also bash4-only) used for case-insensitive path matching in the sensitive-file
  glob check; replaced with `tr '[:upper:]' '[:lower:]'`. Both caught by testing against
  `/bin/bash -n`, not just whatever `bash` was first on PATH.

### Test gap
- The dispatcher's `--execute` path past all refusal checks (worktree creation + the actual `grok`
  invocation) has no automated test, by design — `grok` is genuinely installed on this dev machine
  (`/Users/tiagocruz/.local/bin/grok`), and a test exercising a passing `--execute` run would call the
  real xAI API, which this chore is explicitly forbidden from doing. Coverage stops at "every refusal
  path fires before the grok-invocation line is reached"; the happy path is unverified until a human
  runs `--dry-run` then `--execute` by hand.
