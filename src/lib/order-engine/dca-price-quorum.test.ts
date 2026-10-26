// @vitest-environment node
/**
 * [feat/swap-price-tiers] dca-price-quorum.ts is now a re-export shim over src/lib/price-quorum.ts (the
 * quorum serves DCA AND the swap tiers). Its behaviour is pinned in src/lib/price-quorum.test.ts; this file
 * only pins that the legacy import path still yields the SAME bindings, so dca-floor-tier.ts and the
 * tests that mock '@/lib/order-engine/dca-price-quorum' keep working unchanged.
 */
import { describe, it, expect } from 'vitest'
import * as legacy from './dca-price-quorum'
import * as shared from '../price-quorum'

describe('order-engine/dca-price-quorum re-exports the shared price quorum', () => {
  it('same functions (identity), same constants (value)', () => {
    expect(legacy.quorumPriceUsd).toBe(shared.quorumPriceUsd)
    expect(legacy.offchainQuorumPrice).toBe(shared.offchainQuorumPrice)
    expect(legacy.resetQuorumQuoteCache).toBe(shared.resetQuorumQuoteCache)
    expect(legacy.spreadBps).toBe(shared.spreadBps)
    expect({
      tol: legacy.QUORUM_TOLERANCE_BPS, age: legacy.MAX_PRICE_AGE_SEC, skew: legacy.FUTURE_SKEW_SEC,
      timeout: legacy.SOURCE_TIMEOUT_MS, ttl: legacy.QUOTE_CACHE_TTL_MS,
    }).toEqual({ tol: 300, age: 600, skew: 300, timeout: 5000, ttl: 30_000 })
  })
})
