# CHORE-DCA-ROUTER-CHAINAWARE — chain-aware committed router (fix SwapFailed root cause) + net-amount route

## Context (root cause confirmed by PR #225 diagnosis, evidence-backed)
Base DCA `executeOrder` reverts `SwapFailed` because the order commits `order.router = 1inch v6`
(`getDefaultRouter`/`getWhitelistedRouters` ignore chainId → mainnet-only). But **1inch is unserveable on Base**
(`/api/swap` can't produce 1inch calldata there), so the keeper sends the best source's calldata
(Velora/Augustus V6) to the **1inch router** → it rejects foreign calldata → revert. Secondary: the keeper
builds the route for the full chunk `amount_in`, but the contract takes the **0.1% fee in tokenIn first** and
swaps only the per-chunk **net** amount → input mismatch.

On-chain verified (Base OrderExecutor 0x135B): Augustus V6 `0x6A000F20005980200259B80c5102003040001068`
AND Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` are **whitelisted + serveable**; 1inch is
whitelisted but unserveable.

## ARCHITECT SIGN-OFF
Approved to make the order's committed router chain-aware. On **Base, commit `order.router` = Augustus V6**
(`0x6A000F20005980200259B80c5102003040001068`) — an aggregator (best-execution preserved, analogous to 1inch on
mainnet) that is whitelisted + serveable on Base. This changes the signed order's router on Base — accepted.
Mainnet stays 1inch (unchanged).

## Requirements
1. **Chain-aware router config:** fix `getDefaultRouter(chainId)` / `getWhitelistedRouters(chainId)` (the
   mainnet-only bug) → Base returns **Augustus V6**; mainnet returns 1inch (byte-identical). Order-creation
   commits the chain-appropriate router into the signed order.
2. **Keeper fetches the route for the COMMITTED router** (constrained to `order.router`), not an unconstrained
   "best source" — so the calldata always matches `order.router`. On Base that means a Velora/Augustus route.
3. **Net-amount route:** the keeper must build the route for the per-chunk **net** amount (after the contract's
   0.1% tokenIn fee), matching exactly what `executeOrder` approves + swaps. Derive the fee the same way the
   contract does.
4. **Verify end-to-end on Base:** a fresh DCA commits Augustus V6; the keeper fetches an Augustus route for the
   net per-chunk amount; `executeOrder` succeeds on-chain — capture the tx, the output received, and the fee
   taken in FEEDBACK.
5. Mainnet byte-identical (router + amount path unchanged for CHAIN_ID=1).

## Do NOT
- Don't change the Solidity contract (it correctly validates the whitelisted router + routerData). Don't
  hardcode (resolve router by chainId). Don't alter instant-swap.

## Files affected (verify on main)
- order-engine router config (`getDefaultRouter`/`getWhitelistedRouters`) + the order-creation that commits
  `order.router`.
- keeper `contracts/order-engine/executor/executor.js` (fetch route for committed router + net per-chunk
  amount).
- read-only: `/api/swap` + `/api/quote` (confirm they can route through a specified router); the contract's
  fee + swap math in `executeOrder`.

## Expected output
- Branch `chore/dca-router-chainaware` off latest `origin/main`; SSH-signed; CI green; tests (Base order commits
  Augustus; mainnet still 1inch; net-amount route). FEEDBACK with the on-chain success tx.
- **Auditor: YES** — touches signed-order semantics + fund-flow routing.
- **Deploy:** frontend via Vercel (order-creation router) + keeper via `git pull` + `pm2 restart` on EC2.

## Ops (owner, after deploy)
Cancel the stuck 1inch-committed Base test orders (8aac436c, 2a7fc873) — immutable + unserveable; re-issue
fresh after the fix (they'll commit Augustus).

## Quality criteria
A Base DCA commits a serveable aggregator router (Augustus V6), the keeper routes through it for the net
per-chunk amount, and `executeOrder` completes on-chain; mainnet unchanged; contract untouched; "best price"
preserved (Augustus aggregates).
