# Feedback — fix/limit-sltp-chain-aware-price-feed (Auditor H2 on merge 227a7f2)

## Cited lines — all four CONFIRMED, one refinement

| Claim | Verdict |
|---|---|
| `config.ts:367` `getChainlinkFeeds(_chainId)` discards chainId, returns MAINNET_FEEDS | **Confirmed**, verbatim |
| `limit-launch.ts:45` `chainId === LIMIT_TP_CHAIN_ID` (8453) — Limit/TP Base-only | **Confirmed** |
| `chains/chainlink-feeds.ts:100` `getChainlinkFeed(tokenAddress, chainId)` exists, unused by the panels | **Confirmed** |
| `TeraSwapOrderExecutorV3.sol:504` `_checkPriceCondition` reverts before any fill | **Confirmed, with a refinement** |

Refinement: :504-508 is the **call site**. The revert opcode is at **:1117**, where `_checkPriceCondition`
calls `feed.latestRoundData()` — a mainnet aggregator has no code on Base, so Solidity's extcodesize
guard reverts there and propagates through :504. Effect is exactly as the finding states: every fill
reverts, orders are permanently unfillable/cancel-only. Also `:1105-1108`: `priceFeed == address(0)`
returns `(true, "")` — the DCA "execute unconditionally" branch — so degrading a null feed to a zero
address would *strip the trigger*, not merely fail. That is why the refusal must stay a refusal.

## Task 3 — chose "make it genuinely chain-aware"; the other branch was blocked

`getChainlinkFeeds(chainId)` now returns `MAINNET_FEEDS` for chain 1 and a frozen empty `NO_FEEDS`
for every other chain. Callers, all three:

- `LimitOrderPanel.tsx` / `ConditionalOrderPanel.tsx` — **no longer call it** (now use `getChainlinkFeed`).
- `DCAPanel.tsx:87` inside `_findPriceFeed` — **dead code**: declared, never called anywhere in the
  file (DCA signs `priceFeed = address(0)` at DCAPanel.tsx:956). Unbroken, and behaviourally
  unchanged even if revived, because it would only ever go from a wrong mainnet address to `''`.

The "mark it mainnet-only and drop the parameter" branch would have made `getChainlinkFeeds(chainId)`
a TS arity error at DCAPanel.tsx:87 — and DCAPanel is on this prompt's Do-NOT list. The chosen branch
satisfies the same acceptance (the parameter is load-bearing, not ignored) without touching it. The
table is deliberately **not** grown per chain: a second symbol-keyed map alongside the address-keyed
registry is the duplication that bred this bug.

## Task 2 — the #490 fallback was redundant, proven then deleted

Proof is `LimitOrderPanel.chain-aware-price-feed.test.tsx` → *"the #490 wrapped-native fallback is
redundant"*: it drives a **wrapped-native sell leg** through to signature on Base **and** mainnet, and
asserts `signedPriceFeed === getChainlinkFeed(getWrappedNative(chainId), chainId)`. A helper-level
case also pins `getChainlinkFeed(NATIVE_ETH, c) === getChainlinkFeed(wrapped(c), c)` for both chains.
The fallback existed only because the mainnet **symbol** map has `ETH/USD` and no `WETH/USD`; the
address-keyed helper has no symbol to miss. `getWrappedNative`/`getChainConfig` imports went with it —
the fallback was their only consumer in both panels.

## Failing before → passing after

11 new tests failed on unchanged source, all with the H2 signature (Base signed `0x5f4eC3Df…`,
mainnet ETH/USD, instead of `0x71041ddd…`, Base ETH/USD); the uncovered-chain cases **signed instead
of refusing**. After the change: 15/15 pass. Full suite **3859 passed / 270 files**, typecheck clean,
lint **94 warnings = the exact pre-change ceiling** (measured on stashed baseline), 0 errors.

## Findings for the Architect

**Test gap — the #490 suite was silently exercising this defect.** Every Base run of
`ConditionalOrderPanel.native-out-signs-weth.test.tsx` sold **LINK**, which has no Base feed; those
tests reached a signature *only* because `findPriceFeed` substituted the mainnet LINK aggregator. Same
for the Limit file's Base negative control. Both fixtures moved to sell legs with genuine Base feeds
(USDC / WETH); all tokenOut assertions unchanged. A green suite was proof of the bug, not against it.

**Product consequence on Base — measured over the real catalogs (84 mainnet / 24 Base tokens):**

- Mainnet: **0 lost, 0 changed, 19 gained** (USDT, stETH, PEPE, APE, PAXG, …) — the address map is a
  superset; no regression.
- Base: **4 changed** — ETH, WETH, USDC, DAI all moved from a mainnet aggregator to the correct Base
  one. That is the H2 blast radius, quantified.
- Base: **1 lost** — UNI (`0xc3De…3C83`) previously "resolved" to the mainnet UNI aggregator and now
  refuses. Nothing that actually worked was lost: that address would have reverted every fill. Adding
  a verified Base UNI/LINK feed is a separate, rule-#9-governed change (3-way verification), not this PR.

**Not addressed here (owned elsewhere):** `ConditionalOrderPanel.handleTokenInSelect` (:451) sets the
sell leg to the **raw** pick, so the native sentinel can still land in `tokenIn`. `getChainlinkFeed`
resolves the sentinel correctly so the feed is right either way, but whether the sentinel should reach
the signed `order.tokenIn` belongs to the H1/H3 PR (`useOrderEngine.ts:695-697`).

## Feedback — NARROWING (owner's SPLIT decision, on top of 29d9519)

### Concern — the first cut widened the mainnet signing set as a side effect
- 29d9519 pointed both panels at the address-keyed `getChainlinkFeed` for EVERY chain. Measured over the
  real catalog: mainnet went 7 → 26 signable (19 gained). One gained feed, PEPE's `0x02DE28aB…`, returns
  `0x` from `eth_getCode` on five independent mainnet RPCs (publicnode, drpc, 1rpc, merkle, flashbots).
  ADR-018's `getFeedExpectation` gate runs on the READ path only; `findPriceFeed` never consulted it.
- Narrowed: `resolveOrderPriceFeed` (order-engine/price-feed.ts) — mainnet = origin/main body verbatim
  (symbol table + #490 wrapped-native fallback); every other chain = `getChainlinkFeed`. Mainnet vs
  origin/main over the catalog: **0 gained / 0 lost / 0 changed** (ETH, WETH, USDC, DAI, LINK, UNI, AAVE).
  No denylist, no known-dead list: the mainnet path simply never reads the address-keyed map.

### Test gap — nothing described the signable set
- `price-feed.test.ts` pins symbol → feed per chain (mainnet 7, Base 4, Arbitrum 6) and proves
  structurally that every mainnet answer is one of the 7 table addresses. Re-widening to 29d9519's
  behaviour fails 3 of its 7 tests (`expected {…(26)} to deeply equal {…(7)}`, `USDT signed a non-table
  feed`, PEPE `expected '0x02DE28aB…' to be ''`).

### Edge case — Arbitrum is also newly signable, not only Base
- The chain-aware path makes Arbitrum's 5 registry feeds signable where origin/main signed mainnet
  aggregators. All 8 newly signable addresses (3 Base + 5 Arbitrum) verified on their OWN chain, two RPCs
  each: code 9571 bytes, `description()` = expected pair, `decimals()` 8, `latestRoundData()` > 0.
  Nothing failed, nothing removed. Base UNI (`0xc3De…3C83`) still "loses" its mainnet aggregator — it
  never worked; a Base UNI feed is a separate rule-#9 PR.
