# CHORE-KEEPER-SWAP-CHAINID — thread chainId into the keeper's swap-route fetch (fix Swap API 400 on Base)

## Context
The self-hosted keeper's `fetchSwapRoute(tokenIn, tokenOut, amount, from, router)` in
`contracts/order-engine/executor/executor.js` (~line 463) calls `${API_URL}/api/swap` **without a chainId**.
So `/api/swap` defaults to **mainnet (chainId=1)** and tries to route Base tokens (e.g. AERO, Base WETH
`0x4200…0006`) on mainnet → no route → **`Swap API error: 400`** → the keeper skips every Base DCA chunk
(`0 executed, 1 skipped`). Instant swaps on Base work because the frontend passes the chain to `/api/swap`;
the keeper must do the same. Same chain-awareness defect class as the order-API domain + the limit/CoW WETH
fixes.

## Objective
Make the keeper request the swap route for the **correct chain**, so Base DCA chunks get a valid route and
execute.

## Requirements
1. Add a **`chainId`** parameter to `fetchSwapRoute` and pass the keeper's `CHAIN_ID`
   (`process.env.CHAIN_ID`; the keeper is configured per-chain — 8453 on Base) at the call site
   (executor.js ~line 888).
2. Include `chainId` in the `/api/swap` request **exactly as the internal `/api/swap` route expects it** —
   VERIFY the route's param contract (`src/app/api/swap/route.ts`) and how the frontend instant-swap calls it
   (body field vs query param) and match it. Do NOT guess the param name/shape.
3. Mainnet behaviour unchanged: when `CHAIN_ID=1` the request must be equivalent to today.
4. Verify: on Base (`CHAIN_ID=8453`) the keeper now gets a valid route for a WETH→<Base token> chunk (no 400)
   and proceeds to `canExecute` + execute.

## Do NOT
- Don't change the Solidity contract. Don't hardcode chainId. Don't alter instant-swap behaviour.

## Files affected (verify on main)
- `contracts/order-engine/executor/executor.js` (`fetchSwapRoute` signature + call site ~888).
- Verify `src/app/api/swap/route.ts` param contract + the frontend swap call for parity.

## Expected output
- Branch `chore/keeper-swap-chainid` off latest `origin/main`; SSH-signed; CI green (keeper-tests);
  a test asserting `fetchSwapRoute` passes `chainId` to `/api/swap`; FEEDBACK.
- **Deploy note (owner):** the keeper runs from `~/teraswap` on the EC2 → after merge, `git pull` on the EC2 +
  `pm2 restart teraswap-executor --update-env`.

## Quality criteria
The keeper requests the route for its configured chain; a Base WETH→token DCA chunk gets a route (no 400) and
executes; mainnet byte-identical; no hardcoded chainId.

## Note (pattern)
4th instance of the chainId-not-threaded defect (order-API domain, limit/CoW WETH, this). Worth a follow-up
sweep: audit every keeper/server→service call for an implicit mainnet default.
