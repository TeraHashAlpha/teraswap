# B7 evidence detail (referenced from `../feat-ui-v2-orders-history.md`)

## 1. Frames → v2 (desktop 1440, 375 @2x; fixture data on v1's engine contract, real AppShell, `next dev`)
| round7 frame | v2 composite (frame left, v2 right) |
|---|---|
| desktop 35 DCA positions | `35-frame-vs-v2.webp` |
| desktop 40 Orders active | `40-frame-vs-v2.webp` (row a1 opened) |
| desktop 41 Orders cancel review | `41-frame-vs-v2.webp` (the reused DcaCancelSheet, Limit order) |
| desktop 42 Orders completed detail | `42-frame-vs-v2.webp` (h1 opened: summary + execution history) |
| desktop 43 History | `43-frame-vs-v2.webp` |
| desktop 46 empty states | `46-frame-vs-v2.webp` (History disconnected / empty, Orders disconnected / empty) |
| — (no frame) | `v2-history-error-loading.webp` (v1's error line; skeleton + `Loading...`) |
| mobile m07 Orders | `m07-frame-vs-v2-375.webp` (Orders, Positions, History at 375; no round7 375 frame exists for History/Positions) |

Rig (not in repo): a temporary `src/app/v2/%5Fshots` page rendering `OrdersView` / `HistoryView` / `DcaOrdersList` with
`positions-fixtures` inside `AppShell`; executions / prices reads stubbed at the network; removed before commit (`git status` clean).
Header shows "Connect wallet" and Ethereum: the views get fixture props, the wallet is not connected in the rig.

## 2. Content parity (v1 ⊆ v2, `compareContent`, 0 missing text, 0 missing links, 0 stale allow entries)
| surface | cases | v1 tree | test |
|---|---|---|---|
| Positions list | 5 active + 4 history | DCADashboard (MissionControlCard, DCAOrderCard, DCAPositionStats, DCAFillsTimeline) | `dca/dca-positions.test.tsx` |
| per position | a1–a5 one by one | MissionControlCard | same |
| settlement receipt | h1 completed, h2 cancelled | SettlementReceiptModal (+ identical Copy-as-text payload) | same |
| Orders lists | Active / Completed / Cancelled, collapsed | OrderDashboard | `orders/orders.test.tsx` |
| Orders rows opened | all 11 orders (DCA Base/Arb/Ethereum, Limit, TP, SL; 8 statuses) | OrderDashboard + DCAPositionStats + ExecutionTimeline | same |
| Orders cancel review | DCA / Limit / TP / SL / Ethereum DCA | OrderCancelReviewModal | same |
| Orders states | disconnected, loading, read-signature denied, empty ×3 | OrderDashboard | same |
| History | list, disconnected, loading, error ×3, empty | WalletHistory | `history/history.test.tsx` |

Allowed (aria-hidden in v2, still drawn — the swap tab's rule): 🔗 📋 ⟳ ⇅ 🎯 🛡️ 📎 ⏱ ⛽ ⇄.
Format remap applied to v1's DOM before the Orders compare, each asserted on its own: `formatUnits` → `fmtToken` (same bigint,
order decimals), `toLocale*` → `fmtDate` (same instant), `https://etherscan.io/tx/` (v1 hard-codes chain 1) → the order's explorer.
Owner answer 2026-10-31: the v2 per-fill USD (v1's `fillUsd`) is allow-listed in `usd-scope-guard.test.ts` (C5 `2a98b0c`).
Mutation checks: removing `newest first` / `Range` / `gas paid by executor` from v2 fails the gate (then restored).

## 3. Countdown / P&L
- Countdown: v1 MissionControlCard and v2 DcaPositionCard mounted side by side at 10 instants (9h07m out, 30 s out, at target,
  2 min after, 0-fill schedule start, signing, executing-due, completed, cancelled, expired) × 5 ticks (+1 s, +1 s, +59 s, +1 h):
  `{countdown, terminal, label, accent}` equal every time. Pure: `nextBuyTarget` = v1 `nextBuyAtMs(...)`, value = `formatHMS`.
  Reduced motion: no SVG ring, `next-buy-static` text = v1's countdown string.
- P&L: v1 DCAPositionStats vs v2 `usePositionStats`, same fills + `/api/portfolio/prices`; `computePositionPnl` (lib, the formula
  owner) observed in both: `Object.is` on pnlUsd / pnlPct / investedUsd / currentValueUsd, same direction; stats `toEqual`, invested /
  received as `BigInt ===`; a1 (Base, up), h1 (Arbitrum, self-fetch path), a5 (one fill), a loss (same negative number, not red),
  no price (no P&L in either).

## 4. Cancel args (fake engine = v1's observable contract; sequences `toEqual`)
| type | confirm | keep |
|---|---|---|
| DCA (Base) · Limit · Take Profit · Stop Loss | `cancelOrder(id)` · `confirmCancel()` | `cancelOrder(id)` · `clearPendingCancel()` |
| DCA (Ethereum, wallet on Base: "Switch to Ethereum") | `cancelOrder('e1')` · `confirmCancel()` | — |
| Cancel All (6) | `cancelAllOrders()` · `confirmCancel()` | — |
No call before the sheet's confirm; no optimistic flip (Active 6 → 5 only after the engine). Sounds = v1's (`playTouchMP3`).

## 5. States matrix
| | Positions | Orders | History |
|---|---|---|---|
| disconnected | (DCA gate, B6) | v1 words | v1 words, no request |
| loading | — | 3 skeleton rows, `aria-busy`, no words (v1 none) | 5 skeleton rows, `Loading...`, Refresh disabled |
| error | v1 failure reason (banner / row) | v1 failure reason; read-signature denied → v1 notice + `Sign to view` | HTTP 500 / network / API body → v1 line, `role=alert` |
| empty | v1 empty + `Start a DCA` | `No active / completed / cancelled orders`, no count, no Cancel All | v1 sentence, Export CSV inert |
| per status | Active/Executing/Preparing/Completed/Cancelled/Expired/Failed (both v1 maps) | all 8 v1 labels | confirmed / failed / pending |
