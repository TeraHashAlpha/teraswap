# Feedback — fix/tx-links-remaining

`ETHERSCAN_TX` (mainnet-only) → chain-aware `explorerTxUrl`, using the chain the tx was SENT/signed
on, never the wallet's live chain. 5 surfaces (the `fix/v1-maintenance` "left alone" list).

## 1. Per-surface

| File:line | chainId source | Test |
|---|---|---|
| SwapBox.tsx:1191,1203,411 (links+toast) | `useSwap().txChainId` — new, captured at send (`confirmSwap`/`confirmCowOrder`), not `useActiveChainId()` | SwapBox.explorer-link.test.tsx |
| useSwap.ts (`txChainId`) | source of the above | useSwap.test.ts (new describe) |
| ToastProvider.tsx:187 | new `Toast.chainId`, caller-supplied, `?? 1` fallback | ToastProvider.test.tsx (incl. wallet-switch) |
| LimitOrderPanel.tsx:1045,121 | `orderChainId`/`latestEvent.chainId` ← `OrderEngineEvent['order_filled'].chainId` (new) ← `useOrderEngine.ts:651` | LimitOrderPanel.explorer-link.test.tsx |
| ConditionalOrderPanel.tsx:916,117 | same pattern | ConditionalOrderPanel.explorer-link.test.tsx |
| AdminMonitor.tsx:837 | `TradeEvent.chainId` (already required/server-populated) | AdminMonitor.test.tsx (incl. wallet-switch) |

All 5 surfaces' tests include the "wallet switches chains after send" case.

## 2. Guard test (`etherscan-tx-guard.test.ts`, modeled on `usd-scope-guard.test.ts`)
```
 ✓ ... > the scan reaches the whole tree (guard is not vacuous)
 ✓ ... > the detector recognises a real import and ignores a mere mention
 ✓ ... > app/admin/page.tsx does not import ETHERSCAN_TX
 ... (870 total, one per scanned src/**/*.ts(x))
 Test Files  1 passed (1)
      Tests  870 passed (870)
```
0 callers outside `constants.ts`. `ETHERSCAN_TX` marked `@deprecated`, kept (rule #4).

## 3. Verify (head vs `origin/main` `bb56e87`)
- CodeQL `security-extended`: **13 → 13, 0 new** (exact alert-set match).
- Suite: **7555/7555** (421 files) vs baseline 6652/6652 (415 files).
- Lint: **93 → 93 warnings, 0 errors**, delta 0.
- `tsc --noEmit`: clean. `next build`: exit 0.

## 4. diff --stat
```
 12 files changed, 157 insertions(+), 27 deletions(-)   [source + first commit]
 8 files changed, 827 insertions(+), 1 deletion(-)      [tests, second commit]
 + 6 new test files: AdminMonitor / ToastProvider / etherscan-tx-guard /
   SwapBox|LimitOrderPanel|ConditionalOrderPanel.explorer-link
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/tx-links-remaining

## v2 parity
`execution.lifecycle.test.tsx:123` claimed byte parity with "v1's sentence". v1 now says generic
"track on explorer ↗" (no host name); v2's own copy is unchanged and correct — updated the comment
only, not the assertion. No other v2 test (history/orders/analytics/shell) referenced v1's copy.

## Flagged, not fixed (scope = ETHERSCAN_TX callers only)
- SwapBox.tsx:422 `addRecord`'s history-row chainId uses live `activeChainId`, not `txChainId`.
- DCAPanel.tsx / ui/v2/dca/DcaCard.tsx fill toasts still lack `chainId` (DCA is Base-pinned).
- ui/v2/swap/SwapCard.tsx:388 `explorerUrl` also derives from live `activeChainId` — v2's analog.
- No dedicated test on the Limit/Conditional **toast's** chainId (only the history-row link).
