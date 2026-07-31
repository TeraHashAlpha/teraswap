# ADR-017 — Deterministic production install (`npm ci`, no `--legacy-peer-deps`)

- **Status:** Accepted — 2026-07-29
- **Context incident:** none (drift was observed as a risk, not as a production incident)
- **Implemented by:** chore/deterministic-prod-install

## Context

`vercel.json`'s `installCommand` was `npm install --legacy-peer-deps`, while CI's `keeper-tests`/`ci` workflows install with `npm ci`. On 2026-07-29 both commands were run cold in isolated worktrees against the same lockfile and produced byte-identical trees — there was no live drift. But the two commands are not equivalent in general:

1. `npm install` re-resolves dependencies against the ranges in `package.json`. It is permitted to select any version satisfying those ranges, independent of what `package-lock.json` records. `npm ci` refuses to do this — it installs exactly what the lockfile specifies, or fails.
2. `--legacy-peer-deps` suppresses peer-dependency conflict errors. A conflict is the signal that the lockfile and `package.json` have drifted out of sync; suppressing it does not remove the drift, it removes the warning.

A cold `npm ci` was separately proven to succeed on this exact lockfile — 1017 packages, zero errors, no `--legacy-peer-deps` needed — which established that the flag was not covering for an actual unresolvable peer conflict. It was accepted risk with no offsetting benefit.

## Decision

**Production installs must be lockfile-deterministic.**

- `vercel.json`'s `installCommand` is `npm ci`. `npm install` is prohibited as a deploy install command, in this file or any other production install path.
- `--legacy-peer-deps` is not to be added to a deploy install command silently. If a future dependency change genuinely requires it, that requirement must be justified in an ADR (this one, superseded, or a new one) — not reintroduced as a quiet edit to `vercel.json`.

## Consequences

- A `package.json`/`package-lock.json` mismatch now fails the Vercel build loudly (`npm ci` errors out) instead of silently re-resolving to something CI never tested.
- Every dependency change must update the lockfile in the same commit, or the next deploy fails — this is the intended behavior, not a regression.
- Verified in an isolated worktree (`chore/deterministic-prod-install`, off `origin/main`): cold `npm ci` installed 1017 packages with zero errors; `package-lock.json` was untouched (`git status --porcelain package-lock.json` empty) afterward.

## Enforcement

Reviewers reject any diff that changes `vercel.json`'s `installCommand` away from `npm ci`, or that adds `--legacy-peer-deps` to it, unless the diff also adds or updates an ADR justifying the exception.

## Related

- [ADR-016](ADR-016-explicit-rpc-endpoints.md) (explicit RPC endpoints) — same category of decision: converting an observed-but-unenforced good property into an explicit, reviewable rule before it silently drifts.
