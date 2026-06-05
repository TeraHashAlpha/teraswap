# Sprint 25C — Post-Merge Hotfixes (P149–P151)

> **Date:** 2026-05-20
> **Branch:** `fix/post-merge-hotfixes` (from `main`)
> **Priority:** P0 — production swaps broken
> **Context:** Sprint 25B merged to main. Three issues found in production testing.

---

## P149 — Add missing RPC methods to `/api/rpc` ALLOWED_METHODS

### Context

P142 (Sprint 25B) routed all browser RPC through `/api/rpc` to fix CORS.
The route has an `ALLOWED_METHODS` whitelist (read-only methods). But
wagmi/viem calls additional methods not in the list — the route returns
HTTP 403, breaking wallet interactions, gas estimation, and block queries.

Console evidence: `POST /api/rpc 403 (Forbidden)` × 3 (retries).

### Objective

Add all standard read-only Ethereum JSON-RPC methods that wagmi/viem
uses through the `http()` transport.

### Requirements

1. In `src/app/api/rpc/route.ts`, add these methods to `ALLOWED_METHODS`:
   - `eth_getBlockByNumber` — viem's `getBlock()`, used by fee estimation
   - `eth_getBlockByHash` — viem block lookups
   - `eth_getTransactionCount` — nonce estimation for tx building
   - `net_version` — chain identification (some providers use this)

2. Do NOT add write methods: `eth_sendRawTransaction`,
   `eth_sendTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData*`
   — these must go through the wallet provider.

3. Add a brief test: call `/api/rpc` with `eth_getBlockByNumber` and
   verify it returns a 200 (not 403). Add to an existing RPC test file
   if one exists, or add a simple inline comment test.

### Files affected

- `src/app/api/rpc/route.ts` — ALLOWED_METHODS set

### Expected output

One commit. `/api/rpc` no longer returns 403 for standard read-only
methods. Wagmi block queries and gas estimation work in browser.

### Quality criteria

- All existing tests pass
- TypeScript clean
- No write methods added to the whitelist

---

## P150 — Skip fee integrity check for FeeCollector-routed swaps

### Context

`validateFeeIntegrity()` in `src/lib/api.ts` compares the quote-phase
output (full input amount) against the swap-phase output (net amount
after 0.1% fee deduction). For FeeCollector-routed sources, the swap API
receives 0.1% less input, so the output should be ~0.1% less. The check
has a 2% tolerance.

In production, with small amounts (~$4.50 ETH), KyberSwap's routing
is volatile enough that the fresh swap-time route returns >2% more output
than the stale quote-time route, triggering:

> "Fee verification failed — swap output is unexpectedly high.
> This may indicate the partner fee was not applied."

This is a false positive. The FeeCollector contract enforces the 0.1% fee
on-chain — the aggregator API never handles the fee. The client-side
`validateFeeIntegrity` check was designed for the partner-fee model
(aggregator API applies fee) and is structurally wrong for FeeCollector
routing.

### Objective

Skip the fee integrity check when the swap routes through FeeCollector,
since the on-chain contract guarantees fee enforcement.

### Requirements

1. In `src/hooks/useSwap.ts`, inside `executeStandardSwap`, change the
   fee integrity block (~line 317) to skip when `routeViaFeeCollector`
   is true:

   ```typescript
   // [M-01] Fee integrity check — only for non-FeeCollector routes.
   // When routeViaFeeCollector=true the on-chain contract enforces the
   // 0.1% fee; the aggregator API never sees it. Comparing quote output
   // (full amount) vs swap output (net amount) produces false positives
   // because the API is called with 0.1% less input, and routing
   // volatility on small amounts can exceed the 2% tolerance.
   if (quoteToAmount && !routeViaFeeCollector) {
     const feeCheck = validateFeeIntegrity(quoteToAmount, swapData.toAmount, source)
     // ... existing block unchanged
   }
   ```

2. Do NOT remove `validateFeeIntegrity` entirely — it's still valid for
   non-FC routes (future use when we have partner-fee integrations).

3. Add or update the test in `src/hooks/__tests__/swap-validations.test.ts`
   to verify that fee integrity is skipped when `routeViaFeeCollector=true`.

### Files affected

- `src/hooks/useSwap.ts` (~line 317)
- `src/hooks/__tests__/swap-validations.test.ts` (new test case)

### Expected output

One commit. KyberSwap swaps through FeeCollector no longer trigger the
false positive. Fee integrity still runs for non-FC routes.

### Quality criteria

- All existing tests pass + new test covers the skip logic
- TypeScript clean
- `validateFeeIntegrity` function unchanged (only the call site guarded)

---

## P151 — Add KyberSwap to temporary FEE_INCOMPATIBLE_SOURCES + harden adapter JSON parsing

### Context

**Part A — KyberSwap simulation revert:**

Production shows "Simulation reverted: swap would fail on-chain" for
KyberSwap swaps. The most likely cause: KyberSwap's router
(`0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`) may not be on the
FeeCollector V1 on-chain whitelist. V1 was bootstrapped with a limited
set of routers, and KyberSwap MetaAggregationRouterV2 may not have been
included.

Since `NEXT_PUBLIC_FEE_COLLECTOR` still points to V1 (V2 switch after
timelocks 2026-05-22), KyberSwap swaps through FeeCollector V1 will
revert with `RouterNotWhitelisted`.

**Part B — HTML response from DEX APIs:**

Some DEX APIs return HTTP 200 with HTML body (maintenance pages, error
pages) for unsupported tokens like USDe. The adapter's `res.json()` call
fails with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.

### Objective

A) Temporarily bypass FeeCollector for KyberSwap (like P141 did for
   uniswapv3 and odos).
B) Wrap adapter `res.json()` calls in try-catch to produce a clean error
   instead of propagating the JSON parse error.

### Requirements

**Part A:**

1. In `src/lib/constants.ts`, add `'kyberswap'` to
   `FEE_INCOMPATIBLE_SOURCES`:

   ```typescript
   export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
     '0x', 'cowswap', 'uniswapv3', 'odos', 'kyberswap'
   ]
   ```

2. Update the comment block to document that `kyberswap` is TEMPORARY
   (same as uniswapv3 and odos) — revert after router timelocks execute
   2026-05-22 and `NEXT_PUBLIC_FEE_COLLECTOR` switches to V2.

**Part B:**

3. In each adapter that calls external APIs (`src/lib/adapters/*.ts`),
   wrap the `res.json()` call in a try-catch that converts JSON parse
   errors to a readable adapter error:

   ```typescript
   let data
   try {
     data = await res.json()
   } catch {
     throw new Error(`${adapterName}: invalid response (non-JSON). API may be down.`)
   }
   ```

   Apply to ALL adapters' `fetch()` → `.json()` call sites:
   - `src/lib/adapters/kyberswap.ts` (2 json() calls in fetchQuote + 2 in fetchSwapData = 4)
   - `src/lib/adapters/velora.ts` (1 in fetchQuote + 2 in fetchSwapData = 3)
   - `src/lib/adapters/oneinch.ts` (fetchQuote + fetchSwapData)
   - `src/lib/adapters/odos.ts` (fetchQuote + fetchSwapData)
   - `src/lib/adapters/zerox.ts` (fetchQuote + fetchSwapData)
   - `src/lib/adapters/openocean.ts` (if exists)
   - `src/lib/adapters/sushiswap.ts` (if exists)
   - `src/lib/adapters/balancer.ts` (if exists)
   - `src/lib/adapters/curve.ts` (if exists)

   For adapters accessed via `src/app/api/rpc/route.ts` or
   `src/app/api/quote/route.ts` — these already return JSON error
   responses, so no change needed there.

4. Do NOT wrap the `/api/rpc` or `/api/swap` internal `res.json()` calls
   — those are our own endpoints and should always return JSON. If they
   don't, that's a different bug.

### Files affected

- `src/lib/constants.ts` — FEE_INCOMPATIBLE_SOURCES
- `src/lib/adapters/*.ts` — JSON parse hardening (all adapter files)

### Expected output

Two commits (one per part, or combined if small). KyberSwap swaps bypass
FeeCollector temporarily. Adapter JSON parse errors produce clean messages
instead of "Unexpected token '<'".

### Quality criteria

- All existing tests pass
- TypeScript clean
- No adapter crashes on HTML response from any DEX API
- KyberSwap swaps work in direct mode (no FeeCollector)

---

## Do NOT

- Do NOT change `NEXT_PUBLIC_FEE_COLLECTOR` on Vercel — still V1 until timelocks
- Do NOT revert P141 — uniswapv3 and odos still need the bypass
- Do NOT add write methods to `/api/rpc` ALLOWED_METHODS
- Do NOT remove `validateFeeIntegrity` — just skip the call site for FC routing
- Do NOT modify `src/lib/api.ts` `validateFeeIntegrity` function body

---

## Post-deploy checklist

1. Verify `/api/rpc` no longer returns 403 (browser console clean of 403s)
2. Test KyberSwap quote + swap (ETH → AAVE or USDC) — should work without fee integrity error
3. Test with USDe or other obscure token — should show "API may be down" instead of DOCTYPE error
4. Verify quote refresh button (⟳) still works
5. Verify source toggle still works
