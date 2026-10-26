/**
 * [feat/swap-price-tiers] SUPERSEDED IN PLACE — the ADR-024 price quorum moved to src/lib/price-quorum.ts so
 * the DCA floor tier (dca-floor-tier.ts) and the swap price tiers (/api/swap-price-tier) share ONE
 * implementation. This path is kept (rule #4: never delete) as a re-export, so dca-floor-tier.ts and the
 * tests that `vi.mock('@/lib/order-engine/dca-price-quorum')` keep working unchanged (pinned by
 * dca-price-quorum.test.ts). New code imports '@/lib/price-quorum'.
 */
export {
  QUORUM_TOLERANCE_BPS,
  MAX_PRICE_AGE_SEC,
  FUTURE_SKEW_SEC,
  SOURCE_TIMEOUT_MS,
  QUOTE_CACHE_TTL_MS,
  spreadBps,
  offchainQuorumPrice,
  quorumPriceUsd,
  resetQuorumQuoteCache,
} from '@/lib/price-quorum'
export type { OffchainQuote } from '@/lib/price-quorum'
