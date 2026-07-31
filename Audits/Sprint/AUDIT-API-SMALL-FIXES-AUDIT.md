# AUDIT — chore/api-small-fixes (Auditor, read-only)

**Audited SHA:** `793f29fffb8f554b86e2924c81c78bb82672562d` (`origin/chore/api-small-fixes`, 3 commits, all signed).
Scope: only the 2 fund-adjacent commits + cited files. **Verdict: APPROVED — 0C / 0H / 0M / 0L.**

## Severity counts: C 0 · H 0 · M 0 · L 0 (1 INFO)

## 5a2802f — thread chainId through `computeTokenAmountUsd` (P2 value gate)
1. **Feed correctness — on-chain-verified (this run, Base RPC).** WETH `0x4200…0006`→`0x71041ddd…Bb70`
   `description()=="ETH / USD"`; USDC `0x833589…2913`→`0x458138Fc…9061` `"USDC / USD"`; DAI `0x50c5…0Cb`→
   `0x591e7923…C78F` `"DAI / USD"` — all correct. **cbETH + USDbC are ABSENT from `CHAINLINK_FEEDS_BY_CHAIN[8453]`**
   (`chainlink-feeds.ts:32-36` documents cbETH=composed-only, USDbC=no Base feed) → `getChainlinkFeed`→null→DefiLlama
   fallback. **No invented/unverified address.** The commit adds no feed address (reuses the 9S map).
2. **chainId threaded end-to-end — no residual mainnet.** `computeTokenAmountUsd(t, amt, chainId)`
   (`chainlink.ts:499`) → `fetchChainlinkPriceRaw(t, chainId)` → `getChainlinkFeed(t, chainId)` +
   `getComposedFeed(t, chainId)` (`:293-295`, chain-keyed lookup) and `fetchErc20Decimals(t, chainId)` →
   `rpcCall(…, chainId)` → `getRpcUrlForChain(chainId)` (never falls back to mainnet). Call site
   `swap/route.ts:271-272` passes `swapChainId` for **both legs** and removes the old `=== DEFAULT_CHAIN_ID` skip.
   No mainnet hardcode in the feed lookup or the decimals read.
3. **Fail-closed preserved / gate not loosened.** The route diff touches ONLY the `computeTokenAmountUsd` call —
   `if (!valuePriced) → 422 {unpriceable:true}`, `estimatedValueUsd = Math.max(...candidates)`, the $10k threshold and
   the max(in,out) logic are **untouched**. A wrong/stale Base feed cannot mis-price the gate: `fetchChainlinkPriceRaw`
   still applies `validateRoundData` (staleness/round-integrity) → null → DefiLlama. Net effect = Base WETH/USDC/DAI
   legs now priceable via Chainlink *in addition to* DefiLlama → strictly more coverage, no fail-open path introduced.

## 79bd6ec — `/api/orders/stats` recentExecutions 24h schema
- Correct 24h counts: was `executed_at` + `.eq('wallet',…)` on `order_executions` (columns that **don't exist** →
  wrong/erroring count). Now `created_at` + `orders!inner(wallet)` join + `.eq('orders.wallet', wallet.toLowerCase())`
  (`route.ts:60-67`) — real timestamp, real wallet path.
- **No cross-wallet leak.** With `wallet` set, the count is scoped to executions whose parent order belongs to that
  wallet — a caller cannot read another wallet's executions. With no `wallet`, it returns a **global aggregate COUNT**
  (`head:true`, no rows) — an operational metric, no per-wallet data. Service-role + app-layer scoping (consistent with
  the campaign's W6 read model). No error on empty (inner join → 0 rows → count 0).

## Findings
- **INFO** `orders/stats/route.ts` — `recentExecutions` is destructured without an explicit `?? 0` (the sibling counts
  use it); with `count:'exact'` Supabase returns `0` (not null) on empty, so this is cosmetic — not a leak/error. No fix required.

## Verdict
**APPROVED — 0C / 0H. Both commits may merge.** Base Chainlink feeds are real (on-chain-verified: ETH/USD, USDC/USD,
DAI/USD) with cbETH/USDbC correctly falling back to DefiLlama (no invented address); chainId is threaded through the
feed lookup and `fetchErc20Decimals` with no mainnet residue; the >$10k P2 gate stays fail-closed and un-loosened; the
orders/stats fix is wallet-scoped with no cross-wallet leak. Read-only; no edits; SSH-sign left for owner.
