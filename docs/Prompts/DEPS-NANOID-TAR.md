# DEPS-NANOID-TAR

## Context

`node scripts/audit-gate.mjs` failed on a clean `origin/main` (246cd7b) with 2 blocking
HIGH advisories — no repo code changed, the advisory database moved. This reddened every
open PR (7 dependabot PRs + the ADR-019 docs PR).

## Objective

Pin `nanoid` and raise the `tar` override past their fixed versions so the audit gate is
green again, without touching `.npmrc`, the allowlist, or any app/keeper/contract code.

## Advisories and fix versions

Both advisories list "Unknown" affected/patched ranges in GitHub's metadata, so the fix
versions below were derived by unpacking and diffing the published tarballs directly:

- **nanoid — GHSA-2v37-7h3g-55p8 / CVE-2026-67213** (custom generators can loop
  indefinitely when size is zero). Guard (`if (size <= 0) return ''`) added in
  `customAlphabet` (`index.cjs`) in **3.3.17** (2026-08-03). 3.3.16 (previously installed)
  lacks it. Pulled transitively by `postcss` (`nanoid: ^3.3.16`), build-time only, one
  path, no prior override.
- **tar — GHSA-r292-9mhp-454m** (uncontrolled recursion in `mapHas`/`filesFilter`,
  stack-overflow DoS via crafted long-path tar). Fix (`MAX = 100` depth cap threaded
  through `mapHas`) in `filesFilter` (`dist/esm/list.js`) in **7.5.21** (2026-07-21).
  Pulled transitively by `@capacitor/cli` (`tar: ^7.5.3`), dev-only, one path; an
  existing override pinned it at the now-vulnerable `7.5.20`.

Both fix versions are well past `.npmrc`'s `min-release-age=7` (20 and 33 days at the time
of this change), so neither is blocked and neither needs an allowlist entry.

## Change

- `package.json` `overrides`: added `"nanoid": "^3.3.17"`; raised `"tar": "7.5.20"` to
  `"tar": "^7.5.21"`.
- `package-lock.json` regenerated via `npm install`.

## Verification

- `npm ls nanoid --all` → resolves to `nanoid@3.3.18` (via `postcss`)
- `npm ls tar --all` → resolves to `tar@7.5.22` (via `@capacitor/cli`)
- `node scripts/audit-gate.mjs` → `0 high/critical advisories present, 0 allowlisted, 0 blocking` — exit 0
- `npm run lint` → 0 errors (94 pre-existing warnings, unrelated to this change)
- `npm run typecheck` → clean

## Do NOT (honored)

- No `npm audit fix` used.
- `.npmrc` untouched.
- `audit-allowlist.json` untouched (`"allow": []` unchanged).
- No app/keeper/contract code touched.
