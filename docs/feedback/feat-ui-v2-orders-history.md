# feat/ui-v2-orders-history — feedback (B7: DCA positions parity · Orders · History)
Off origin/main `0a642a9` (#633). Signed, noreply. C0 `afec8dc` · C1 `82409e6` positions · C2 `4f1a86a` Orders · C3
`b212a8f` History + a11y · C4 `cff1e68` view split · C5 `2a98b0c` + C6 `b430f91` guard lines. Mocked; nothing
signed.
**PR #635 (owner, not draft) merged C0 only (`4d84b5c`, 13:46)** → C1+ need a NEW **DRAFT** PR (Auditor note: cancel
path).
Diff: `src/ui/v2/**` + this file/folder + ONE owner-approved line in `src/lib/order-engine/usd-scope-guard.test.ts`.
**Asked → owner answer 2026-10-31 (supersedes the goal text):** v1's per-fill USD (`fillUsd`) tripped the
APPROX_PRICES importer guard (src/lib) → **allow-list v2**: C5 lists `ui/v2/dca/positions-model.ts` (display only,
gates/signs nothing); C6 lets that test file name the path in the v2 isolation guard (data, never an import, never
bundled).
**Premises (no blocker, recorded):** (a) v1 History has no hook (fetch inline in WalletHistory) →
`use-wallet-history.ts` restates it, URL + read-sig headers = v1 (test). (b) v1 hard-codes chain 1 for Orders /
ExecutionTimeline tx links → v2 uses the ORDER chain (owner rule; a v1 bug for Base/Arb). (c) v1 History rows show
no chain → v2 adds the name (goal). (d) `rpc-polling.ts` has only `BLOCK_POLL_MS` → LivePrice polls 60 s (v1 30 s)
on the order's chain (v1: the wallet's). (e) v1 has no pagination (one page of 50 + "Showing N of T") — same. (f)
Reduced motion: ring not drawn, the countdown text keeps v1's 1 s tick (information, not motion) — judgement call.
(g) v1 Orders is chain-agnostic — same.
**Reads:** round7 CHANGELOG, FUNCTIONAL-CONTAINERS; frames d35 d40 d41 d42 d43 d46 + m07 (no 375 History/Positions
frame). Extra, in-session: DCADashboard's children, ExecutionTimeline, app/swap/page.tsx (tabs), useOrderExecutions,
lib.
## Evidence (`feat-ui-v2-orders-history/`; detail in `evidence.md`)
**1. Frames → shots:** `35/40/41/42/43/46-frame-vs-v2.webp` (1440) · `m07-frame-vs-v2-375.webp` · error/loading
webp.
**2. Content parity, 0 missing:** Positions 5 active + 4 history, each card, receipt ×2 (same Copy-as-text) · Orders
3 lists + all 11 rows opened (DCA Base/Arb/ETH, Limit, TP, SL; 8 statuses) + cancel review ×5 · History 7 states.
**3. Equality:** countdown face v1 = v2 at 10 instants × 5 ticks · P&L `Object.is` (usd, pct, invested, value),
stats bigint.
**4. Cancel args = v1:** DCA / Limit / TP / SL / ETH-DCA `cancelOrder(id)`·`confirmCancel()`; Keep →
`clearPendingCancel()`; Cancel All `cancelAllOrders()`·`confirmCancel()`. **5. States:** disconnected · loading ·
error (read-sig denied, HTTP, network, API body) · empty per filter · every status label. **a11y:** ↑/↓/Home/End
through rows (Orders, History, Positions); after the cancel sheet focus returns to Cancel, or to the tab when the
row left the list (never <body>).
**7. Verify:** suite **399 files / 6358 tests, 0 failed** (base 395 / 6281: +4 files, +77 tests) · rpc-budget +
isolation + usd guard alone 29/29 · `eslint .` 93 = 93 · tsc 0 · `next build` 0 head + base · **v1**
(`v1-proof.txt`): 0 v1 sources changed; 8/10 v1 routes byte-identical; `/`, `/swap` 29/30 chunks identical, the 30th
= lazy-import table (+33 B): v1's lazy Orders + DCA tabs re-partitioned, 0 base modules missing, 4 v1 lib modules
un-inlined (now shared), 0 v2-marked · `diff --stat` src: 28 files +3389 −96 (27 in `src/ui/v2`). main since base:
docs + #602 lockfile, not in this branch.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-orders-history

## Content-map delta (v1 → v2)
**Pending-B7 closed:** countdown ring (`Next buy in` / `Buying now` / `Executing soon…` / terminal labels, `N of M
buys`), `Per buy` · `Total` · `Route` · `Expires`, `Position summary` (Invested · Received · Avg price · Fills · Range
· P&L vs spot), fills timeline (`Fills`, `newest first`, `#n`, `SUCCESS`/`FAILED`, `~$x`, amounts, tx, time),
settlement receipt (every row, `Copy as text`/`Copied!`/`Close`, loading + both errors), history card (status, `N of M
buys`, `X total`, `View on explorer ↗`, `View receipt`) — v1's words. **Orders + History:** every OrderDashboard /
ExecutionTimeline / WalletHistory string (parity tests).
**v2-only (data, not copy):** chain name on DCA history rows and History rows; decorative fill dots + type glyph (no
box).
**Format (owner rule):** Orders amounts `formatUnits` → `fmtToken` (`10` → `10.0000`); Orders / execution dates
`toLocale*` → `fmtDate` (`8 Oct 2026, 09:12`); Orders / execution tx links → order chain. **Moved:** DCA Cancel to the
row foot (frame 35).
**Frame-only, not used (v1 wins):** 35 `9h 07m`, `Fills 4/10 · Every 1 day · Expires in 26 days`, `AVERAGE PRICE`,
VIEW RECEIPT on an active position, `CANCEL ALL (1)`; 40 always-open rows, `Executed —` / `Received —`; 42 red loss
(v1: calm neutral), per-fill `gas 0 ETH` (v1 `gas paid by executor`); 43 `via Velora` (v1 prints `velora`); 46 CONNECT
WALLET / GO TO SWAP buttons, `No swaps yet` / `Swaps and DCA fills appear here with tx links.` (v1: `No activity yet —
your swaps and DCA fills will appear here`).
**Not carried:** nothing — every string v1 shows on these tabs is in v2 (0 missing, 3 surfaces).
