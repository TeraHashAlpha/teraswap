# CHORE-KEEPER-SWAP-PAYLOAD-FIX — keeper /api/swap POST returns 400 despite chainId (#223)

## Context
#223 added `chainId` to the keeper's `fetchSwapRoute` and sends it in the `/api/swap` POST body via
`buildSwapRoutePayload`. But on Base the keeper STILL gets **`Swap API error: 400`** → "no swap route" →
every DCA chunk skipped (`0 executed, 1 skipped`). The keeper only logs the status, not the body. So the
payload `buildSwapRoutePayload` produces does NOT match what `/api/swap` actually requires (param name,
missing required field, or chainId placement) — even though the comment claims it followed the `useSwap`
contract.

## Objective
Make the keeper's `/api/swap` POST return a valid route (200) for a Base WETH→token DCA chunk, by matching the
body to what `/api/swap` actually expects.

## Requirements
1. **Capture the 400 body:** reproduce the keeper's exact POST to `/api/swap` with a representative Base
   payload (WETH `0x4200…0006` → a liquid Base token, small amount, chainId 8453, the keeper's `from`/router)
   and log the response body. Put the exact 400 message in FEEDBACK.
2. **Compare both sides:** `buildSwapRoutePayload` (keeper, in `contracts/order-engine/executor/`) vs the
   `/api/swap` route's request parsing/validation (`src/app/api/swap/route.ts`) AND the frontend instant-swap
   call (`useSwap`) that works on Base. Identify the mismatch (field names, required fields, types, where
   chainId goes).
3. **Fix the keeper payload** (`buildSwapRoutePayload` / `fetchSwapRoute`) so the body matches `/api/swap`'s
   contract exactly. Verify by reproducing → 200 with `tx.data` present.
4. Mainnet path unchanged (CHAIN_ID=1 → equivalent to legacy).

## Do NOT
- Don't change `/api/swap` or the contract — fix the keeper's request to match the existing API. (If the API
  genuinely lacks a needed field, flag it in FEEDBACK rather than silently changing the API.)
- No hardcoded chain values.

## Files affected (verify on main)
- `contracts/order-engine/executor/` — `buildSwapRoutePayload` (find its module) + `fetchSwapRoute` call.
- Read-only compare: `src/app/api/swap/route.ts` + the frontend `useSwap` swap call.

## Expected output
- Branch `chore/keeper-swap-payload-fix` off latest `origin/main`; SSH-signed; CI green (keeper-tests); a test
  asserting the payload matches the `/api/swap` schema; FEEDBACK with the captured 400 body + the exact
  mismatch found.
- **Deploy (owner):** keeper runs from `~/teraswap` on the EC2 → after merge, `git pull` + `pm2 restart
  teraswap-executor --update-env`.

## Quality criteria
The keeper's `/api/swap` POST returns 200 with a route for a Base WETH→token chunk; the chunk executes; mainnet
unchanged; the fix matches the existing API contract (API not modified).
