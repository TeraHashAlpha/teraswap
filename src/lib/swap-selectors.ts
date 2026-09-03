/**
 * [SC-04] Shared swap function selector whitelist.
 *
 * Single source of truth for known DEX router selectors.
 * Used by:
 *   - src/hooks/useSwap.ts (client-side validation before wallet prompt)
 *   - src/hooks/useSplitSwap.ts (client-side validation for split legs)
 *   - src/app/api/swap/route.ts (server-side defense-in-depth)
 *
 * Zero dependencies. No imports.
 */

// ── Known swap function selectors (23 total) ────────────────

export const KNOWN_SWAP_SELECTORS: Set<string> = new Set([
  // 1inch
  '0x12aa3caf', '0xe449022e', '0x0502b1c5', '0x2e95b6c8',
  // 0x — Exchange Proxy v1 (0xDef1C0ded9bec7F1a1670819833240f027b25EfF):
  //   0xd9627aa4 sellToUniswap(address[],uint256,uint256,bool)
  //   0x415565b0 transformERC20(address,address,uint256,uint256,(uint32,bytes)[])
  // [2026-09-03 / ADR-021] NO flow in this repo emits these any more: the SWAP path
  // moved to 0x API v2 on every chain (mainnet was the last one still on a v1-era
  // whitelist). Kept, not removed (rule #4), because the v1 Exchange Proxy remains
  // whitelisted ON-CHAIN by the deployed mainnet OrderExecutor — see the '0x' entry
  // in order-engine/config.ts MAINNET_ROUTERS, which this repo cannot change — so an
  // order-path route through it would emit them again. calldata-recipient.ts also
  // still classifies both in MSG_SENDER_SELECTORS.
  '0xd9627aa4', '0x415565b0',
  // [ADR-021] 0x API v2 — AllowanceHolder.exec, the ONLY selector the v2
  // allowance-holder flow puts in `transaction.data`. The Settler's
  // execute((address,address,uint256),bytes[],bytes32) (0x1fff991f) is INNER
  // calldata carried in this call's `data` argument, never the outer tx selector,
  // so it is deliberately NOT whitelisted here (see ADR-021 §Consequences).
  //   exec(address operator, address token, uint256 amount, address payable target, bytes data)
  //   → canonical ABI signature: exec(address,address,uint256,address,bytes)
  //   → viem toFunctionSelector(...) === 0x2213bc0b
  // Never typed as "known": swap-selectors.test.ts recomputes the keccak from the
  // signature string and asserts it equals this entry.
  // ABI source: 0xProject/0x-settler, src/allowanceholder/AllowanceHolderBase.sol
  //   https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderBase.sol
  // On-chain cross-check (mainnet eth_getCode, 2026-09-03): 0x2213bc0b appears in
  // the AllowanceHolder's 1009-byte runtime dispatch table; 0x1fff991f does not.
  '0x2213bc0b',
  // Paraswap (Augustus V5 — legacy)
  '0x3598d8ab', '0xa94e78ef', '0x46c67b6d',
  // Paraswap / Velora (Augustus V6.2 — multi-hop swapExactAmountIn)
  '0xe3ead59e',
  // [SPRINT-9H] Paraswap / Velora (Augustus V6.2 — single-DEX Curve methods).
  // Base (and mainnet) Velora routes through a Curve pool encode a DEX-specific
  // method, NOT the generic swapExactAmountIn — so these were blocked as
  // "Unknown swap function selector" on the Base Preview. Verified 3 ways
  // against the live Augustus V6.2 (0x6a00…1068, same address on Ethereum +
  // Base): codeslaw ABI, openchain.xyz, and local viem toFunctionSelector over
  // the canonical signature (which reproduced the known 0xe3ead59e exactly).
  '0x1a01c532', // swapExactAmountInOnCurveV1  (CurveV1StableNg — the Base failure)
  '0xe37ed256', // swapExactAmountInOnCurveV2  (Curve crypto pools)
  // Odos
  '0x83800a8e',
  // KyberSwap
  '0xe21fd0e9',
  // Uniswap V3
  '0xac9650d8', '0x5ae401dc', '0x04e45aaf', '0xb858183f',
  // Uniswap V2 / Sushi
  '0x472b43f3', '0x38ed1739', '0x7ff36ab5', '0x18cbafe5',
])

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract the 4-byte function selector from hex calldata.
 * Returns lowercase "0x????????" or "" if calldata is too short.
 */
export function getSelector(calldata: string): string {
  if (!calldata || calldata.length < 10) return ''
  return calldata.slice(0, 10).toLowerCase()
}

/**
 * Check whether the calldata starts with a known swap selector.
 * Returns false for empty/short calldata.
 */
export function isKnownSwapSelector(calldata: string): boolean {
  const sel = getSelector(calldata)
  if (sel === '') return false
  return KNOWN_SWAP_SELECTORS.has(sel)
}
