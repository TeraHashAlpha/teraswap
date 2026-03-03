/**
 * TeraSwap — Price Monitor
 *
 * Polls Chainlink oracles on Ethereum mainnet to get real-time USD prices
 * for tokens. Used by conditional orders (SL/TP) to detect trigger conditions.
 *
 * Falls back to CoW quote API for tokens without Chainlink feeds.
 */

import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'
import { CHAINLINK_ETH_USD, CHAINLINK_FEEDS, NATIVE_ETH, WETH_ADDRESS } from './constants'
import { fetchCurrentPrice } from './limit-order-api'

// ── Viem public client for Chainlink reads ─────────────────
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
})

// Chainlink AggregatorV3 ABI (minimal)
const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

// ── Cache for feed decimals ────────────────────────────────
const feedDecimalsCache = new Map<string, number>()

async function getFeedDecimals(feedAddress: `0x${string}`): Promise<number> {
  const cached = feedDecimalsCache.get(feedAddress)
  if (cached !== undefined) return cached

  const decimals = await publicClient.readContract({
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
    const [, answer] = await publicClient.readContract({
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
    const price = await fetchCurrentPrice(
      tokenAddress,
      USDC,
      '1000000000000000000', // 1e18 (assume 18 decimals, will be adjusted)
      18,
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
