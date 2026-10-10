# chore/next-16-3-8-ssrf — feedback

`next` 16.3.6 → 16.3.8: closes HIGH GHSA-cjq9-62q9-8jv4 (SSRF, Image Optimization, `>=16.0.0 <16.3.8`)
+ GHSA-f87g/-mcj8/-3w37/-4jqv (moderate) + GHSA-39w2 (low). No other dependency changes.

## Checklist
- [x] C1 evidence `03060b8` · [x] C2 bump + `npm install` `b4f98e7` (lockfile written by npm only)
- [x] audit-gate PASS · build exit 0 · lint Δ0 · vitest = origin/main · E2E 5/5 · [x] pushed

## 1. `npm ls next` before/after + publish date
- Before (origin/main `2ae40d5`): `next@16.3.6` direct; `@sentry/nextjs@10.75.3` + `@vercel/analytics@2.0.1` dedupe.
- After: `next@16.3.8`, same 3 edges, all deduped, no `invalid`. Lockfile delta = 10 pkgs only: `next`, `@next/env`,
  8× `@next/swc-*`. Lock-only `npm ls --all` invalid/UNMET set identical before/after (78 lines, all pre-existing).
- `overrides.next` = `{ "postcss": ">=8.5.10" }` — nested scope, not a version pin → nothing to keep equal; untouched.
- `npm view next time`: **16.3.8 = 2026-09-30T16:07:21Z → 10.3 d** at 2026-10-10T22:53Z (≥ `min-release-age=7`;
  `npm install` did not refuse). 16.4.0 (2026-10-06, 4.2 d) not used.
- `eslint-config-next@16.3.7` (unchanged): peers `eslint >=9.0.0`, `typescript >=3.3.1` — no `next` peer; satisfied.

## 2. audit-gate
- origin/main: `audit-gate FAILED — 1 high/critical advisory is NOT allowlisted: HIGH next (GHSA-cjq9-62q9-8jv4)`
- HEAD: `audit-gate: 1 high/critical advisory present, 1 allowlisted, 0 blocking.` → `audit-gate PASSED`
  (allowlisted = braces GHSA-vfj7 only). `npm audit`: no `next` entry at any severity; the 7 high pkgs left all chain to braces.

## 3. build / lint / test vs origin/main
| check | origin/main | HEAD |
|---|---|---|
| `npm run build` | exit 0, Next 16.3.6, 30/30 pages | exit 0, Next 16.3.8, 30/30 pages, route table identical |
| `npm run lint` | 94 warnings / 0 errors | 94 / 0 (per-rule counts identical) |
| `npx vitest run` | 285 files / 4309 passed | 285 files / 4309 passed |
| `npm run test:e2e` | — | 5/5 passed (category-chips harness; log shows an esbuild rebuild, not a `next` server) |

## 4. diff --stat + Image Optimization surface
```
docs/feedback/chore-next-16-3-8-ssrf.md | 51 +++++++++++++++++++++
package-lock.json                       | 80 ++++++++++++++++-----------------
package.json                            |  2 +-
3 files changed, 92 insertions(+), 41 deletions(-)
```
`next.config.js:6-11` (read-only, unchanged) — no `domains`, no wildcard hosts, https only:
```js
images: { remotePatterns: [
  { protocol: 'https', hostname: 'tokens.1inch.io' },
  { protocol: 'https', hostname: 'assets.coingecko.com' },
] },
```
**Follow-ups (not done here):**
- No `pathname` on either pattern → the optimizer will fetch any path on both hosts. Optional hardening: add path
  prefixes (e.g. `/coins/images/**` on coingecko) after checking the real logo URLs — Architect call.
- Local env only: `@playwright/test` 1.63.0 needs `chromium_headless_shell-1243`; cache had 1208/1228, so the first
  E2E run failed 5/5 at browser launch. Fixed with `npx playwright install --only-shell chromium` (user cache, no repo change).
- audit-gate prints `ages in undefined` for the braces entry and suggests an `overrides` pin even for a direct dep — cosmetic, pre-existing.
