# CHORE-DCA-SWAPFAILED — executeOrder reverts SwapFailed (on-chain router call fails)

## Context
With the route now fetched (200, #224 fixed the /api/swap payload), the keeper calls `executeOrder` on-chain and
it **reverts with `SwapFailed(bytes reason)`** (selector `0xff9fa595`, confirmed by computing the contract's
error selectors). So everything upstream works (WETH input, approval, route fetch); the **router swap inside
`executeOrder` reverts**. The contract wraps the inner router-call revert in `SwapFailed(reason)`.

Most likely the swap calldata (routerData) is built for the **wrong taker/recipient**. For 1inch (router
`0x111111125421cA6dc452d289314280a0f8842A65`) the calldata must be built with the **OrderExecutor contract
`0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` as the taker/receiver**, because the contract is `msg.sender`,
holds the pulled WETH, and must receive the output to take its fee + forward to the user. If `/api/swap` built
the calldata with `from`/taker = the keeper wallet (`0x71f5…`) or the order owner, the on-chain call reverts.

## Objective
Make `executeOrder` complete the on-chain swap for a Base DCA chunk (no `SwapFailed`), executing chunk 1.

## Requirements
1. **Decode the inner reason:** ABI-decode the `bytes reason` inside the captured `SwapFailed` revert data (the
   keeper logged the full error blob) — put the decoded inner router revert in FEEDBACK. That pinpoints it.
2. **Check the taker/`from`:** in `executor.js` `fetchSwapRoute`/its call site, what `from` is passed to
   `/api/swap`? It MUST be the **OrderExecutor contract address** (per chain) so the route calldata's
   taker/receiver is the contract. Fix it if it's the keeper wallet / owner. Verify how `/api/swap` (and the
   1inch adapter) place the taker/receiver in the calldata.
3. **Verify the contract side (read-only unless clearly needed):** confirm `executeOrder` approves the router
   for `tokenIn` before the swap and expects the output back to itself. If the revert is genuinely a CONTRACT
   bug (e.g., missing approve-to-router), **STOP and flag it for owner sign-off** — do NOT change the Solidity
   without approval (contract change = redeploy + audit).
4. **Verify end-to-end:** simulate/execute a Base WETH→token chunk → `executeOrder` succeeds, output lands,
   fee taken. Capture the success tx in FEEDBACK.

## Do NOT
- Don't change the Solidity contract without explicit owner sign-off (flag it instead). Don't hardcode chain
  values. Don't alter instant-swap.

## Files affected (verify on main)
- `contracts/order-engine/executor/executor.js` (the `from`/taker passed to `/api/swap`; the executeOrder call).
- Read-only: `src/app/api/swap/route.ts` + the 1inch adapter (where taker/receiver is set);
  `TeraSwapOrderExecutor.sol` `executeOrder` swap section (approve-to-router + output handling).

## Expected output
- Branch `chore/dca-swapfailed` off latest `origin/main`; SSH-signed; CI green; FEEDBACK with the decoded inner
  reason + the root cause + (if keeper-only) the fix, OR a clear contract-change proposal for owner sign-off if
  it's on-chain.
- **Deploy (owner):** keeper from `~/teraswap` on EC2 → `git pull` + `pm2 restart` (if keeper-only fix).

## Quality criteria
A Base DCA chunk's `executeOrder` completes on-chain (no SwapFailed); root cause documented with the decoded
reason; contract untouched unless owner-approved.
