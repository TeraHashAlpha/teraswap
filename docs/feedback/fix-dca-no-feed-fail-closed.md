# Feedback — fix/dca-no-feed-fail-closed

## Pattern matched (Task 1)

`LimitOrderPanel.tsx:410` / `ConditionalOrderPanel.tsx:318` — compute `minAmountOutBn`, call
`checkMinOutEconomicFloor`, on `blocked` do `stopWaitingSound()` + set the panel's single submit
error + `return`, all before `onSubmit`. Copied verbatim into `DCAPanel.handleCreate`. One argument
differs: `tokenOutUsdPrice` is `chainlinkPriceOut ?? llamaPriceOut` (the panel's existing
`livePriceIn` tiering, applied to the buy leg) instead of the other panels'
`isStablecoin(tokenOut) ? 1 : null` — those panels have no live tokenOut price in scope, this one
already computes it, and the literal would leave the guard inert for almost every DCA. Scoped to
`v3Enabled`, matching the server gate's own `if (isV3Order)`.

## Feed sentinel (Task 2)

Source queried: `tokenUsdFeeds(address)` on the Base OrderExecutorV3
`0x686b4f812291F4De238E59ED00BA6dD6129e60a0` — the mapping `_readFeedUsd` reads at
`TeraSwapOrderExecutorV3.sol:1046`, which is what sets `hasFeed` at `:540`. Identity confirmed
before trusting the address (`docs/DEPLOYMENTS.md` warns it collides across chains): V3-only
`ORDER_TYPEHASH()` answers `0xfc939b74…cbc0` and `sequencerUptimeFeed()` answers
`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (Base's Chainlink sequencer feed).

```
cast call 0x686b…60a0 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" <token> \
  --rpc-url https://mainnet.base.org            # 2026-09-09, read-only eth_call

WETH  0x4200…0006 → 0x71041ddd…Bb70, 8, 18, 3600,  registered=true
USDC  0x8335…2913 → 0x458138Fc…9061, 8,  6, 90000, registered=true
ETHFI 0xFe0c…C0eB → 0x0000…0000,     0,  0, 0,     registered=false
```

### Concern — the panel's DEFAULT pair is affected

DCA's default output is native ETH, and `useOrderEngine.createOrder` resolves only `tokenIn`
native→wrapped, so `order.tokenOut` is signed as the `0xEeee…EEeE` sentinel. That address is
**not registered** on Base (same query, `registered=false`), so WETH→ETH now blocks. It is not a
false positive: `IERC20(0xEeee…).balanceOf` reverts (`cast` reports "does not have any code"), so
V3:579 would revert on every fill — those orders were already unexecutable. Worth an Architect
decision on whether the panel should resolve a native-ETH OUTPUT to WETH; this PR deliberately does
not, because normalising an address the signed struct does not normalise is a fail-open.

## Modal copy (Task 3)

The DCA path to `NoFeedConsentModal` is removed; the component is retained and marked superseded
(rule #4) with the claim corrected, so a future re-wiring cannot resurrect it.

- **Before:** "Your buys still only happen at the lowest amount you agree to each time, so you're
  not unprotected — but there's no live-price referee double-checking the market for this coin."
- **After (unreachable, corrected):** "The floor your buys are set against is a last-resort
  backstop, not a fair-price check: it sits low enough that a bad deal could still go through."
- **What a user now sees instead:** "Recurring buys are unavailable for ETHFI (the token you're
  buying): the order engine on Base has no registered price source for this token, so every buy
  would run without a live-price floor."

## Failing-then-passing test (Task 4)

`src/components/DCAPanel.nofeed-fail-closed.test.tsx`. It drives the real `OrderReviewModal` and
clicks every control the UI offers, then asserts `writeContractAsync` (the approval tx) and
`signTypedDataAsync` were never called. With only `DCAPanel.tsx` reverted to `origin/main`:
`5 failed | 2 passed`, first failure `expected "vi.fn()" to not be called at all, but actually
been called 1 times` — an on-chain approval was reached. With the fix: `7 passed`.

### Test gap closed by relocation, not deletion

`DCAPanel.nofeed-consent.test.tsx` pinned the superseded consent behaviour; it is inverted in place
rather than dropped, and its jargon-denylist copy tests moved intact to
`NoFeedConsentModal.test.tsx` (the panel can no longer reach the modal to render it).
`DCAPanel.oracle-fail-closed.test.tsx`'s L-1 block drove `handleNoFeedAccept`, which no longer
exists; the same scenario now runs through `clickBypassingDisabled`, so the in-handler oracle guard
stays pinned.

## What this does NOT protect against

It is a client guard, not the security boundary: anything that posts to `/api/orders` without this
UI is unaffected, so the server check at `api/orders/route.ts` and the on-chain
`max(oracleFloor, scaledMin)` remain the only enforcement — this only stops a user spending an
approval and a signature on an order the contract cannot protect.
