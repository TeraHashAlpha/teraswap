# CHORE-SWAP-FEE-USD-FIX — platform-fee USD is wrong for tokens without a Chainlink oracle

## Context
On the instant-swap UI, the **Platform fee (0.1%) USD value is wildly wrong for tokens without a Chainlink
oracle**. Example: AERO→WETH, swapping 3.7164 AERO (≈ 0.0011 WETH ≈ **~$1.87** total). The fee AMOUNT is
correct — `0.003716 AERO` (= 0.1%) — but it's shown as **$5.79**, i.e. AERO is being valued at ~$1558/token
(≈ ETH's price) instead of its real ~$0.50. So a ~$1.87 swap displays a "$5.79 fee" (looks like a 300% fee) →
destroys trust. AERO has **no Chainlink oracle** (the UI even warns this), and the fee-USD path falls back to a
wrong price.

## Objective
Show a correct platform-fee USD value for ALL tokens, including those without a Chainlink oracle. The fee
amount (0.1% in tokenIn) is correct and must not change — only the USD display.

## Requirements
1. **Derive the fee USD from the swap's real USD value**, not by valuing the fee token with a wrong/fallback
   price. The fee is 0.1% of the input; the swap's USD value can be taken from the reliably-priced side (e.g.
   the OUTPUT token if it has an oracle — WETH here — or the multi-source price comparison the swap already
   computes). Fee USD ≈ `0.1% × swapUsdValue`.
2. **Works without a Chainlink oracle:** reuse the same multi-source / output-side valuation the swap already
   uses for the displayed amounts — never a default/ETH-priced fallback for the fee token.
3. **No change to the actual fee** (0.1% in tokenIn) or the contract — display/valuation only.

## Verify
- AERO→WETH (no AERO oracle): fee shows ≈ 0.1% of the real swap USD (cents, ~$0.002), NOT $5.79.
- A curated/oracle token swap (e.g. USDC→WETH): fee USD unchanged / still correct.
- The fee TOKEN amount is identical before/after (only the $ value is corrected).

## Do NOT
- Don't change the fee rate or the contract. Don't regress fee display for oracle-priced tokens. Don't
  fabricate a price — use the swap's existing valuation.

## Files affected (verify on main)
- The swap UI fee display + the fee-USD valuation logic (client and/or the quote response), and how it sources
  a token price when no Chainlink oracle exists.

## Expected output
- Branch `chore/swap-fee-usd-fix` off latest `origin/main`; SSH-signed; CI green; tests (no-oracle token fee
  USD = 0.1% of swap USD; oracle token unchanged); FEEDBACK. No Auditor (display-only).

## Quality criteria
Platform-fee USD is correct for any token (oracle or not), derived from the swap's real value; the fee amount
in tokenIn is unchanged; no misleading inflated fee.
