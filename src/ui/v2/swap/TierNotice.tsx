import { singleSourceLabel, type SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { Notice } from './QuotePanel'

/**
 * The SERVER's price tier, as a notice (feat/swap-price-tiers D1 — GET /api/swap-price-tier, the ADR-024 quorum per leg).
 *   priced → nothing · unknown (null, not asked / in flight / failed) → nothing: the client never guesses, /api/swap decides.
 *   single-source → the amber notice, VERBATIM from v1's QuoteBreakdown (#608, owner copy 2026-10-26).
 *   unpriced → one line, VERBATIM (owner, B3 goal); the informed-consent dialog that v1 opens is B4.
 */
export const SINGLE_SOURCE_TAIL = 'Value-based limits use that price; double-check the rate before swapping.'
export const UNPRICED_LINE = 'No reference price — consent required before swapping'

export function TierNotice({ tier }: { tier: SwapPriceTierResponse | null | undefined }) {
  if (tier?.tier === 'single-source') {
    return (
      <Notice tone="amber" testId="price-tier-single-source">
        <span className="font-semibold">&#9888; Price from one source only ({singleSourceLabel(tier)}).</span> {SINGLE_SOURCE_TAIL}
      </Notice>
    )
  }
  if (tier?.tier === 'unpriced') {
    return (
      <Notice tone="amber" testId="price-tier-unpriced">
        {UNPRICED_LINE}
      </Notice>
    )
  }
  return null
}
