# Listing TeraSwap on DefiLlama — submission note

TeraSwap is a DEX **meta-aggregator**: swaps route through other DEXes' routers and funds
never sit in a TeraSwap contract, so on-chain TVL is **~0 by design**. The correct listing is
**volume + fees**, via `DefiLlama/dimension-adapters` (category `dexs`, `Aggregator`) — **not**
the `DefiLlama-Adapters` TVL repo.

## Target path in the DefiLlama fork

`dexs/teraswap/index.js`

## Submission steps

1. Fork [`DefiLlama/dimension-adapters`](https://github.com/DefiLlama/dimension-adapters).
2. Copy `teraswap.js` (this directory) to `dexs/teraswap/index.js`, adjusting the two
   `require(...)` paths at the top (`../helpers/chains`, `../adapter.type`) to whatever that
   repo's helper/SDK layout is at PR time — they move occasionally; the adapter logic itself
   (event, fields, chains, methodology) does not need to change.
3. Fill in the two `start:` TODOs with the actual FeeCollector deployment date/block per chain
   (Etherscan/Basescan "Contract Creation" tx of `0x47f2…7459` / `0xeFC3…f130` — left as a
   placeholder here since this task was scoped read-only on the contracts).
4. Run the DefiLlama repo's local test harness for the new adapter (`npm test -- teraswap`, per
   their CONTRIBUTING guide) to confirm it returns non-zero volume for a known historical day.
5. Open a PR against `DefiLlama/dimension-adapters` with the methodology paragraph below.

## Methodology (for the PR description)

> TeraSwap is a DEX meta-aggregator whose users pay a flat 0.1% (10 bps) protocol fee on every
> swap, collected on-chain by the `TeraSwapFeeCollector` proxy contract before the trade is
> forwarded to the winning router (1inch, 0x, Uniswap, Velora, etc.). Each fee-collected swap
> emits one `SwapWithFee(user, router, tokenIn, totalAmount, feeAmount, tokenOut, outputAmount)`
> event. Daily volume sums `totalAmount` (the pre-fee notional, priced in `tokenIn`); daily fees
> sum `feeAmount` (same token, so no cross-token conversion is required); daily revenue equals
> fees, since TeraSwap keeps 100% of the 0.1% with no fee-sharing. Both chains (Ethereum mainnet
> and Base) run the identical contract source at their own FeeCollector deployment.
