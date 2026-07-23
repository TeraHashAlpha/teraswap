# CHORE-DEPS-BATCH-5 — consolidated Dependabot NPM bumps (batch 5)

> **Source:** owner directive 2026-07-23 — consolidate the pending safe Dependabot NPM PRs into one
> verified branch so the owner merges once; individual Dependabot PRs auto-close on merge. Respects
> `.npmrc`'s `min-release-age=7d`; anything under that floor is skipped and noted, never forced.

## Applied

| Package | From | To | Location | Note |
|---|---|---|---|---|
| `viem` | 2.47.4 | **2.55.1** | root (#314) | fixes the `ws` HIGH advisories bundled in viem <2.49.3 |
| `viem` | 2.47.10 | **2.55.1** | contracts/order-engine (#319) | no Dependabot target given; aligned to the same date-safe version as root |
| `ws` | 8.18.3/8.19.0 (transitive) | **8.21.1** | contracts/order-engine, new `overrides` entry (#319) | not a direct dep there (pulled in via hardhat); pinned via `overrides`, mirroring root's own existing `ws` override convention |
| `@capacitor/core` | 8.4.0 | **8.4.1** | root (#265) | |
| `@eslint/eslintrc` | 3.3.5 | **3.3.6** | root, dev group (#316) | |
| `@playwright/test` | 1.61.0 | **1.61.1** | root, dev group (#316) | |
| `autoprefixer` | 10.5.0 | **10.5.4** | root, dev group (#316) | |
| `postcss` | 8.5.15 | **8.5.19** (not latest 8.5.22) | root, dev group (#316) | 8.5.22 is 1 day old — held at the newest version that clears `min-release-age` |
| `vitest` | 4.1.9 | **4.1.10** | root, dev group (#316) | |

Six dev-dependency bumps found available: `@testing-library/dom`, `@testing-library/react`,
`@testing-library/user-event`, `cuer`, `esbuild`, `jsdom` had no newer same-major version to bump to
(already latest) — not all 19 devDependencies have a pending update.

## Skipped — `min-release-age` (<7d as of 2026-07-23)

| Package | Target | Published | Reason |
|---|---|---|---|
| `@next/swc-*` (8 platform binaries) | 16.2.11 (to match `next@16.2.11` already on `main`) | 2026-07-21 | 2 days old — same release as `next` itself, whose own bump needed an explicit one-off override in a prior chore. No override authorized here; left at their current mismatched versions (16.2.6/16.2.9), which is harmless — the build already succeeds with this mismatch present on `main` today. |
| `eslint-config-next` | 16.2.11 | 2026-07-21 | 2 days old; not explicitly named in this chore's list, held for consistency with the `@next/swc-*` skip above. |

## Superseded / not applicable
None of the named `@next/swc-*` targets were already satisfied (main is still on the older mismatched
pins), so this is a genuine skip, not a supersede.

## Not touched (major-version bumps, correctly excluded from a "safe" batch)
`@testing-library/jest-dom` (6→7), `@types/node` (20→26), `@types/react`/`@types/react-dom` (18→19,
would break React 18), `eslint` (9→10), `tailwindcss` (3→4), `typescript` (5→7 latest dist-tag) — all
skipped as out-of-scope major bumps, not part of a same-major "safe" dependency group.

## Verify (all green)
- **`npx vitest run`** — 217 test files / 2948 tests, all green.
- **`npx tsc --noEmit`** — clean.
- **`npx eslint src --ext .ts,.tsx,.js,.jsx`** — 0 errors (121 pre-existing warnings, unchanged).
- **`next build`** — succeeds (28/28 routes). Verified via the same pre-existing, environment-only
  workaround documented in `chore/bump-next-security` (a temporary, uncommitted
  `turbopack.root`/`outputFileTracingRoot` addition to `next.config.js`, reverted via
  `git checkout -- next.config.js` before commit — confirmed zero diff on that file) — this local
  sandbox has a stray home-directory lockfile confusing Turbopack's workspace-root inference,
  unrelated to any dependency in this batch.
- **`node scripts/audit-gate.mjs`** — `0 high/critical advisories present, 0 allowlisted, 0 blocking`.
- **`npm audit`** (contracts/order-engine) — bumping `ws`/`viem` here *reduces* vulnerabilities
  (16→14 total, 7→6 high): the two `ws` HIGH advisories bundled in viem's pre-2.49.3 dependency tree
  are gone. Remaining highs (`elliptic` via `@ethersproject/*`, `tmp` via `solc`) are pre-existing,
  transitive via `hardhat`/`solc`, and out of this batch's scope.

**Pre-existing, unrelated to this batch:** `contracts/order-engine` has no local `.npmrc`, so it
doesn't inherit root's `legacy-peer-deps=true` — a plain `npm install` there needs
`--legacy-peer-deps` to resolve a pre-existing `chai`/`hardhat-chai-matchers` peer conflict (confirmed
reproducing identically on an unmodified `main` checkout in an isolated temp copy, before touching
anything). Not part of this batch's changes.

## Do NOT (respected)
Did not touch `codeql-action`/other GitHub Action bumps; did not bump anything not listed above; no
PR opened.
