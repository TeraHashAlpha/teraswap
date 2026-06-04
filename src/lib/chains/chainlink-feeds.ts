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
  // Base (8453) — keyed by Base token address (lowercased; getChainlinkFeed lowercases the lookup).
  // [SPRINT-9S S1 / rule #9] EACH feed verified 3 independent ways — wrong address = wrong
  // validation, so no guessing:
  //   (1) Chainlink reference-data-directory (official feeds-ethereum-mainnet-base-1.json)
  //   (2) on-chain description() + decimals() read on Base mainnet (cast)
  //   (3) BaseScan cross-reference (EACAggregatorProxy, Chainlink deployer)
  8453: {
    // WETH → ETH/USD   description() "ETH / USD", decimals() 8
    '0x4200000000000000000000000000000000000006': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    // USDC → USDC/USD  description() "USDC / USD", decimals() 8  [SPRINT-9S S1]
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '0x458138Fc0D67027E9A6778ef40a6ffC318c69061',
    // DAI  → DAI/USD   description() "DAI / USD", decimals() 8   [SPRINT-9S S1]
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': '0x591e79239a7d679378eC8c847e5038150364C78F',
    // NOT mapped, by design (rule #9 — a wrong feed mis-prices swaps):
    //  • cbETH (0x2Ae3…0DEc22): Chainlink publishes only cbETH/ETH on Base (description()
    //    "CBETH / ETH", 18 dp — ETH-denominated). Dropping it into this USD-keyed map would
    //    read ~1.08 as "$1.08". Correct support needs cbETH/ETH × ETH/USD composition, which
    //    is a validation-layer feature beyond this map (see FEEDBACK 9S — follow-up).
    //  • USDbC (0xd9aA…b6CA): no Chainlink feed exists on Base (absent from the directory).
    //  Both correctly fall through to null → multi-source compare + on-chain minimumOutput.
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
