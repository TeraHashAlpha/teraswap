/**
 * [fix/limit-sltp-chain-aware-price-feed — Auditor H2 on merge 227a7f2, NARROWED] The ONE
 * resolver both order panels (Limit, SL/TP) use for `order.priceFeed`.
 *
 * WHAT H2 WAS: `getChainlinkFeeds(_chainId)` took a chainId and DISCARDED it, so every Base order
 * signed a MAINNET aggregator — an address with no code on Base, so `_checkPriceCondition` reverts
 * on the extcodesize guard (TeraSwapOrderExecutorV3.sol:1117, from :504) and every fill reverts.
 *
 * WHAT THIS BRANCH'S FIRST CUT (29d9519) DID WRONG: it re-pointed the panels at the ADDRESS-keyed
 * registry (`getChainlinkFeed`) for EVERY chain — including mainnet. That silently WIDENED the
 * mainnet signable set from 7 symbols to 26: the address-keyed map is the swap READ path's table,
 * gated there by ADR-018 (`getFeedExpectation` on every read), but nothing on the SIGNING path
 * consults that guard, so it put `constants.CHAINLINK_FEEDS` entries the read path refuses — one
 * with ZERO on-chain code — into signed orders. A wrong `priceFeed` is not a bad quote; it is an
 * order that can never fill.
 *
 * THE NARROWING (owner's decision — SPLIT): chain-awareness only.
 *   - Mainnet resolves EXACTLY as origin/main did — the SYMBOL-keyed `getChainlinkFeeds(1)` table
 *     plus the #490 wrapped-native fallback, verbatim. 0 gained / 0 lost / 0 changed, pinned by
 *     price-feed.test.ts over the real catalog. Widening that set is a separate PR under rule #9
 *     (each address verified on-chain), never a side effect of a refactor.
 *   - Every other chain resolves through the per-chain, ADDRESS-keyed registry
 *     `getChainlinkFeed(token, chainId)` (chains/chainlink-feeds.ts) — the part of 29d9519 that
 *     was right. A chain the registry does not cover gets '' (fail-closed), never a sibling's feed.
 *
 * NOT a denylist: no address is named here. The mainnet path simply never reads the address-keyed
 * map, so nothing it holds — dead or alive — is reachable from a signature.
 *
 * Returns '' when there is no feed — callers refuse BEFORE approve/sign. '' never degrades to
 * address(0): the contract reads address(0) as "no price condition, execute unconditionally"
 * (V3:1105-1108), so a zero feed on a Limit/TP order would strip its trigger.
 */
import type { Token } from '../tokens'
import { getChainlinkFeeds } from './config'
import { getChainlinkFeed } from '../chains/chainlink-feeds'
import { getWrappedNative, getChainConfig } from '../chains/registry'

/** The only chain the SYMBOL-keyed `getChainlinkFeeds` table describes (config.ts). */
const MAINNET_CHAIN_ID = 1

export function resolveOrderPriceFeed(token: Pick<Token, 'address' | 'symbol'>, chainId: number): string {
  if (chainId !== MAINNET_CHAIN_ID) {
    // [H2 fix, kept] Per-chain, address-keyed, fail-closed on an uncovered chain or token.
    return getChainlinkFeed(token.address, chainId) ?? ''
  }

  // ── Mainnet: the origin/main `findPriceFeed` body, verbatim ──────────────────────────────
  const feeds = getChainlinkFeeds(chainId)
  const direct = feeds[`${token.symbol}/USD`]?.address
  if (direct) return direct
  // [fix/native-out-signs-weth-limit-sltp] The BUY leg arrives ALREADY resolved to the chain's
  // wrapped native, and the Limit panel makes the buy leg the feed token whenever the sell leg is
  // a stablecoin — every "buy ETH when it drops" order. Chainlink publishes `ETH/USD` and never
  // `WETH/USD`; they are the same number off the same aggregator (config.ts:355). Without this
  // second look-up the flagship native-out order would refuse with "No Chainlink price feed
  // available for WETH". Fail-soft, mirroring getWrappedNative's own shape (registry.ts:197-203):
  // getChainConfig THROWS on an unknown chain, and a throw inside handleSubmit lands after
  // startWaitingSound() and would strand the panel in its waiting state.
  if (token.address.toLowerCase() === getWrappedNative(chainId).toLowerCase()) {
    try {
      return feeds[`${getChainConfig(chainId).nativeCurrency.symbol}/USD`]?.address ?? ''
    } catch { return '' }
  }
  return ''
}
