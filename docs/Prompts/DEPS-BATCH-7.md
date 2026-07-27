# DEPS-BATCH-7 — npm-audit safe fixes (tar / hono / @babel/core)

## Context

Weekly security audit (2026-07-27) reported 0 critical / 9 high / 10 moderate / 1 low npm
vulnerabilities on `main`. `tar` (7.5.20) and `hono` (4.12.25) were already pinned in root
`package.json` `overrides` (both transitive — `hono` is not imported anywhere in `src`);
`@babel/core` was transitive and not yet overridden. Policy: npm min-release-age = 7 days;
any fix version younger than 7 days is skipped and reported, never forced.

## Objective

Apply the SAFE subset of fixes (no breaking changes, no major bumps) via the `overrides`
block: `@babel/core`, `hono`, `tar`. Leave `brace-expansion` and `uuid` untouched — both
require a semver-major bump upstream (`@eslint/eslintrc`/`eslint` for brace-expansion,
`wagmi@3.x` for uuid).

## Requirements

- Branch `chore/deps-batch-7` off `origin/main`, in a dedicated `git worktree`.
- For each of `@babel/core`, `hono`, `tar`: find the lowest version that both clears the
  advisory and is ≥ 7 days old (`npm view <pkg>@<ver> time`). Skip + report if none qualifies.
- Regenerate `package-lock.json` via a clean `npm install`.
- Do not touch any other dependency.

## Do NOT

- Do not apply the `brace-expansion` or `uuid` fixes (breaking/major bump required).
- Do not open a PR or poll/watch CI.
- Do not pin any package below its 7-day release-age floor.
- Do not touch dependencies outside the 3 named advisories.

## Files affected

- `package.json` (overrides block)
- `package-lock.json` (regenerated)
- `docs/Prompts/DEPS-BATCH-7.md` (this file)

## Expected output

- `@babel/core` override added, `hono` override bumped — both ≥ 7 days old.
- `tar` left at its current pin (7.5.20): both available patched versions (7.5.21, 7.5.22)
  are younger than 7 days as of 2026-07-27.
- All gates green: `npm install` clean, full vitest suite passing, `tsc --noEmit` clean,
  0 new eslint errors vs `origin/main`.

## Quality criteria

- `npm audit` advisory count for the 2 applied fixes must drop (before/after reported).
- No unrelated dependency versions change in `package-lock.json`.
- Feedback file documents the advisory table, what was fixed, and what was skipped by the
  7-day gate.
