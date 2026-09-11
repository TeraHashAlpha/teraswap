/**
 * [CHORE-FEED-MAP-NAMING-HYGIENE] PINS that DCAPanel calls no SIGNING-path price-feed resolver.
 *
 * WHY: `_findPriceFeed` (removed by this change) was a third, uncalled copy of the symbol-table
 * lookup — it duplicated `getChainlinkFeeds` outside `resolveOrderPriceFeed`, the one resolver both
 * order panels use to fill `order.priceFeed`. DCA signs `priceFeed = address(0)` and always has;
 * reviving a lookup like `_findPriceFeed` (or hand-rolling a new one) would silently widen the
 * signable feed set again with a green suite, exactly how H2 happened (audit of PR #491).
 *
 * This is a static source check, not a render test: the concern is DCAPanel's IMPORT surface, not
 * its runtime behavior. A future DCA price feature must go through `resolveOrderPriceFeed`
 * (order-engine/price-feed.ts) on purpose — which means this test breaking, not staying green, and
 * the developer updating it deliberately instead of it drifting unnoticed.
 *
 * Deliberately NOT banned: `resolveFeed` (`lib/chains/chainlink-feeds.ts`), already used here for
 * the unrelated oracle fail-closed gate (`outputHasNoResolvableFeed`) — a read-path check, not a
 * signing-path one, and out of scope for this pin.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'DCAPanel.tsx'),
  'utf-8',
)

describe('DCAPanel — no signing-path price-feed resolver', () => {
  it.each([
    '_findPriceFeed',
    'getChainlinkFeeds',
    'resolveOrderPriceFeed',
    'MAINNET_FEEDS_BY_SYMBOL',
    'CHAINLINK_FEEDS',
  ])('does not reference %s', (identifier) => {
    expect(source.includes(identifier)).toBe(false)
  })
})
