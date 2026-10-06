/**
 * [fix/catalog-seeds-include-unverified-rows] seedsFor() — the admission filter that decides
 * which committed catalog rows become continuity seeds for the NEXT tokens:sync run.
 *
 * Previously this filtered out any row already `verified:false` ("post-baseline additions
 * persist only while verified"), so a row the PREVIOUS run had demoted to unverified could
 * never become a seed again — silently excluded here, before build-chain.ts's
 * CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS policy (which decides drop/keep/promote correctly, see
 * build-chain.test.ts) ever got a chance to see it. This is the regression test that would have
 * caught it: seedsFor() must hand EVERY committed row to build-chain.ts, verified or not.
 *
 * Uses a synthetic chain id with no real DEFAULT_TOKENS / seed-baseline.json / CURATED_*_SEEDS
 * entries, so the only seeds observed come from the mocked GENERATED_TOKEN_CATALOG — isolating
 * the one code path under test.
 */
import { describe, it, expect, vi } from 'vitest'

const TEST_CHAIN = 999999
const VERIFIED_ADDR = '0x1111111111111111111111111111111111111111'
const UNVERIFIED_ADDR = '0x2222222222222222222222222222222222222222'

vi.mock('@/lib/chains/token-catalog.generated', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains/token-catalog.generated')>()
  return {
    ...actual,
    GENERATED_TOKEN_CATALOG: {
      ...actual.GENERATED_TOKEN_CATALOG,
      [TEST_CHAIN]: [
        {
          address: VERIFIED_ADDR, symbol: 'VER', name: 'Verified', decimals: 18,
          logoURI: '', category: 'Other', verified: true, sources: ['uniswap', 'coingecko'],
          volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
        },
        {
          address: UNVERIFIED_ADDR, symbol: 'UNV', name: 'Unverified', decimals: 18,
          logoURI: '', category: 'Other', verified: false, sources: ['curated'],
          volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
        },
      ],
    },
  }
})

describe('seedsFor', () => {
  it('admits every row in the generated catalog as a seed, verified or not', async () => {
    const { seedsFor } = await import('./build')
    const seeds = seedsFor(TEST_CHAIN)
    expect(seeds.size).toBe(2)
    expect(seeds.has(VERIFIED_ADDR.toLowerCase())).toBe(true)
    expect(seeds.has(UNVERIFIED_ADDR.toLowerCase())).toBe(true)
    // seedsFor()'s output is a SeedToken — it does not itself carry `verified`; that flag is
    // read back out of `previousCatalog` (built separately in build.ts) by build-chain.ts.
    expect(seeds.get(UNVERIFIED_ADDR.toLowerCase())).toMatchObject({ symbol: 'UNV' })
  })

  it('an unknown chain id yields no seeds from the generated catalog (no crash on a missing key)', async () => {
    const { seedsFor } = await import('./build')
    const seeds = seedsFor(123456789)
    expect(seeds.size).toBe(0)
  })
})
