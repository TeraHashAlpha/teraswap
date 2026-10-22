# chore/numeric-formatter — per-file migration list (evidence 3)

Companion to `chore-numeric-formatter.md` (kept to one screen). Line numbers = post-change file.
**Display-only: yes** on every row = the value is only rendered as text; none is signed, sent, compared or stored.
Raw bigint/wei amounts for txs, minOut, allowances and payloads are untouched (formatters receive them read-only).

## Migrated (37 of the 52 grep files — 31 now fully clean, 6 keep justified lines — plus the `fee-usd` deprecation; `fmt*` from `@/lib/format`)
| File | Lines | Change | Display-only |
|---|---|---|---|
| SwapBox.tsx | 362,364,373,500,506,796,875,907,920,991,1002,1051,1138-1140,1186,1192 | toast/balance/output/review-modal strings, `%`/`$` copy; review props `amountInDisplay`/`expectedOutput` are only rendered by TransactionPreview | yes |
| QuoteBreakdown.tsx | 101-106,147,254,285,380,409,482,500-502,534,543,594 | rate/inverse/min-out/fee/gas row/price impact; gas row now `~fmtGas ETH (fmtUsd)` | yes |
| DCAPanel.tsx | 703,765-773,780-783,1464 | `perPart` now = `fmtToken(perChunkRaw(parseUnits(total), parts))` — same split as OrderReviewModal/OrbitStatRow (per-buy identical in panel + summary + review); `perPart` is read at one JSX site only; expiry label, `totalDuration`, slippage chips | yes |
| ExecutionTimeline.tsx | 59,65,72,85 | 3 `Intl.NumberFormat` consts removed → fmtToken/fmtUsd/fmtGas | yes |
| PortfolioTab.tsx | 103,163,303 | `usdFormatter` removed → fmtUsd | yes |
| AnalyticsDashboard / PersonalDashboard / PublicProtocolStats / AdminMonitor | 37,84,281-294 / 22,67,200-209 / 28,81,117,247 / 21,195,308-329,418,490,518-522,605,622,670-673,723,804 | local `formatUsd` → `fmtUsd(n,{compact:true})`; counts → fmtInt; `%` → fmtPct | yes |
| OrderReviewModal.tsx | 25,32,109 | `fmtAmount` (exported, used by OrderCancelReviewModal) → fmtToken; expiry → fmtDate; target price → `fmtToken(bigint,8)` | yes |
| CowOrderReviewModal / SplitReviewModal / TransactionPreview | 24 / 29 / 63-65,121 | amount strings → fmtToken (zero → `null`/`0 SYM` preserved) | yes |
| LimitOrderPanel.tsx | 369,688,728,973,1000-1012 | buy preview, Market label, `%` vs market, card amounts/USD. `formatPrice` (1085-1089) **kept** `toFixed` + allow marker: feeds `setTargetPrice` (signed order) | yes (see marker) |
| ConditionalOrderPanel.tsx | 584,634,646,689,884,906 | receive preview, current/trigger USD, `%`. `setTriggerPrice(…toFixed(2))` ×2 **kept** + marker (input state → signed) | yes (see marker) |
| OrderDashboard.tsx | 203-204,247 | Now $/pct/target label | yes |
| WalletHistory / WalletModal / Footer | 85,264 / 179 / 39 | amount, `≈ $`, ETH balance (wagmi `formatted` string), block number | yes |
| SplitRouteVisualizer.tsx | 80,160-190 | `formatDisplay` → fmtToken, gas USD, `% better` | yes |
| dca/DCAFillsTimeline, DCAOrderCard, DCAPositionStats, OrbitStatRow, SettlementReceiptModal | 21,31 / 104 / 45,157 / 14 / 26-60 | fill amounts/USD, total, P&L, per-buy, receipt text (fmtGas for network cost, fmtDate) | yes |
| app/status/page.tsx | 82,87 | latency seconds, uptime % | yes |
| hooks/useTokenBalances.ts, usePortfolio.ts | 111-113 / 65 | `formatBalance` → fmtToken; consumers: TokenSelector rows, PortfolioTab, DCAPanel balance line — all text; Max/quick-fill uses the raw bigint | yes |
| lib/depeg-gate, chainlink, defillama, minimum-output, gasless-engine, dca-quick-fill, order-engine/economic-floor, order-engine/dca-custom | message lines only | user-facing copy (`%`, `$`, `~$`) | yes (strings, no numeric field changed) |
| lib/fee-usd.ts | 62-64 | `formatFeeUsd` marked `@deprecated` (rule #4), body untouched; QuoteBreakdown now uses fmtUsd | n/a |

## Kept on purpose (allow marker `numeric-format-allow:` in code, enforced by `format.guard.test.ts`)
SwapBox.tsx:377 (`outAmount` → `addRecord`, stored history) · LimitOrderPanel.tsx:1089, ConditionalOrderPanel.tsx:285,486 (input state parsed back into signed orders) · AdminMonitor.tsx:106, LandingBelowFold.tsx:373 (SVG geometry).

## Not migrated — outside "display" (21 files still match the grep; 31 are clean)
- `src/app/api/**` ×7 (guard allow-listed dir): JSON payload rounding (`Number(x.toFixed())`), logs, alert text, 4xx text.
- `lib/personal-analytics`, `analytics-seed`, `gasless-engine:145` (rounded payload numbers), `security-tracker`, `post-execution-validator` (stored events/validation reasons), `sybil-detector`, `surplus-report` (admin/ops text), `fee-usd` (deprecated helper kept), `format.ts` (the formatter).

## Test expectations changed (15, all legitimate §3 string changes)
DCAPanel ×2 (`~$0.0000`→`<$0.01`), dca-quick-fill (same), QuoteBreakdown AERO fee (`$0.002`→`<$0.01`), OrderReviewModal ×2 / PortfolioTab / SettlementReceiptModal / TransactionPreview / usePortfolio / useTokenBalance (thin-space grouping, `1.0000`/`5.0000` kept ≥1), depeg-gate (`5.0%`→`5%`), minimum-output + useSwap (`50.0%`→`50%`), SwapBox (compares with `fmtToken` instead of `formatDisplay`; testing-library collapses U+2009, so PortfolioTab uses `\s` regexes).
