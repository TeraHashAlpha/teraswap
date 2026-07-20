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
