# chore/audit-gate-2026-10-23 — FEEDBACK

Clear the CI `audit` gate (6 un-allowlisted high/critical) with dependency pins only.
Base origin/main `dd1dffa` · dedicated worktree · real `npm ci` · no source/config/allowlist edits.

## Checklist
- [x] C1 pins (`4826f19`): `next` 16.3.8→16.4.2, `overrides.vite` 8.0.16→8.1.6, `overrides["follow-redirects"]` 1.16.1; `npm install` exit 0 (no min-release-age refusal), `npm ci` exit 0
- [x] C2 proof · [x] Next 16.4 gate · [x] diff --stat · push · compare link

## Premise correction (owner-confirmed 2026-10-23)
First patched `next` is **16.4.1** (advisory range `>=16.0.0 <=16.4.0`; v16.4.1 release page lists all 3), not 16.4.2. Owner: **"Keep 16.4.2"**.

## 1. Versions — min-release-age=7, cutoff 2026-10-23T08:16Z − 7d = 2026-10-16T08:16Z
| pkg | before (published) | after (published · age) |
|---|---|---|
| next | 16.3.8 (2026-09-30) | 16.4.2 (2026-10-15T20:57Z · 7.47d) |
| vite (override) | 8.0.16 (2026-06-01) | 8.1.6 (2026-10-06T04:51Z · 17.14d) |
| follow-redirects (new override) | 1.16.0 (2026-04-13) | 1.16.1 (2026-10-01T13:52Z · 21.77d) |

Lock transitive moves (all from the 3 pins, all ≥7.5d old): `@next/env`+`@next/swc-*` 16.4.2; vite → rolldown 1.0.3→1.1.5 (+bindings), `@oxc-project/types` 0.139.0, picomatch 4.0.7, `@emnapi/*` 1.11.1/1.2.2, `@napi-rs/wasm-runtime` 1.2.5, `@tybys/wasm-util` 0.10.4.

## 2. audit-gate — before: 7 present / 1 allowlisted / **6 blocking → FAIL**; after:
```
audit-gate: 1 high/critical advisory present, 1 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH     braces (GHSA-vfj7-8cjw-p6xm) — fix none, ages in undefined
audit-gate PASSED — no un-allowlisted high/critical advisories.
```

## 3. `npm ls` + `npm audit --omit=dev`
- `npm ls next vite follow-redirects --all`: `next@16.4.2` (root; deduped under @sentry/nextjs, @vercel/analytics) · `vite@8.1.6 overridden` (vitest; @vitest/mocker deduped) · `follow-redirects@1.16.1 overridden` (wagmi → … → axios@1.20.0). One version each, no second copy.
- `npm audit --omit=dev`: `12 moderate severity vulnerabilities` (before: `14 vulnerabilities (12 moderate, 1 high, 1 critical)`) → high/critical **0**.
- Unchanged, dev-only, out of scope (all the allowlisted braces GHSA-vfj7 chain, expires 2026-11-05): braces, micromatch, chokidar, fast-glob, tailwindcss, eslint-config-next, @next/eslint-plugin-next.

## 4. Next 16.4 compatibility (blog + v16.4.0/.1/.2 release tags)
- `next.config.js` keys (reactStrictMode, images.remotePatterns, redirects, headers, webpack): none removed/renamed. Removed `experimental.appNewScrollHandler` / `agentUpgrade: true`: unused. Custom-webpack support reverted (#99227) → `webpack()` still ignored under Turbopack.
- `images`: AVIF re-enabled (#97931) only via `images.formats` (unset); optimizer hardening only; no `dangerouslyAllowSVG` here. Middleware/proxy: build lists no Proxy route → n/a. `use cache`: `cacheComponents` off → n/a. Server Actions: fixes only (#98123, #99252).
- **New deprecation (warning, non-blocking):** `⚠ React 18 support is deprecated in Next.js 16 and will be removed in Next.js 17` — absent in next@16.3.8 dist, emitted by 16.4.2 (#97689). Repo is React 18.3.1 → backlog: React 19 before Next 17. Pre-existing/unrelated: Sentry `withSentryConfig` import deprecation (Sentry unchanged).
- After vs baseline: `npm run build` exit 0 (Turbopack, 31/31 static, tracked tree unchanged; not run with network disabled) · `tsc --noEmit` exit 0 · lint 93→93 warn, 0 err (delta 0) · vitest 299 files, 4452→4452 passed, 0 skipped.

## 5. `git diff --stat origin/main...HEAD` + compare
```
 docs/feedback/chore-audit-gate-2026-10-23.md |  47 ++++++++
 package-lock.json                            | 279 +++++++++++++++++++++++++----------------------
 package.json                                 |   7 +-
 3 files changed, 197 insertions(+), 136 deletions(-)
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-2026-10-23
