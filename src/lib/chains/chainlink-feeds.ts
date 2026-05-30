/**
 * [P218 / ADR-009] Per-chain Chainlink feed registry.
 *
 * Mainnet (chainId 1) REFERENCES the existing CHAINLINK_FEEDS map in
 * constants.ts (token-address → feed-proxy), so the mainnet feed set is
 * guaranteed identical. Base feeds are keyed by Base token address.
 *
 * Conservative population per the prompt Do-NOT: only feeds verified on
 * data.chain.link are included. A missing feed falls through to null (then
 * DefiLlama / fail-safe), which is far safer than a wrong feed address.
 */
import { CHAINLINK_FEEDS, CHAINLINK_ETH_USD, NATIVE_ETH, WETH_ADDRESS } from '../constants'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

export const CHAINLINK_FEEDS_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
  // Mainnet — reuse the canonical map (token address → feed proxy).
  1: CHAINLINK_FEEDS,
  // Base (8453) — keyed by Base token address.
  8453: {
    // WETH → ETH/USD (verified, data.chain.link)
    '0x4200000000000000000000000000000000000006': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    // NOTE: further Base feeds (USDC/USD, DAI/USD, cbETH/USD, …) must be
    // verified against data.chain.link before being added here. Under-
    // populating is intentional — a wrong feed mis-prices swaps.
  },
}

/**
 * Resolve the Chainlink feed-proxy address for a token on a given chain.
 * Defaults to mainnet (chainId 1), whose path is byte-identical to the legacy
 * getChainlinkFeed in chainlink.ts.
 */
export function getChainlinkFeed(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): `0x${string}` | null {
  const addr = tokenAddress.toLowerCase()

  if (chainId === 1) {
    // ── Unchanged mainnet behaviour ──
    if (addr === NATIVE_ETH.toLowerCase() || addr === WETH_ADDRESS.toLowerCase()) {
      return CHAINLINK_ETH_USD
    }
    return CHAINLINK_FEEDS[addr] ?? null
  }

  const feeds = CHAINLINK_FEEDS_BY_CHAIN[chainId]
  if (!feeds) return null
  // Native ETH on an L2 maps to that chain's wrapped-native (WETH) address.
  let wrapped: string
  try {
    wrapped = getChainConfig(chainId).nativeCurrency.wrappedAddress.toLowerCase()
  } catch {
    return null
  }
  const key = addr === NATIVE_ETH.toLowerCase() ? wrapped : addr
  return feeds[key] ?? null
}
