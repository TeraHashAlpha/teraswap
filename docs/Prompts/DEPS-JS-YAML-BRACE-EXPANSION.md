# DEPS-JS-YAML-BRACE-EXPANSION — unblock the `audit` gate

> Architect spec, committed with the implementation branch
> `chore/deps-js-yaml-brace-expansion` (off `origin/main`, dedicated worktree, no PR —
> compare link reported).

## Why

`node scripts/audit-gate.mjs` fails on `origin/main` today, reddening `audit` on every
open PR. Measured on a clean main checkout and on two unrelated PRs — same failure. The
advisory DB moved, the diffs did not.

## Task 1 — js-yaml GHSA-5p4m-2wfm-xmqj (HIGH, the actual blocker)

Quadratic CPU in `!!omap` resolution, CVE-2026-59870. Single dependency path, dev/lint-time
only: `teraswap@0.1.0 -> @eslint/eslintrc@3.3.6 -> js-yaml@4.3.0 overridden`. The omap fix
landed only in js-yaml 5.2.1 (2026-07-02); 4.3.0 and 3.15.0 backported only
`maxTotalMergeKeys`, a different advisory — no patched 3.x or 4.x line exists.

Raise the `overrides` entry for js-yaml from `4.3.0` to `^5.2.1`. 5.2.1 is 36 days old, clear
of `min-release-age=7`. This is a MAJOR jump for eslintrc's transitive dependency, so the
gate turning green is not sufficient evidence — the toolchain must actually run (lint +
typecheck) to prove `@eslint/eslintrc` still loads its YAML config under js-yaml 5.x.

## Task 2 — the two brace-expansion entries in audit-allowlist.json

Both carried `ageInOn: 2026-08-06`, now past. Per the file's own `$comment`, an entry lives
only while a fix is un-installable under `min-release-age`; once it ages in it MUST become an
`overrides` pin and be deleted. Two different pins, not interchangeable:

- the 1.x path (hoisted `minimatch@3.1.5`) → brace-expansion `1.1.18`
- the 5.x path (`minimatch@10.2.5`, consumed by `@typescript-eslint/typescript-estree` and
  `glob`) → brace-expansion `5.0.9`

5.x must never land on the 1.x path: 5.x exports `{ expand }` with `__esModule`, while
`minimatch@3.1.5` calls the `require()` result as a function — `'expand is not a function'`
on any pattern containing braces. Verified via `npm ls brace-expansion --all` (each path
resolves to its own pin) and by exercising a braced glob (`{a,b}.ts`-style match) through
both minimatch consumers directly.

## Do NOT

- Run `npm audit fix` in any form.
- Change `.npmrc`, or weaken/bypass `min-release-age=7`.
- Add any new allowlist entry — a patched, installable version exists for every advisory
  here.
- Touch anything outside dependency metadata (no keeper, contract, or app code).
- Delete files (rule #4) — removing a JSON array entry is not a file deletion.
- Run `ssh-add` or touch SSH/keychain material (rule #13).

## Files affected (read-only scope)

`package.json`, `package-lock.json`, `audit-allowlist.json`, `.npmrc` (read-only, unchanged),
`scripts/audit-gate.mjs` (read-only, unchanged).

## Quality criteria

A red gate is information, a forced-green gate is a lie: if the toolchain broke under
js-yaml 5.x, stop and report the exact error — no allowlist entry, no downgrade. Push only
after `audit-gate.mjs`, lint, and typecheck all confirm green locally.

## Implementation record

- Commit `cb6f5a5`: js-yaml override `4.3.0` → `^5.2.1` (resolved `5.2.2`). Lint and
  typecheck both pass clean under the new resolution — eslintrc's config load is intact.
- Commit `3bbe0cc`: `minimatch@3.1.5` → brace-expansion `1.1.18`; `minimatch@10.2.5` →
  brace-expansion `5.0.9`. Both allowlist entries removed, `$comment` STATUS updated to
  2026-08-07.
- Final local verification: `node scripts/audit-gate.mjs` exit 0, `npm run lint` exit 0 (94
  warnings, unchanged from baseline, 0 errors), `npm run typecheck` exit 0.
