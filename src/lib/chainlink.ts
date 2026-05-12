import { encodeFunctionData, decodeFunctionResult } from 'viem'
import {
  CHAINLINK_ETH_USD,
  CHAINLINK_FEEDS,
  NATIVE_ETH,
  WETH_ADDRESS,
  PRICE_DEVIATION_WARN,
  PRICE_DEVIATION_BLOCK,
  CHAINLINK_MAX_STALENESS_SEC,
} from './constants'

// ── Chainlink AggregatorV3 ABI (minimal) ─────────────────
export const chainlinkAggregatorAbi = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '_roundId', type: 'uint80' }],
    name: 'getRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// ── Types ────────────────────────────────────────────────
export type PriceWarningLevel = 'none' | 'warn' | 'danger'

export interface PriceCheck {
  chainlinkPrice: number | null  // preço USD do Chainlink
  executionPrice: number | null  // preço implícito do swap
  deviation: number              // % de desvio (0.02 = 2%)
  level: PriceWarningLevel
  message: string | null
  oracleUnavailable: boolean     // true when no Chainlink feed exists for this pair
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Get Chainlink feed address for a token.
 * ETH/WETH → ETH/USD feed.
 * Returns null if no feed exists.
 */
export function getChainlinkFeed(tokenAddress: string): `0x${string}` | null {
  const addr = tokenAddress.toLowerCase()
  if (addr === NATIVE_ETH.toLowerCase() || addr === WETH_ADDRESS.toLowerCase()) {
    return CHAINLINK_ETH_USD
  }
  return CHAINLINK_FEEDS[addr] ?? null
}

/**
 * Evaluate price deviation between Chainlink oracle and swap execution price.
 */
export function evaluateDeviation(
  chainlinkPrice: number,
  executionPrice: number,
): PriceCheck {
  if (chainlinkPrice <= 0 || executionPrice <= 0) {
    return { chainlinkPrice, executionPrice, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  const deviation = Math.abs(executionPrice - chainlinkPrice) / chainlinkPrice

  if (deviation >= PRICE_DEVIATION_BLOCK) {
    return {
      chainlinkPrice,
      executionPrice,
      deviation,
      level: 'danger',
      message: `Warning: this swap price deviates ${(deviation * 100).toFixed(1)}% from market price (Chainlink). Possible price manipulation or low liquidity.`,
      oracleUnavailable: false,
    }
  }

  if (deviation >= PRICE_DEVIATION_WARN) {
    return {
      chainlinkPrice,
      executionPrice,
      deviation,
      level: 'warn',
      message: `Price deviates ${(deviation * 100).toFixed(1)}% from Chainlink oracle. Make sure you're comfortable with this deviation.`,
      oracleUnavailable: false,
    }
  }

  return { chainlinkPrice, executionPrice, deviation, level: 'none', message: null, oracleUnavailable: false }
}

// ══════════════════════════════════════════════════════════
//  RAW RPC PRICE FETCHES (for DCA engine — no React hooks)
// ══════════════════════════════════════════════════════════

function getRpcUrl(): string {
  // In browser context, route through privacy proxy to hide user IP
  if (typeof window !== 'undefined') return '/api/rpc'
  return process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com'
}

/** Raw RPC call helper */
async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(getRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  if (!res.ok) throw new Error(`RPC request failed: ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'RPC error')
  return json.result
}

/**
 * Fetch current Chainlink USD price for a token via direct RPC (non-hook).
 * Returns price as a number (e.g. 2850.42) or null if no feed exists.
 */
export async function fetchChainlinkPriceRaw(
  tokenAddress: string,
): Promise<{ price: number; updatedAt: number; roundId: bigint } | null> {
  const feed = getChainlinkFeed(tokenAddress)
  if (!feed) return null

  // Fetch decimals
  const decData = encodeFunctionData({
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
  })
  const decResult = await rpcCall(feed, decData)
  const decimals = Number(decodeFunctionResult({
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    data: decResult as `0x${string}`,
  }))

  // Fetch latestRoundData
  const lrdData = encodeFunctionData({
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
  })
  const lrdResult = await rpcCall(feed, lrdData)
  const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    data: lrdResult as `0x${string}`,
  }) as [bigint, bigint, bigint, bigint, bigint]

  // Security: validate Chainlink data integrity
  if (answer <= 0n) return null // invalid price
  if (answeredInRound < roundId) return null // stale round — data not updated in current round
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt)
  if (ageSeconds > CHAINLINK_MAX_STALENESS_SEC) return null // data too old

  const price = Number(answer) / 10 ** decimals
  return { price, updatedAt: Number(updatedAt), roundId }
}

/**
 * Fetch historical Chainlink price ~targetAgeSeconds ago.
 *
 * Strategy: walk backwards from latestRoundId, stepping by larger jumps,
 * then binary-searching to find the round closest to the target timestamp.
 * Max 20 RPC calls to avoid excessive usage.
 *
 * Returns price at the round closest to targetAge, or null if unavailable.
 */
export async function fetchHistoricalPrice(
  tokenAddress: string,
  targetAgeSeconds: number = 86400, // default 24h
): Promise<{ price: number; timestamp: number } | null> {
  const feed = getChainlinkFeed(tokenAddress)
  if (!feed) return null

  try {
    // Get current round info
    const current = await fetchChainlinkPriceRaw(tokenAddress)
    if (!current) return null

    const targetTimestamp = current.updatedAt - targetAgeSeconds
    const { roundId: latestRoundId } = current

    // Chainlink phase-aware round IDs:
    // roundId = (phaseId << 64) | aggregatorRoundId
    // We can only walk within the current phase
    const phaseId = latestRoundId >> 64n
    const aggregatorRoundId = latestRoundId & ((1n << 64n) - 1n)

    // Binary search within the phase
    let low = 1n
    let high = aggregatorRoundId
    let bestPrice: number | null = null
    let bestTimestamp = 0
    let bestDiff = Infinity
    let calls = 0
    const maxCalls = 16

    // Fetch decimals once
    const decData = encodeFunctionData({
      abi: chainlinkAggregatorAbi,
      functionName: 'decimals',
    })
    const decResult = await rpcCall(feed, decData)
    const decimals = Number(decodeFunctionResult({
      abi: chainlinkAggregatorAbi,
      functionName: 'decimals',
      data: decResult as `0x${string}`,
    }))

    while (low <= high && calls < maxCalls) {
      const mid = (low + high) / 2n
      const fullRoundId = (phaseId << 64n) | mid

      try {
        const rdData = encodeFunctionData({
          abi: chainlinkAggregatorAbi,
          functionName: 'getRoundData',
          args: [fullRoundId],
        })
        const rdResult = await rpcCall(feed, rdData)
        const [, answer, , updatedAt] = decodeFunctionResult({
          abi: chainlinkAggregatorAbi,
          functionName: 'getRoundData',
          data: rdResult as `0x${string}`,
        }) as [bigint, bigint, bigint, bigint, bigint]

        calls++
        const ts = Number(updatedAt)
        const diff = Math.abs(ts - targetTimestamp)

        if (diff < bestDiff) {
          bestDiff = diff
          bestPrice = Number(answer) / 10 ** decimals
          bestTimestamp = ts
        }

        if (ts < targetTimestamp) {
          low = mid + 1n
        } else if (ts > targetTimestamp) {
          high = mid - 1n
        } else {
          break // exact match
        }
      } catch {
        // Round might not exist, shrink range
        high = mid - 1n
        calls++
      }
    }

    if (bestPrice !== null && bestDiff < targetAgeSeconds * 0.5) {
      // Accept if within 50% of target age (e.g. for 24h target, accept 12h-36h)
      return { price: bestPrice, timestamp: bestTimestamp }
    }

    return null
  } catch {
    return null
  }
}

// ══════════════════════════════════════════════════════════
//  [10-L-03] SERVER-SIDE USD VALUATION
//
//  These helpers exist so server routes (e.g. /api/log-swap) can compute
//  amountInUsd themselves rather than trusting a client-controlled value
//  for monitoring thresholds. They reuse the same RPC channel as
//  fetchChainlinkPriceRaw so there is no new oracle plumbing.
// ══════════════════════════════════════════════════════════

const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

/**
 * Fetch an ERC-20 token's `decimals()` value via direct RPC.
 *
 * Returns null when the call fails or the result is outside the typical
 * ERC-20 range (1..30) — defends against contracts that revert on
 * decimals() or return garbage. Callers should treat null as "decimals
 * unknown, skip server-side USD computation".
 */
export async function fetchErc20Decimals(tokenAddress: string): Promise<number | null> {
  try {
    const data = encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })
    const result = await rpcCall(tokenAddress, data)
    if (!result || result === '0x') return null
    const decoded = decodeFunctionResult({
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
      data: result as `0x${string}`,
    }) as number
    if (!Number.isInteger(decoded) || decoded < 1 || decoded > 30) return null
    return decoded
  } catch {
    return null
  }
}

/**
 * [10-L-03] Server-trusted USD valuation of a raw wei token amount.
 *
 * Pulls the Chainlink price + the token's ERC-20 decimals via RPC and
 * computes `usd = (rawAmount / 10^decimals) * price`. Returns null when
 * any step fails — caller decides whether to fall back to a client-
 * supplied figure (with a flag) or skip the threshold check.
 *
 * Uses BigInt arithmetic for the divisor to preserve precision on
 * decimal-heavy tokens (USDC 6, WBTC 8, etc. — Number(rawWei) on 18-dec
 * tokens above ~9007 ETH starts losing integer precision).
 */
export async function computeTokenAmountUsd(
  tokenAddress: string,
  rawAmountWei: string,
): Promise<{ usd: number; price: number; decimals: number } | null> {
  if (!tokenAddress || !rawAmountWei) return null

  // Parallelise the two RPC calls — they're independent.
  const [priceResult, decimals] = await Promise.all([
    fetchChainlinkPriceRaw(tokenAddress).catch(() => null),
    fetchErc20Decimals(tokenAddress).catch(() => null),
  ])

  if (!priceResult) return null
  if (decimals === null) return null

  try {
    const rawBn = BigInt(rawAmountWei)
    if (rawBn < 0n) return null
    const divisor = 10n ** BigInt(decimals)
    // Two-part conversion preserves precision: take the integer part as
    // a BigInt → Number cast (always safe within 53 bits for any realistic
    // token amount), then add the fractional part as a float.
    const integerPart = Number(rawBn / divisor)
    const fractionalPart = Number(rawBn % divisor) / Number(divisor)
    const tokenAmount = integerPart + fractionalPart
    if (!Number.isFinite(tokenAmount)) return null
    return { usd: tokenAmount * priceResult.price, price: priceResult.price, decimals }
  } catch {
    return null
  }
}
