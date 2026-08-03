# CHORE-DCA-UX-POLISH — DCA spend UX: balance, quick-fill %, always-visible expiry, no native ETH

## Context
Polish the DCA "New DCA" panel. Three independent UX asks from the owner, all on the DCA form. Standalone —
can run on its own branch. **Overlaps with `CHORE-DCA-WETH-INPUT`** on one point (native ETH must not appear as
the spend token): that prompt owns the *correctness* side (server rejects native-ETH `tokenIn`, contract is
ERC-20-input only); THIS prompt owns the *UI presentation*. If both run, sequence this AFTER (or fold the
native-ETH exclusion into whichever lands first) to avoid a double edit of the spend token list.

## Objective
Make the DCA spend step clearer and faster: show the user's balance of the spend asset, one-tap amount
presets, expiry always visible, and never offer native ETH as the spend token.

## Requirements
1. **No native ETH in the "Total to spend" selector.** The spend (input) token list must exclude the native
   ETH sentinel — show **WETH** instead. (Buy/output selector unchanged — ETH stays valid there; the contract
   unwraps WETH→ETH on delivery.) Keep it chain-aware (per-chain WETH; don't hardcode).
2. **Show the connected wallet's balance of the selected spend asset**, near the amount input (e.g. "Balance:
   X.XXXX WETH"). Read via the existing wagmi balance hook, chain-aware, formatted to the token's decimals;
   refresh on token/account/chain change; graceful "—" while loading or if disconnected.
3. **Quick-fill 25% / 50% / 100% buttons** that set the "Total to spend" amount from that balance:
   - amount = balance × pct, formatted to the token's decimals (no overflow / float drift — compute in the
     smallest unit with BigInt, then format).
   - 100% = full spend-token balance (the spend token is an ERC-20/WETH, so no native-gas reserve needed —
     gas is paid by the keeper, not this token). Disable the buttons when balance is 0 / disconnected.
   - Re-validate the existing per-chunk `MIN_ORDER_AMOUNT` floor after a preset fills (amount ÷ numberOfBuys ≥
     floor); surface the existing min-amount hint if a preset puts it under the floor.
4. **Order Expiry always visible.** Move the "Order Expiry" control OUT of "Advanced settings" so it shows by
   default, alongside Number of buys / Interval. (Slippage tolerance can stay under Advanced.)

## Verify
- Native ETH never appears in the spend selector (mainnet + Base); WETH does. Buy selector still offers ETH.
- Balance shows correctly for the selected spend token, updates on token/account/chain switch.
- 25/50/100% fill the exact amounts (BigInt math, correct decimals); 100% = full balance; disabled when 0.
- Order Expiry renders without expanding Advanced; existing default (24h) preserved.
- Existing DCA tests green; add tests for the percent math + the spend-list native-ETH exclusion.

## Do NOT
- Don't change the buy/output token behaviour (ETH allowed there).
- Don't duplicate `CHORE-DCA-WETH-INPUT`'s server-side native-ETH rejection — that's its scope; here it's the
  selector list + UX only.
- Don't hardcode WETH or balances per chain; resolve by chainId.
- Don't touch the contract or the keeper.

## Files affected (verify on `main`)
- The DCA panel component (`src/components/**` — DCAPanel / the New DCA form)
- the spend token selector + its token-list filter
- the wagmi balance hook usage; per-chain WETH config (`src/lib/chains/*` / `order-engine/config`)

## Expected output
- Branch `chore/dca-ux-polish` off latest `origin/main`; signed commits; CI green; FEEDBACK noting any overlap
  resolved with `CHORE-DCA-WETH-INPUT`. No Auditor (pure UI; no fund-flow/contract change).

## Quality criteria
Spend step shows balance + working 25/50/100% presets with correct BigInt math; expiry always visible; native
ETH absent from the spend list on every chain; no regressions to the buy side or the min-amount floor.
