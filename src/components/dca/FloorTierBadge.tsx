'use client'

import type { DcaFloorTier } from '@/lib/order-engine'

/**
 * [FEAT-DCA-FLOOR-TIERS] Which minimum-output protection a DCA was created under. Renders nothing
 * for an on-chain-feed (or pre-feature) order — the badge exists to mark the weaker tiers.
 */
export const FLOOR_TIER_BADGE: Record<Exclude<DcaFloorTier, 'onchain-feed'>, { label: string; title: string }> = {
  'offchain-price': {
    label: 'Off-chain check',
    title: 'No on-chain price feed: each buy is protected only by our off-chain price check.',
  },
  unpriced: {
    label: 'No price source',
    title: 'No price source: buys may execute at any price, capped per buy and flagged.',
  },
}

export default function FloorTierBadge({ tier }: { tier?: DcaFloorTier | null }) {
  if (!tier || tier === 'onchain-feed') return null
  const b = FLOOR_TIER_BADGE[tier]
  if (!b) return null
  return (
    <span
      data-testid="floor-tier-badge"
      data-tier={tier}
      title={b.title}
      className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-300"
    >
      {b.label}
    </span>
  )
}
