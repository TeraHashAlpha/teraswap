# CHORE-LIMIT-COW-WETH-CHAINAWARE — chain-aware WETH for the limit-order CoW path

## Context
From #214's review (FEEDBACK): `limit-order-api.ts` `resolveToken()` **hardcodes mainnet WETH** for the CoW
path. A native-ETH / ETH-involving limit order on a non-mainnet chain (e.g. Base) resolves to **mainnet WETH**
→ CoW returns **no quote** — the same chain-awareness defect class as SPRINT-9E/9W. Currently latent (Base
limit orders are gated off today; only DCA is exposed on Base), but fix it so multi-chain conditional orders
route correctly.

## Objective
Resolve the wrapped-native (WETH) address **per chain** in the limit-order/CoW routing path — no hardcoded
mainnet WETH.

## Requirements
1. In `limit-order-api.ts` `resolveToken()` (and any sibling that resolves WETH/native for routing), resolve
   the wrapped-native by `chainId` via the existing helper (`getWrappedNative(chainId)` / `findChainToken`) —
   mainnet `0xC02aaA…6Cc2`, Base `0x4200…0006`. No hardcoded WETH.
2. Apply to the **CoW path** specifically (the no-quote case) + any other adapter that resolves native→WETH for
   limit/conditional routing.
3. Mainnet behaviour byte-identical.

## Do NOT
- Don't change the contract or keeper. No hardcoded chain addresses. Don't regress mainnet limit routing or
  instant swaps.

## Files affected (verify on main)
- `src/lib/limit-order-api.ts` (`resolveToken`) + any adapter with a hardcoded WETH for CoW.
- Per-chain wrapped-native config (`order-engine/config`, `src/lib/chains/*`).

## Expected output
- Branch `chore/limit-cow-weth-chainaware` off latest `origin/main`; SSH-signed; CI green; a test that a Base
  limit order resolves to Base WETH (not mainnet) on the CoW path; mainnet unchanged; FEEDBACK. Light Auditor
  optional (routing/quote path).

## Quality criteria
No hardcoded WETH in the limit/CoW routing path; wrapped-native resolved per chain; mainnet byte-identical;
a Base conditional order no longer hits CoW no-quote because of a mainnet-WETH mismatch.
