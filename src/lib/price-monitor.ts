/**
 * TeraSwap — Price Monitor
 *
 * Polls Chainlink oracles on Ethereum mainnet to get real-time USD prices
 * for tokens. Used by conditional orders (SL/TP) to detect trigger conditions.
 *
 * Falls back to CoW quote API for tokens without Chainlink feeds.
 */

import { parseAbi, erc20Abi } from 'viem'
import { CHAINLINK_ETH_USD, CHAINLINK_FEEDS, NATIVE_ETH, WETH_ADDRESS } from './constants'
import { fetchCurrentPrice } from './limit-order-api'
import { getPrivateClient } from './rpc'

// ── Viem public client for Chainlink reads (privacy-preserving) ──
// Lazy-initialized to avoid calling getPrivateClient at module load time
let _publicClient: ReturnType<typeof getPrivateClient> | null = null
function getClient() {
  if (!_publicClient) _publicClient = getPrivateClient()
  return _publicClient
}

// Chainlink AggregatorV3 ABI (minimal)
const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

// ── Cache for feed decimals + token decimals ──────────────
const feedDecimalsCache = new Map<string, number>()
const tokenDecimalsCache = new Map<string, number>()

async function getFeedDecimals(feedAddress: `0x${string}`): Promise<number> {
  const cached = feedDecimalsCache.get(feedAddress)
  if (cached !== undefined) return cached

  const decimals = await getClient().readContract({
    address: feedAddress,
    abi: aggregatorAbi,
    functionName: 'decimals',
  })
  const num = Number(decimals)
  feedDecimalsCache.set(feedAddress, num)
  return num
}

// ── Read Chainlink price for a token address ───────────────
export async function getChainlinkPriceUSD(
  tokenAddress: string,
): Promise<number | null> {
  const addr = tokenAddress.toLowerCase()

  // ETH/WETH → use ETH/USD feed
  const isEth =
    addr === NATIVE_ETH.toLowerCase() ||
    addr === WETH_ADDRESS.toLowerCase()

  const feedAddress = isEth
    ? CHAINLINK_ETH_USD
    : CHAINLINK_FEEDS[addr]

  if (!feedAddress) return null

  try {
    const [, answer] = await getClient().readContract({
      address: feedAddress,
      abi: aggregatorAbi,
      functionName: 'latestRoundData',
    })

    const decimals = await getFeedDecimals(feedAddress)
    return Number(answer) / (10 ** decimals)
  } catch {
    return null
  }
}

// ── Get USD price with fallback ─────────────────────────────
// Tries Chainlink first, falls back to CoW quote (token → USDC)
export async function getTokenPriceUSD(tokenAddress: string): Promise<number> {
  // Try Chainlink
  const chainlinkPrice = await getChainlinkPriceUSD(tokenAddress)
  if (chainlinkPrice !== null && chainlinkPrice > 0) return chainlinkPrice

  // Fallback: get price via CoW (1 token → USDC)
  try {
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const addr = tokenAddress.toLowerCase()

    // [BUGFIX] Determine actual token decimals instead of hardcoding 18
    // ETH/WETH = 18, but USDC = 6, WBTC = 8, etc.
    let tokenDecimals = 18
    const isEth =
      addr === NATIVE_ETH.toLowerCase() ||
      addr === WETH_ADDRESS.toLowerCase()

    if (!isEth) {
      const cached = tokenDecimalsCache.get(addr)
      if (cached !== undefined) {
        tokenDecimals = cached
      } else {
        try {
          const dec = await getClient().readContract({
            address: addr as `0x${string}`,
            abi: erc20Abi,
            functionName: 'decimals',
          })
          tokenDecimals = Number(dec)
          tokenDecimalsCache.set(addr, tokenDecimals)
        } catch { /* default to 18 */ }
      }
    }

    const oneToken = (10n ** BigInt(tokenDecimals)).toString()
    const price = await fetchCurrentPrice(
      tokenAddress,
      USDC,
      oneToken,
      tokenDecimals,
      6,
    )
    return price // This gives approximate USD value
  } catch {
    return 0
  }
}

// ── Check if trigger condition is met ───────────────────────
export function isTriggerMet(
  currentPrice: number,
  triggerPrice: number,
  direction: 'above' | 'below',
): boolean {
  if (currentPrice <= 0) return false
  if (direction === 'below') return currentPrice <= triggerPrice
  if (direction === 'above') return currentPrice >= triggerPrice
  return false
}
