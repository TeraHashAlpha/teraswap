# Feedback — ADR-020 / finding B6 (cbe3781, 945b784)

### Callers, and how each now refuses

| Path | Reads | Refusal on an unknown chain |
|---|---|---|
| `DCAPanel.tsx:725` | `getDefaultRouter` | `setRouteBlock(NO_ROUTER_FOR_CHAIN_REASON)` + `return`, **before** `startWaitingSound()` and before the `/api/quote` routability probe — nothing quoted, approved or signed |
| `LimitOrderPanel.tsx:351` | `getDefaultRouter` | `setSubmitError(NO_ROUTER_FOR_CHAIN_REASON)` + `return`, before the price-feed and dust-floor work (so the chain gap is reported as itself, not as a token problem) |
| `ConditionalOrderPanel.tsx:262` | `getDefaultRouter` | same as Limit |
| `LimitOrderPanel` / `ConditionalOrderPanel` v3 branch | `getCanonicalRouteRouter` | already `if (!canonicalRouter \|\| !executorV3) return` — unchanged, now actually reachable |
| `limit-launch.ts:47` `isLimitLive` | `getCanonicalRouteRouter` | `!== null` was already there; now load-bearing on every chain, not only via the `chainId === 8453` clause |
| `api/orders/route.ts:447` | `isWhitelistedRouter` | existing 400 `Router … is not served on chain N` — now fires because the chain's set is empty, instead of passing because mainnet's set was consulted |
| `dca/SettlementReceiptModal.tsx:53` | `getWhitelistedRouters` | display only: degrades to the generic `our route` instead of confidently printing a mainnet router's label |

**Compile-time half:** `getDefaultRouter` is now `RouterEntry | null`, so `getDefaultRouter(chainId).address` does not build. That, not review, is what stops the next caller.

### Chains 1 / 8453 — before vs after

Byte-identical. Inline snapshots in `router-map-fail-closed.test.ts` were captured by running the file against the **pre-change** code and are unchanged after it: map(1) = `1inch` / `0x` / `paraswap` / `uniswapV3`; map(8453) = `augustusV6` / `uniswapV3`; `getDefaultRouter(1)` = 1inch v6, `getDefaultRouter(8453)` = ParaSwap Augustus v6; `getCanonicalRouteRouter(1)` = Uniswap V3 SwapRouter, `(8453)` = Uniswap SwapRouter02. Pre-change run of that file: **13/13 green** in the snapshot block, **38 failed / 20 passed** overall — the 38 are the fail-closed assertions and negative controls.

### Acceptance

1. **Pass.** `getWhitelistedRouters(42161)` → `{}` (frozen, shared, `!== ` either sibling map); `getDefaultRouter(42161)` → `null`; `isWhitelistedRouter(42161, addr)` → `false` for every address **read from** `getWhitelistedRouters(1)` / `(8453)`, none typed. Same for 10/137/56/0/−1/999999. These 38 assertions fail on `origin/main`.
2. **Pass.** Snapshots above; plus every mainnet/Base address still validates on its own chain (checksummed, lower, upper) and on neither sibling.
3. **Pass.** One refusal test per consuming path: `DCAPanel.router-fail-closed.test.tsx` (4), appended describes in `LimitOrderPanel.test.tsx` (3) and `ConditionalOrderPanel.test.tsx` (3), `orders-p1b.test.ts` (3 — wires a v3 executor on 42161 to simulate the eligibility flip, leaves the router map real), `SettlementReceiptModal.test.tsx` (2). Each asserts the named reason AND that `createOrder` was never called; each has a sanity assertion that the fixture chains really differ, so none can pass vacuously.
4. **Pass.** 3596 tests / 252 files green; `tsc --noEmit` clean; lint 0 errors / 94 warnings — at the configured `--max-warnings 94` ceiling, unchanged.

### Concern

- **The DCA branch of `/api/orders` never reaches the router gate.** It is scoped to `isV3Order && orderTypeEnum !== ORDER_TYPE_DCA` (route.ts:445), so a hand-crafted DCA POST is not router-checked server-side at all — the client guard is the only one. Pre-existing, unchanged here, named in ADR-020 "Not covered here".
- **`SettlementReceiptModal` defaults `order.chainId ?? 1`** (`:187`), so a row with a null `chain_id` resolves labels against mainnet. Display-only, but it is a mainnet default surviving in a file this ADR is about.

### Edge case

- `contracts/order-engine/executor/gas-tier.js:156` cites "this repo's existing *unknown chain → mainnet fallback* convention (e.g. `getWhitelistedRouters`)" to justify its own mainnet fallback. That citation is now stale. Left untouched (keeper is out of scope) — worth a follow-up so the comment does not re-legitimise the pattern.

### For the Auditor — attack this first

The DCA server path: POST a DCA order with `chainId` on a chain that has an eligible v3 executor but no `ROUTERS_BY_CHAIN` entry, carrying any `router`, and confirm nothing but the client refuses it.
