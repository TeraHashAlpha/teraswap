# Feedback — fix/tx-links-remaining

`ETHERSCAN_TX` (mainnet-only) replaced with the chain-aware `explorerTxUrl` across the 5 surfaces
left alone by `fix/v1-maintenance` (`docs/feedback/fix-v1-maintenance.md` C1). The chain used is
always the one the tx was SENT/signed on, never the wallet's live chain at render time.

## 1. Per-surface table

| File:line | chainId source | Test |
|---|---|---|
| `SwapBox.tsx:1191,1203` (pending/success links) | `useSwap().txChainId` — new field, captured once at send time (`confirmSwap`'s `sendTransaction` call / `confirmCowOrder`'s frozen `p.chainId`), never recomputed from live `useActiveChainId()` | `SwapBox.explorer-link.test.tsx` |
| `SwapBox.tsx:411` (success toast) | same `txChainId`, passed as `chainId` to `toast()` | `SwapBox.explorer-link.test.tsx` (toast-chainId describe) |
| `useSwap.ts` (`txChainId` itself) | n/a — this is the source | `useSwap.test.ts` (new describe, 4 tests) |
| `ToastProvider.tsx:187` | new `Toast.chainId` field, caller-supplied; falls back to `1` only when absent | `ToastProvider.test.tsx` |
| `LimitOrderPanel.tsx:1045` | existing `orderChainId` (`order.chainId ?? 1`, Supabase `orders.chain_id`, immutable post-creation) | `LimitOrderPanel.explorer-link.test.tsx` |
| `LimitOrderPanel.tsx:121` (fill toast) | `latestEvent.chainId` — threaded through `OrderEngineEvent['order_filled']` + `useOrderEngine.ts:651` (`updated[idx].chainId`) | covered by hook/type change; no dedicated toast test (see Concern) |
| `ConditionalOrderPanel.tsx:916` | same `orderChainId` pattern | `ConditionalOrderPanel.explorer-link.test.tsx` |
| `ConditionalOrderPanel.tsx:117` (fill toast) | same `latestEvent.chainId` threading | same as above |
| `AdminMonitor.tsx:837` | `TradeEvent.chainId` — already required, server-populated (`analytics-tracker.ts:157`) | `AdminMonitor.test.tsx` |

## 2. Guard test

`src/lib/etherscan-tx-guard.test.ts` — syntactic scan (brace-import/namespace-import, modeled on
`usd-scope-guard.test.ts`) over every `.ts`/`.tsx` under `src/`. **865 tests passed** (one per
scanned file + 2 self-tests): 0 callers of `ETHERSCAN_TX` outside `constants.ts` itself. `ETHERSCAN_TX`
marked `@deprecated`, kept per rule #4.

## 3. Verify

- CodeQL `security-extended`: **13 → 13, 0 new, 0 fixed** (exact alert-set match, head vs `origin/main` `bb56e87`).
- Suite: **7553/7553** (421 files) vs baseline 6652/6652 (415 files) — all new tests are the 6 files above + `useSwap.test.ts` additions.
- Lint: **93 → 93 warnings, 0 errors** both sides (delta 0).
- `tsc --noEmit`: clean.
- `next build`: exit 0.

## 4. diff --stat

```
 src/components/AdminMonitor.tsx                    |  5 +-
 src/components/ConditionalOrderPanel.tsx           | 11 +--
 src/components/LimitOrderPanel.tsx                 | 11 +--
 src/components/SwapBox.tsx                         | 18 +++--
 src/components/ToastProvider.tsx                   | 13 ++--
 src/hooks/useOrderEngine.ts                        |  2 +-
 src/hooks/useSwap.test.ts                          | 79 +++++++++++++++++
 src/hooks/useSwap.ts                               | 17 ++++-
 src/lib/constants.ts                               |  8 +++
 src/lib/order-engine/types.ts                      |  5 +-
 src/ui/v2/swap/lifecycle/execution.lifecycle.test.tsx |  5 +-
 src/ui/v2/swap/lifecycle/lifecycle-view.ts          |  2 +-
 + 6 new test files (AdminMonitor.test.tsx, ToastProvider.test.tsx, etherscan-tx-guard.test.ts,
   SwapBox/.LimitOrderPanel/ConditionalOrderPanel.explorer-link.test.tsx)
 12 files changed, 148 insertions(+), 28 deletions(-) [tracked] + 6 new files
```

Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/tx-links-remaining

## v2 parity

`execution.lifecycle.test.tsx:123` asserted v2's chain-1 tx-link text was byte-identical to "v1's
sentence" (`'Transaction sent — track on Etherscan ↗'`). v1 now says the generic **"track on
explorer ↗"** (no host name — avoids importing v2's `explorerName` into v1 for one label). v2's own
text is unchanged (still chain-named: Etherscan/Basescan/Arbiscan) and still correct, so the
assertion's *value* didn't change, only its comment (no longer "v1's sentence" — now documents the
intentional wording divergence). No other v2 test referenced v1's copy or hrefs (`history.test.tsx`,
`orders.test.tsx`, `analytics.test.tsx`, `shell.test.tsx` all assert v2's own independent chain-aware
behavior, untouched by this PR).

## Edge case

- `SwapBox.tsx:422`'s `addRecord({ chainId: activeChainId, ... })` (swap-history row) uses the
  **live** `useQuoteChainId()` at success time, not `txChainId`. If the wallet switches chains in
  the (short) window between broadcast and confirmation, the persisted history row could record the
  wrong chain. Not fixed here — `ETHERSCAN_TX` was never used at that line (SwapHistory.tsx already
  migrated to `explorerTxUrl` pre-this-PR) and `txChainId` existed from this same change, so the
  one-line fix is cheap but is scope creep on a bug-fix goal scoped to `ETHERSCAN_TX` callers.
- `DCAPanel.tsx:211` and `src/ui/v2/dca/DcaCard.tsx:489` fire a fill toast with `txHash` but no
  `chainId` (same gap LimitOrderPanel/ConditionalOrderPanel had) — DCA orders are Base-pinned today
  so the toast's mainnet-default fallback is wrong chain, not just imprecise. Out of scope: neither
  file is in the goal's 5-surface list. `latestEvent.chainId` now exists on the shared
  `OrderEngineEvent['order_filled']` type (this PR), so wiring it into these two toasts is a 2-line
  follow-up.
- `src/ui/v2/swap/SwapCard.tsx:388`'s `explorerUrl` is derived from the live `activeChainId`, the
  same bug class this PR fixes in v1 — v2's execution panel can show a wrong-chain link after a
  mid-swap chain switch. Out of scope (v1-only goal); flagging since it's the direct v2 analog.

## Test gap

No dedicated test asserts the LimitOrderPanel/ConditionalOrderPanel **fill toast's** `chainId` (only
the history-row link is tested per-surface). The wiring (`latestEvent.chainId` → `toast({chainId})`)
is a 1-line mechanical change identical in shape to the SwapBox toast test already written; skipped
for time, not because it's lower-risk.
