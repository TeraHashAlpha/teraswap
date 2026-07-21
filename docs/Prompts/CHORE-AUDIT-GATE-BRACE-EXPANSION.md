# CHORE-AUDIT-GATE-BRACE-EXPANSION — pin brace-expansion past GHSA-3jxr-9vmj-r5cp

> **Source:** CI "Security audit (high/critical, allowlist-aware)" failing repo-wide on
> `brace-expansion` DoS (GHSA-3jxr-9vmj-r5cp), blocking all PRs.
> Branch `chore/audit-gate-brace-expansion` off `origin/main`, dedicated worktree, SSH-signed.
> **Exit = push + local audit-gate green for brace-expansion + compare link** (CI runs when the
> owner opens the PR).

## Requirement

`npm audit --json` reported `brace-expansion` vulnerable in two ranges: `<1.1.16` (the 1.x line)
and `>=3.0.0 <5.0.7` (the 3.x–5.x line). Three resolved instances in the tree, none patched:

- `node_modules/brace-expansion` (via top-level `minimatch@3.1.5`, dev, `^1.1.7`) — was `1.1.14`
- `node_modules/glob/node_modules/brace-expansion` (via `minimatch@10.2.5`, `^5.0.5`) — was `5.0.6`
- `node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion` (same
  `minimatch@10.2.5`, `^5.0.5`) — was `5.0.6`

Both patched versions (`1.1.16`, `5.0.7`) are 2025 releases, well past the 7-day
`min-release-age` in `.npmrc` — no allowlist entry needed.

## Fix

`package.json` `overrides`:
```json
"brace-expansion": "1.1.16",
"minimatch@10.2.5": {
  "brace-expansion": "5.0.7"
}
```
The blanket `brace-expansion` pin covers the 1.x-line consumer (top-level `minimatch@3.1.5`,
range `^1.1.7`, satisfied by `1.1.16`); the scoped `minimatch@10.2.5` override covers both
5.x-line consumers (range `^5.0.5`, satisfied by `5.0.7`) without forcing the wrong major onto
either. `npm install` regenerated `package-lock.json` — no other dependency changed.

## Scope note

`npm audit` also reports a pre-existing, unrelated HIGH (`js-yaml` GHSA-52cp-r559-cp3m, via
`@eslint/eslintrc`) that predates this branch (reproduced on unmodified `origin/main`) — out of
scope per this goal's explicit "touch ONLY brace-expansion" constraint; left untouched, flagged in
FEEDBACK for separate triage.

## Amendment (2026-07-21)

Architect-approved scope extension: resolve js-yaml GHSA-52cp-r559-cp3m in this same branch.
`js-yaml@4.2.0` (dev-only, via `@eslint/eslintrc`) pinned to `js-yaml": "4.3.0"` (released
2026-06-26, 25 days old — past the 7-day `min-release-age`, no allowlist entry needed); `^4.1.1`
range satisfied. `npm run lint` confirms eslint tooling still works under 4.3.0.

Two NEW, unrelated advisories (axios GHSA-gcfj-64vw-6mp9, tar GHSA-23hp-3jrh-7fpw /
GHSA-8x88-c5mf-7j5w) appeared in `npm audit` after this fix — absent from yesterday's baseline
audit-gate run, so genuinely new since then, not introduced by this branch's overrides. Out of
scope for this amendment (js-yaml only); audit-gate is therefore NOT fully 0-blocking. Flagged for
a separate chore.

## Amendment 2 (2026-07-21)

Advisory wave: axios HIGH (GHSA-gcfj-64vw-6mp9) and tar CRITICAL/HIGH (GHSA-23hp-3jrh-7fpw,
GHSA-8x88-c5mf-7j5w) now block the gate. Both resolved via `overrides` (patches >7 days old, case
2a — no allowlist needed):

| Advisory | Package | Path | Prod/Dev | Resolution | Note |
|---|---|---|---|---|---|
| GHSA-gcfj-64vw-6mp9 (HIGH) | axios | wagmi→@wagmi/connectors→@base-org/account→@coinbase/cdp-sdk | Production (bundled, client-side wallet SDK) | pin `1.18.1` (rel. 2026-06-22, 29d old) | Node-HTTP-adapter-only bug; not directly imported in `src/`, but pinned regardless since patch was cheaply available — no allowlist needed |
| GHSA-23hp-3jrh-7fpw (CRITICAL) | tar | @capacitor/cli | Dev/build-only (mobile CLI, never imported in `src/`) | pin `7.5.20` (rel. 2026-07-12, 9d old) | satisfies both this and the HIGH below |
| GHSA-8x88-c5mf-7j5w (HIGH) | tar | @capacitor/cli | Dev/build-only | pin `7.5.20` | same pin as above |

`node scripts/audit-gate.mjs` → 0 blocking. Full suite (2783/2783) + tsc + eslint green.
`next build` was attempted but fails identically on unmodified `origin/main` too (Turbopack
`TurbopackInternalError: reading dir "/Users/tiagocruz/Desktop" — Operation not permitted`) — a
sandbox filesystem-permission issue unrelated to these dependency pins, verified via `git stash`
A/B on this exact worktree.

**Incident note:** mid-validation, this worktree's `git stash`/`git stash pop` interacted with the
REPO-GLOBAL stash stack (shared across all worktrees of this repo) and briefly pulled in an
unrelated `ChainSelector.tsx`/`ChainSelector.test.tsx` WIP from a concurrent session. It was
immediately identified (diff didn't match this branch's scope) and pushed back onto the stash
stack with a clearly labeled rescue message before any further changes — no other session's work
was lost, and nothing from that WIP was committed here. Future sessions in this repo should avoid
bare `git stash`/`git stash pop` (prefer git stash with a descriptive -m and targeted stash@{N}
pop) given concurrent worktree usage.
