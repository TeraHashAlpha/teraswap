# Sprint 25D — RPC Blacklist + Velora FeeCollector Bypass (P152–P153)

> **Date:** 2026-05-20
> **Branch:** `fix/quote-routing-and-sim` (continue from Sprint 25C)
> **Priority:** P0 — production swaps still partially broken
> **Context:** Sprint 25C deployed (PR #76). Two residual issues found.

---

## P152 — Switch `/api/rpc` from method whitelist to blacklist

### Context

P149 added 4 methods to ALLOWED_METHODS but `/api/rpc` is still
returning 403 in production. Wagmi/viem calls many RPC methods and
the list keeps growing — we're playing whack-a-mole.

A safer approach: block ONLY dangerous write/sign methods, allow
everything else. The RPC proxy's purpose is privacy (hide user IP)
and preventing transaction submission — not restricting read methods.

### Objective

Replace the `ALLOWED_METHODS` whitelist with a `BLOCKED_METHODS`
blacklist. All methods pass EXCEPT write/sign methods.

### Requirements

1. In `src/app/api/rpc/route.ts`, replace the whitelist approach:

   ```typescript
   // Methods that MUST go through the wallet provider, not our proxy.
   // Signing and sending require the user's private key context.
   const BLOCKED_METHODS = new Set([
     'eth_sendRawTransaction',
     'eth_sendTransaction',
     'eth_sign',
     'eth_signTransaction',
     'eth_signTypedData',
     'eth_signTypedData_v3',
     'eth_signTypedData_v4',
     'personal_sign',
     'wallet_addEthereumChain',
     'wallet_switchEthereumChain',
     'wallet_requestPermissions',
     'wallet_watchAsset',
   ])
   ```

2. Change the validation logic from "reject if NOT in allowed" to
   "reject if IN blocked":

   ```typescript
   if (BLOCKED_METHODS.has(rpcReq.method)) {
     return NextResponse.json(
       { jsonrpc: '2.0', id: rpcReq.id,
         error: { code: -32601, message: `Method ${rpcReq.method} not allowed via proxy` } },
       { status: 403 },
     )
   }
   ```

3. Remove the old `ALLOWED_METHODS` set entirely.

4. Update the JSDoc comment to explain the blacklist approach.

### Files affected

- `src/app/api/rpc/route.ts`

### Do NOT

- Do NOT remove rate limiting — keep the existing Upstash rate limit check
- Do NOT allow `eth_sendRawTransaction` or any sign methods

### Expected output

One commit. No more 403s for legitimate read methods. Only write/sign
methods are blocked.

### Quality criteria

- All existing tests pass
- TypeScript clean
- `eth_sendRawTransaction` still returns 403
- `eth_getBlockByNumber`, `eth_getStorageAt`, `eth_getProof`, etc. all return 200

---

## P153 — Add velora to temporary FEE_INCOMPATIBLE_SOURCES

### Context

Velora quotes work (Best via Velora, 9.1361 USDC shown in UI), but
swaps revert in simulation. Velora uses ParaSwap Augustus V6 router
(`0x6A000F20005980200259B80c5102003040001068`). This router was added
to the frontend `ROUTER_WHITELIST` (P146) but is NOT on the FeeCollector
V1 on-chain whitelist. Swaps through FeeCollector V1 revert with
`RouterNotWhitelisted`.

Same pattern as uniswapv3, odos, and kyberswap — all need temporary
bypass until the router timelocks execute (2026-05-22) and
`NEXT_PUBLIC_FEE_COLLECTOR` switches to V2.

### Objective

Add `'velora'` to `FEE_INCOMPATIBLE_SOURCES` temporarily.

### Requirements

1. In `src/lib/constants.ts`, add `'velora'` to
   `FEE_INCOMPATIBLE_SOURCES`:

   ```typescript
   export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
     '0x', 'cowswap', 'uniswapv3', 'odos', 'kyberswap', 'velora'
   ]
   ```

2. Update the comment block to include Velora's Augustus V6 router
   address (`0x6A000F20...`) in the TEMPORARY list.

3. While at it: verify which other sources could also hit this problem.
   Check `AGGREGATOR_META` for remaining sources NOT in the list:
   `1inch`, `openocean`, `sushiswap`, `balancer`, `curve`.

   If ANY of these uses a router that might not be on V1's on-chain
   whitelist, add them too. The safest approach: add ALL remaining
   sources except the two permanent ones (0x, cowswap) to the TEMPORARY
   list. Revenue is already being forgone on 4 sources — better to have
   working swaps on all sources than collect 0.1% on some and fail on
   others.

   If you choose to add all, the list becomes:
   ```typescript
   export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
     '0x', 'cowswap',       // permanent
     'uniswapv3', 'odos', 'kyberswap', 'velora',   // temporary
     '1inch', 'openocean', 'sushiswap', 'balancer', 'curve',  // temporary (precautionary)
   ]
   ```

   Document clearly which are permanent vs temporary.

### Files affected

- `src/lib/constants.ts` — FEE_INCOMPATIBLE_SOURCES

### Expected output

One commit. Velora swaps (and all other source swaps) bypass
FeeCollector V1 temporarily. All swaps work in direct mode.

### Quality criteria

- All existing tests pass
- TypeScript clean
- Velora quote + swap works (direct mode, no FeeCollector)
