# src/ui/v2 — UI v2 (parallel tree)

Scoped to `src/ui/v2/` and `src/app/v2/`. Root rules in `/CLAUDE.md` still apply. Design record: `docs/ADR/ADR-025-ui-v2-parallel-tree.md`
(Status: Proposed). Every test below runs in CI's `full-suite` job (`.github/workflows/ci.yml:440-468`).

## v1 stays module-identical
- v2 imports v1's logic; it does not fork it. Nothing in `src/lib`, `src/hooks`, the wallet or v1 components is edited for v2
  (ADR-025 Decision 1, `ADR-025:15-17`). Fix a shared module only when v1 needs the fix too, and say so in the PR.
- v1 source must not reference `ui/v2` — enforced by `src/ui/v2/isolation.test.ts:36-41` (allow-list: the v2 trees, `proxy.ts`,
  `app/api/admin/ui-version/`). `src/app/page.tsx` stays a v1 client page (`isolation.test.ts:43-47`).
- Why it matters: a client module reachable from a v1 page's server graph is bundled into that page's chunks (measured, `ADR-025:36-45`).
  "0 v1 source changes" and "0 v2 markers in v1 chunks" are NOT pinned by any test — only measured once on a built app. After touching
  `src/proxy.ts` or `src/app/page.tsx`, rebuild and grep the v1 chunks yourself.
- The switch is server-side only: `UI_V2_ENABLED` (never `NEXT_PUBLIC_`) or a signed `ts_ui` cookie; anything else is v1 (`ADR-025:18-23`).
  Fail-closed cases pinned by `src/ui/v2/version.test.ts:53-76` (wrong-secret cookie, missing secret) and `src/proxy.test.ts`.

## Nothing visible today may disappear
- Every visible v1 text node and link must still be in v2. The only way to remove one is an allow-list entry carrying the owner's reason;
  an entry that no longer matches v1, or is still present in v2, fails (`src/ui/v2/__tests__/content-parity.ts:2-6`).
- Whole-app gate: `src/ui/v2/__tests__/parity-sweep.test.tsx:4-12` — Swap, Portfolio, DCA, Orders, History, Analytics and landing, on chains
  1 / 8453 / 42161. Per page: `swap/content-parity.swap.test.tsx`, `docs-legal/content-parity.{docs,legal}.test.tsx`,
  `__tests__/content-parity.landing.test.tsx`.
- Limit and SL/TP have no v2 pane and stay "Soon" (owner decision, `parity-sweep.test.tsx:12-13`); the sweep proves the tabs are inert.
- A v2 page that moves a string must move it, not drop it: add the page's parity test with the page, not after.

## USD is display-only
- `APPROX_PRICES` / `fillUsd` are hand-edited constants. A module may import them only if it is on the display/analytics allow-list; nothing
  that gates or signs may (`src/lib/order-engine/usd-scope-guard.test.ts:1-30`). `ui/v2/dca/positions-model.ts` is on that list
  (`usd-scope-guard.test.ts:78`) as a display-only importer. CI job `feed-resolution-guard` runs it (`ci.yml:438`).

## Dark only
- v2 has no light theme: `color-scheme: dark`, no `prefers-color-scheme`, no `.light` (`src/ui/v2/tokens.test.ts:123-126`).

## Mobile
- The 375 px suite runs against a production build with `UI_V2_ENABLED=true`: `npx playwright test --config
  src/ui/v2/__tests__/mobile/playwright.config.ts` (CI job `v2-mobile-parity`, `.github/workflows/e2e.yml:60-90`).
