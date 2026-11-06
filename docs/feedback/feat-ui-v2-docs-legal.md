# Feedback — feat/ui-v2-docs-legal

Base: origin/main after #660, verified merged at `ff06085`. 7 signed commits (see `git log`).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-docs-legal

## Checklist
- [x] C1 routing/shell/metadata/help-drawer (`bd2b6d5`) [x] C2 Legal restyle + copy edit (`8542053`)
- [x] C3 Docs restyle + claims-live + a11y (`471f75d`) [x] C4 mobile 375 + screenshots (`ff4bde3`)
- [x] P5 rpc-budget docs gap (`1cc8461`) [x] Verify 1–6 below

## What shipped
- `proxy.ts`: `/docs|terms|privacy` routed like `/swap`/`/analytics` (v1 untouched, v2 → `/v2<path>`); not a tab.
- `src/ui/v2/docs-legal/`: `LegalPageV2.tsx` (Terms 20 / Privacy 14 sections, text byte-identical except the one
  approved sentence), `DocsTabV2.tsx` (15 sections, six owner containers: hairline tables, TOC/scroll-spy →
  `<details>` below 1024px, local prose scrim, numbered FlowDiagram, hairline SourceCard rows, strip
  ComingSoonBanner + mono-caps Tag). `ContentShell.tsx` = AppShell chrome minus the tab strip.
- `PhotoBackground.tsx`: new `baked` prop (direct `NarrativePhotoId`) for non-tab shell pages. `HelpDrawer.tsx`:
  added Docs/Terms/Privacy links (none existed). Metadata layouts re-export v1's `metadata` by reference.
- `LegalPage.tsx:131` (v1, the one approved edit): "no method of electronic transmission or storage is 100%
  secure" → "no system is completely secure"; rest of paragraph unchanged; lands in v1 so v1/v2 match.

## Two real bugs the gates caught (not design choices)
1. `compareContent`'s allow-list strips a substring from **every** v1 text node globally. A bare "→" entry
   (FlowDiagram) also stripped it from the unrelated "USDC→USDT" in the OpenOcean disabled-source message,
   failing parity. Fixed: v2 keeps a plain "→" separator instead of removing it — no allow-list needed.
2. Real-Chromium mobile gate: Docs' Support links were ~20px (not inline in prose, so the WCAG 2.5.8 exception
   didn't apply, unlike Legal's). Fixed with `min-h-[44px]`; reran 15/15 green.
3. (post-report fix) `claims-live.docs.test.tsx` originally reused one fake value ("97") across
   `INTEGRATED_DEX_SOURCE_COUNT`/`QUOTE_TIMEOUT_SEC`/`SLIPPAGE_CLAMP_MAX_PCT` and never asserted
   `SLIPPAGE_CLAMP_MIN_PCT` at all — rewritten so all 29 symbols get a unique value and an individual assertion.

## Judgement calls
- `ContentShell` drops `appScrim`: safe, not a gamble — the 3 reused photos already measure `photoScrim: 0`
  (photo-scrim.ts), so this was a no-op either way; container 3 wants local scrim regardless.
- Added `<h1>` to Docs (v1 has none) and changed `StepRow` title `h4`→`h3` (v1 skips a level, `h2`→`h4`) —
  additive/v2-only fixes caught by my own a11y test; v1 untouched per the read-only-copy constraint.
- `DocsTabV2`/`LegalPageV2` duplicate v1's prose rather than importing it (LegalPage.tsx is read-only-source
  here) — same drift-risk pattern already accepted elsewhere in this codebase, guarded by parity tests.

## Evidence
1. **Proxy/metadata**: `proxy.test.ts` new describe block (12 cases) + matcher tests, all green;
   `docs-legal-metadata.test.ts` — v2 `metadata` `toBe` v1's (re-exported, can't drift).
2. **Parity ×3**: `content-parity.{legal,docs}.test.tsx` — 0 missing text/hrefs, 0 stale allow (Docs needs none
   at all). Copy before/after above.
3. **Claims-live**: 29/29 symbols individually asserted with unique fakes (see bug #3) — 31/31 passing.
4. **Screenshots**: `docs/feedback/feat-ui-v2-docs-legal/{docs,terms,privacy}-{375,1440}.jpg`, real Chromium,
   15/15 gate tests green.
5. **v1 proof, complete for `/` + all 8 tabs**: `isolation.test.ts` (exhaustive, no v1 source anywhere in the
   repo references `ui/v2`) + `proxy.test.ts`'s pre-existing, unmodified, still-passing pinned behavior for `/`
   and all 8 tab paths (36 cases) — unchanged. Build route table, checked for all 9: `/`, `/swap`, `/analytics`
   (the only 3 with a real v1 page) still `○` Static, unchanged type; `/portfolio`, `/dca`, `/limit`, `/sltp`,
   `/orders`, `/history` (the other 6 — `V2_ONLY_TAB_PATHS`, no v1 page by design) are **absent** from the v1
   route table entirely, confirmed via `grep` against the build output — only `/v2/[tab]` (one dynamic v2 route)
   serves them, proving no v1 bundle exists for any of the 8 tabs beyond the 3 real ones. rpc-budget `docs`
   state: ≤1 RPC/min (footer poll only), 0 hidden. CodeQL `javascript-security-extended.qls` (gh codeql 2.27.2,
   full suite): base `ff06085` = 13, head = 13, diffed by ruleId:file:line = **0 new, 0 removed**.
6. **Suite/lint/tsc/build**: suite 437 files/7773 tests, 0 failures (reran after every fix). Lint: head 93
   warnings/0 errors = base 93/0 (throwaway worktree diff) — delta 0. tsc clean throughout. Build green ×2
   (`UI_V2_ENABLED=true NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<32ch> npm run build`). `diff --stat ff06085..HEAD`:
   37 files, 2285(+)/12(-).

## Content-map delta (vs recon/docs-v2)

| Route | v1 | v2 |
|---|---|---|
| /docs | 2 tables, sticky nav, FlowDiagram boxes+arrows, SourceCard boxes, boxed ComingSoonBanner/Tag pills | hairline tables; TOC → `<details>` <1024px; numbered 01-05 FlowDiagram, no boxes; hairline SourceCard rows; strip+accent banner; mono-caps Tag |
| /terms, /privacy | boxed `rounded-2xl` panel, no TOC | wrapper-only restyle, text unchanged + 1 approved sentence; TOC added (v1 had none) |
| all three | reachable only via v1 footer | also reachable from v2 help drawer (closes recon's reachability gap) |

All 6 owner "decision needed" items (recon/docs-v2) resolved per the 5 Nov owner decisions; none left open.

## Owner sign-off: Monitor-tool usage (resolved 2026-11-06)
This session used the `Monitor` tool ~10 times to wait on local builds/tests/CodeQL started in-session (no CI
workflow was ever polled). Asked the owner directly in-session; owner reviewed and signed off on ending the
session on that basis. Closed, not open.
