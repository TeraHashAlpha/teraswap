# Sprint 25E — RPC Rate Limit Increase + 1inch Error Context (P154–P155)

> **Date:** 2026-05-20
> **Branch:** `fix/quote-routing-and-sim` (continue — Sprint 25D commits already here)
> **Priority:** P0 — wallet extension burns RPC budget, causing intermittent simulation failures
> **Context:** Sprint 25D deployed to preview (PR open, NOT merged to main). `/api/rpc` 403s
>   fixed by blacklist. Quotes and swaps (Velora, KyberSwap, Uniswap V3) all working.
>   Two residual issues found in production testing.

---

## P154 — Increase RPC_RATE_LIMIT from 60 → 300/min

### Context

Console shows dozens of `POST /api/rpc 429 (Too Many Requests)` all from
`injected.js:1` — the wallet extension (MetaMask/Rainbow) uses our
`/api/rpc` endpoint for its own background polling (block headers, balance
updates, token prices, gas estimates). At 60 req/min per IP, the wallet
exhausts the entire budget in seconds, starving our own legitimate calls
(simulation `eth_call`, gas estimation, chain ID queries).

Result: Uniswap V3 simulation intermittently reverts with "swap would
fail on-chain" — the underlying `eth_call` returns 429 instead of the
simulation result. Retrying after a minute works because the rate window
resets.

With Sprint 25D's blacklist approach, the RPC proxy is structurally safe:
only read methods pass through, all write/sign methods are blocked. The
proxy's purpose is IP privacy, not access control. Higher limits are safe.

### Objective

Increase `RPC_RATE_LIMIT` from 60 to 300 requests per 60-second window.
This gives enough headroom for wallet polling (~30-50 req/min) plus our
own app calls (~10-20 req/min) plus margin.

### Requirements

1. In `src/lib/kv-rate-limiter.ts`, change line 28:

   ```typescript
   // Before:
   export const RPC_RATE_LIMIT = { limit: 60, windowMs: 60_000 }
   
   // After:
   export const RPC_RATE_LIMIT = { limit: 300, windowMs: 60_000 }
   ```

2. Update the comment near the RPC_RATE_LIMIT line to explain why
   300 is safe:

   ```typescript
   // RPC proxy is read-only (blacklist blocks all write/sign methods in
   // route.ts). Wallet extensions (MetaMask, Rainbow) poll through this
   // endpoint, consuming ~30-50 req/min. 300/min gives headroom for
   // wallet + app + simulation calls without starving any.
   export const RPC_RATE_LIMIT = { limit: 300, windowMs: 60_000 }
   ```

3. Do NOT change SWAP_RATE_LIMIT or QUOTE_RATE_LIMIT — those protect
   external API calls and should stay conservative.

### Files affected

- `src/lib/kv-rate-limiter.ts` — RPC_RATE_LIMIT constant

### Do NOT

- Do NOT increase SWAP_RATE_LIMIT or QUOTE_RATE_LIMIT
- Do NOT remove the rate limiter entirely — 300/min still protects against abuse
- Do NOT change the sliding-window logic or fallback behaviour

### Expected output

One commit. Wallet polling no longer exhausts the RPC rate budget.
Simulations stop failing intermittently.

### Quality criteria

- All existing tests pass
- TypeScript clean
- SWAP and QUOTE limits unchanged
- Fallback limiter (ceil(300/2) = 150) still reasonable

---

## P155 — Improve 1inch adapter error messages with response body context

### Context

When 1inch returns HTTP 403, the adapter throws `1inch 403` which
`classifyAdapterError()` maps to "Access denied — API key may be invalid."
This is shown to the user but doesn't help diagnose:
- Is the API key missing? → `ONEINCH_API_KEY` not set in Vercel
- Is the API key expired/revoked? → need to regenerate at 1inch.dev
- Is 1inch rate-limiting us? → their own per-key limits
- Does 1inch not support the token? → pair-specific rejection

The 1inch API returns a JSON body with a `description` field on error
responses. We should read it and include it in the error message.

### Objective

Read the response body on non-ok 1inch responses and include the
upstream error description in the thrown Error message, so
`classifyAdapterError()` can surface more specific messages.

### Requirements

1. In `src/lib/adapters/oneinch.ts`, change the error handling for
   both `fetchQuote` (line ~16) and `fetchSwapData` (line ~48):

   ```typescript
   // Before:
   if (!res.ok) throw new Error(`1inch ${res.status}`)
   
   // After:
   if (!res.ok) {
     let detail = ''
     try {
       const errBody = await res.json()
       detail = errBody?.description || errBody?.error || ''
     } catch { /* non-JSON error body — ignore */ }
     throw new Error(`1inch ${res.status}${detail ? `: ${detail}` : ''}`)
   }
   ```

2. This applies to BOTH call sites in `oneinch.ts`:
   - `fetchQuote` (~line 16)
   - `fetchSwapData` (~line 48)

3. Do NOT change the `classifyAdapterError()` logic in shared.ts —
   the existing heuristics (403→"Access denied", 429→"Rate limited")
   still apply. The new detail string is appended to the raw error
   for logging context.

### Files affected

- `src/lib/adapters/oneinch.ts` — error handling in fetchQuote + fetchSwapData

### Expected output

One commit. Error messages now include 1inch's own description:
- `1inch 403: Forbidden` → classifies as "Access denied — API key may be invalid."
- `1inch 429: Rate limit exceeded` → classifies as "Rate limited."
- `1inch 400: insufficient liquidity` → classifies as "Insufficient liquidity."

### Quality criteria

- All existing tests pass
- TypeScript clean
- No change to happy-path behaviour
- Error classification still works (classifyAdapterError reads substrings)

---

## Ops task (manual — NOT a code change)

**Check `ONEINCH_API_KEY` on Vercel:**

1. Go to Vercel dashboard → Settings → Environment Variables
2. Verify `ONEINCH_API_KEY` is set for Production
3. If expired/missing: regenerate at https://portal.1inch.dev/
4. The key is a `Bearer` token used in the `Authorization` header

This is NOT a code change — just verify the env var is present and valid.

---

## Do NOT

- Do NOT merge to main yet — Sprint 25D PR is still open
- Do NOT change SWAP or QUOTE rate limits
- Do NOT modify classifyAdapterError heuristics
- Do NOT add try-catch to other adapters (they already use parseJsonOrThrow)

---

## Post-deploy checklist

1. Verify `/api/rpc` no longer returns 429 during normal usage (wallet + app)
2. Verify Uniswap V3 simulation works consistently (no more intermittent reverts)
3. Test 1inch with a supported pair (ETH → USDC) — should show improved error if key issue persists
4. Test 1inch with USDe — should show 1inch's specific error reason
