# feat/ui-v2-foundation — FEEDBACK (≤1 screen)
Flow-B: new code only in `src/ui/v2/**`, `src/app/v2/**`, `src/proxy.ts`, admin route, 2 tailwind files. Off origin/main 3a97f76.
- [x] C1 ADR-025 + switch · [x] C2 tokens/fonts/motion · [x] C3 primitives + kit · [x] verify · [x] evidence 1–6

## Owner answers that superseded the goal (recorded)
`api-auth.ts` = `/v1` key verifier, not admin auth → reads approved: admin routes, `lib/auth.ts`, #565 guards, vitest/package.json,
`.env.example`, pack `ARCHITECT_BRIEF.md`/`r2lib.py`. Admin gate = `verifyBearerToken` + new **`UI_V2_ADMIN_SECRET`** (3rd env name).
In-page `next/dynamic` switch measured to ship v2 to v1 → **proxy rewrite** (owner: option 1 + direct `/v2/*` 404 + this measurement).
Pack: no top-level `fonts/` (`assets/fonts/`); §4 has no motion → `ARCHITECT_BRIEF.md:24`; no `--ease-*` exists, none invented.

## Evidence
1. **ADR + switch tests** — ADR-025 (Proposed; "Rejected: next/dynamic"). version 26 · proxy 22 (matrix, forged/wrong-secret → v1,
   direct `/v2/*` → 404) · admin route 7 (401/503/cookie flags/clear) · `/v2` route 2 · isolation 2 (v1 never imports `ui/v2`).
2. **v1 bundle byte-identical** (origin/main build vs branch build, `/` HTML): 34 refs both, same URL set, 0 assets differ,
   3 169 118 B both, `index.html` identical modulo build id, `/` still `○`. 8 files only in branch (v2 js ×2, css ×2, 4 fonts), none
   referenced by v1 HTML. Before the fix: in-page switch → v2 chunk in v1 HTML; shared Tailwind scan → +29 rules/+2 KB in global CSS.
3. **§4 → `tokens.css`** (pack README.md → tokens.css): colors :76-78,:88-90 → L12-14 · fonts :80-83,:91-92 → L16-19 (next/font var first,
   §4 stack as fallback) · radius :84,:93 → L21 (16/10; chip 999 in tw only) · red `#FF5C7A` → L14 · dark only → L10 · motion
   `ARCHITECT_BRIEF.md:24` → L23 (160 ms, 1.2 s) + reduced-motion L30-. `tokens.test.ts` (14) pins every value from pack literals and
   reproduces the pack's contrast claims (dim 5.5/5.1/4.7, muted 7.8/7.2/6.7). Foundation PNG says panel r14; §4 says 16 → 16.
4. **Fonts** — Barlow Condensed Bold + IBM Plex Mono 400/500/700 (TTF as shipped), OFL 1.1 files + SHA-256 table in `fonts/README.md`;
   Inter reused (#565). `fonts.test.ts` (14) + #565 guard extended (CDN/`@import url` ban over `src/ui/v2`). ADR-012: no new deps.
5. **Kit** (built `next start`): prod-like `/v2/_kit` **404** (also with owner cookie, RSC req, `VERCEL_ENV=production`); `VERCEL_ENV=preview`
   **200** (+`noindex`, kit chunk only there). Direct `/v2` `/v2/swap` no/forged cookie → 404; valid cookie / env flag / admin cookie → v2.
6. **Verify** — suite 321 files / 4987 tests ✓ (main: 312 / 4880); lint 93 = 93; tsc 0; `check:*` ×5 ✓; build ✓. `diff --stat`: nothing in
   `src/lib|hooks|components`, `page.tsx`, `layout.tsx`, `next.config.js`; `src/app/api` = admin `ui-version` only. Not run: Playwright e2e.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-foundation (no PR).

## Concerns / owner notes
- Env (names only): `UI_V2_ENABLED=true` Vercel **Preview only**; `UI_V2_COOKIE_SECRET` Preview+Prod; `UI_V2_ADMIN_SECRET` wherever you set the cookie (unset → 503).
  Set the cookie via same-origin `fetch('/api/admin/ui-version', {method:'POST', headers:{Authorization:'Bearer …'}, body})`.
- Proxy runs on every `/` request (cheap pass-through; `/` stays static). Each v2 page later needs its own rewrite (`/swap`→`/v2/swap`).
- `notFound()` in a page returns HTTP 200 here (root `ssr:false` providers commit status) → real 404s come from the proxy.
- Direct `/v2` is a 2nd URL for v2 home once the switch is on, deliberately not `noindex` (rewrite from `/` shares metadata); fix at launch.
- Fonts are unsubset TTF (~540 KB, v2 routes only); Caveat not loaded (hand underline is SVG). Kit folder is `%5Fkit` (`_kit` is private).
- Local only: branch `wip/ui-v2-inpage-switch` (first attempt); worktree `~/ts-worktrees/ui-v2-foundation-base` (baseline) for removal.
- Security-review plugin returned HTTP 401 (did not run); CI runs once the owner opens the PR.
