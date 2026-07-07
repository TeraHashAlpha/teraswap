# CHORE-DCA-WETH-INPUT — DCA input must be an ERC-20 (WETH), never native ETH

## Context (confirmed on-chain + in contract source)
The first real Base DCA order failed: the keeper found it, called `canExecute` on the Base OrderExecutor
(`0x135B339902Ea4E0fB4CF059961dc8856bA1D2598`), and it **reverted**. Root cause: the order's **`tokenIn` was
native ETH** (sentinel `0xEeeeeEeee…EEeE`). The OrderExecutor pulls the input via ERC-20 `transferFrom` and
only handles ETH on the **output** side:
- `TeraSwapOrderExecutor.sol:990` — *"Accept ETH only during active order execution (router ETH output / WETH unwrap)"*
- ETH handling lives entirely on `tokenOut` (`:531-538`, wrap router-returned ETH → WETH for delivery).
- `_checkPriceCondition` correctly returns early for `priceFeed == address(0)` (`:914`) → **price feed is NOT
  the cause**; a DCA with no feed is fine.

So `canExecute` calls `allowance()/balanceOf()` on `tokenIn = 0xEeee…` (no contract there) → "returned no
data" → revert. **The contract is correct and must NOT change.** The bug is the DCA UI offering native ETH as
the *spend* (input) token.

## Objective
DCA (and any keeper-executed conditional order) input token must be an **ERC-20**. Stop offering native ETH as
the DCA *spend* token; ETH stays valid as the *buy*/output token (contract unwraps on delivery).

## Requirements
1. **DCA input selector (DCAPanel / order-engine UI):** for the "Total to spend" token, do NOT list native
   ETH. Show **WETH** instead. Owner decision (pick one, default = (b) to preserve the "wallet only signs once"
   promise):
   - **(a)** When the user picks ETH, transparently route to WETH and add an explicit one-time **wrap
     ETH→WETH** step (clear UX: "wrap once, then your DCA runs gasless"). More taps, keeps ETH selectable.
   - **(b)** Restrict the DCA input list to ERC-20s (WETH shown, native ETH hidden); user wraps beforehand.
     Simpler, preserves single-sign. **Recommended.**
   Keep the *output*/buy selector unchanged (ETH allowed — contract unwraps WETH→ETH on delivery).
2. **Server fail-closed:** `/api/orders` must reject `tokenIn === native-ETH sentinel` for `orderType` in
   {limit, stop_loss, dca} with a clear `400` (e.g. "Use WETH (not native ETH) as the order input"). Defence in
   depth — the contract reverts anyway, but a non-executable order should never be created/stored.
3. **Apply on both chains** (mainnet + Base) and keep it chain-aware — use the per-chain WETH address (don't
   hardcode mainnet WETH on Base). The contract already stores `WETH` immutable per deployment; the UI/config
   must resolve WETH by chainId.
4. **Messaging:** if a user lands with only native ETH, guide them ("wrap to WETH to start a DCA") rather than
   a silent failure.

## Verify
- A **WETH→USDC** DCA on Base: order creates, the keeper executes chunk 1 on-chain (no canExecute revert).
- Selecting ETH as DCA input is either auto-wrapped (a) or not offered (b) — never produces a native-ETH order.
- POST `/api/orders` with `tokenIn` = native-ETH sentinel + `orderType=dca` → `400` (test it).
- Output side still allows buying ETH (regression check).
- Existing tests green; add a unit/integration test for the native-ETH-input rejection.

## Do NOT
- Do NOT modify the Solidity contract (it is correct; ETH is output-only by design).
- Don't change swap (instant) behaviour — native ETH stays valid for instant swaps; this is DCA/orders only.
- Don't hardcode WETH; resolve per chain.

## Files affected (verify on `main`)
- DCA panel / token selectors for orders (`src/components/**`, the DCA panel)
- `src/hooks/useOrderEngine.ts` (input token handling) and the order build
- `src/app/api/orders/route.ts` (server-side native-ETH rejection)
- WETH-by-chain config (`src/lib/chains/*` / `order-engine/config`)

## Expected output
- Branch `chore/dca-weth-input` off latest `origin/main`; signed commits; CI green; FEEDBACK with the owner
  decision (a vs b) used and any adjacent native-ETH assumptions found.

## SEPARATE pre-re-test check (NOT this prompt — ops)
Before unfreezing/re-testing, verify the router the keeper selected (1inch V6
`0x111111125421cA6dc452d289314280a0f8842A65`) is **whitelisted** on the Base OrderExecutor — if the bootstrap
didn't include it, a WETH DCA will hit a *different* revert (router not allowed). Whitelist via the admin
router-management path if missing.
