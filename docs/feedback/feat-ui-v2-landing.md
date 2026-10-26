# feat/ui-v2-landing — feedback

Branch off origin/main `f32ac28` (B1, #610). Flow-B only: code under `src/ui/v2/**`, `src/app/v2/**`, `src/proxy.ts`. No PR (owner opens it). Detail, slot table and content-map delta: `feat-ui-v2-landing/NOTES.md`; screenshots (webp) and test/verify outputs sit in `feat-ui-v2-landing/`.

## Checklist
- [x] C1 (a) `/` → Swap · (b) `_enable` + cookie · (c) "Change" · (d) DCA gate tests · (e) credit in footer
- [x] C2 landing, ten sections, at `/` · [x] C3 content-parity gate · [x] verify below

## Owner answers (asked mid-run; supersede the goal text — verbatim in NOTES.md)
(d) DCA gate **truthful per live chain** (Arbitrum only once `isDcaLive(42161)`) · (c) "Change" on all 3 networks · particle-environment clause **dropped + allow-listed**.
**(a) vs C2 — my reading, not asked:** v1's split is `useState('landing')` → every Launch CTA → Swap (`src/app/page.tsx:49,68`). v2 `/` = same: landing first, **Swap tab after Launch** (logo → landing). Say if `/` must open Swap directly.

## Evidence
1. Tests `root-cookie-enable-tests.txt`: no cookie → v1; right secret → cookie (HttpOnly/Secure/Lax/30 d) → v2; wrong secret → 401, no Set-Cookie; `/v2/_enable` 404 in production, open in preview/dev. **Vercel Preview env (names only):** remove `UI_V2_ENABLED`; keep `UI_V2_ADMIN_SECRET` + `UI_V2_COOKIE_SECRET`; for the DCA gate set `NEXT_PUBLIC_DCA_ENABLED`, `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE`, `NEXT_PUBLIC_BASE_FEE_COLLECTOR` (unset ⇒ no chain is DCA-live ⇒ the plain pane — that was the skeleton).
2. `app-{desktop,375}-network-menu.webp` ("Change" ×3) · `app-{desktop,375}-dca-ethereum.webp` ("DCA runs on Base." — Base-only is today's truth).
3. `app-{desktop,375}-swap.webp`: credit in the footer, left, apart from ♫/? (distinct containers, tested). Fix on the way: fabs sit at `bottom-3` under 640 px (they covered footer links).
4. `landing-{desktop,375}-{hero,performance,why-teraswap,security,experience,features,roadmap,cta,docs,footer}.webp`.
5. `parity-output.txt`: 138 v1 text nodes, 2 hrefs, **0 missing**; 1 allow-list entry (owner-removed clause), stale entries fail.
6. Slot table → NOTES.md.
7. v1 proof (module-identical, as B1): v1 source diff **empty**; **0** v2 markers in any v1-loaded chunk; route table = base + `/v2/_enable`; initial JS Δ −0.05 %…+0.00 %; suite 342/5393 → **347/5468**; lint 93 = 93 (0 errors); tsc 0; `npm run build` 0 on both (`v1-proof-and-verify.txt`). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-landing

## Concerns / edges
- Landing header has no chain selector/Connect (pack 10a; v1 had both): hero feed count follows the selected chain, Ethereum until launch. Owner call.
- Dropped as new/unsourced copy: pack's Permit2 card figures and the Docs-card sentence. Source-graph names are lowercase registry names (as v1).
- Screens: `next start` of the branch build, placeholder public env (dummy WalletConnect id, fee-collector/executor/RPC stand-ins). Read-scope extras: NOTES.md.
