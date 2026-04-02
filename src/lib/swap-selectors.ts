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

// ── Known swap function selectors (18 total) ────────────────

export const KNOWN_SWAP_SELECTORS: Set<string> = new Set([
  // 1inch
  '0x12aa3caf', '0xe449022e', '0x0502b1c5', '0x2e95b6c8',
  // 0x
  '0xd9627aa4', '0x415565b0',
  // Paraswap
  '0x3598d8ab', '0xa94e78ef', '0x46c67b6d',
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
