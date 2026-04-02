/**
 * DefiLlama Price API — free, no API key required.
 * Used as a secondary oracle for server-side price validation.
 *
 * API docs: https://defillama.com/docs/api
 * Endpoint: https://coins.llama.fi/prices/current/{chain}:{address}
 */

const DEFILLAMA_BASE = 'https://coins.llama.fi/prices/current'
const FETCH_TIMEOUT_MS = 3_000 // 3s — don't block swap flow

export interface DefiLlamaPrice {
  price: number       // USD price
  symbol: string
  timestamp: number
  confidence: number  // 0-1
}

// ── Simple in-memory cache (5 min TTL) ────────────────────
const cache = new Map<string, { data: DefiLlamaPrice; expiresAt: number }>()
const CACHE_TTL_MS = 120_000 // 2 minutes (Q60: reduced from 5min for faster price updates)

// [INT-01] High-value swap threshold — above this, DefiLlama validation is blocking
export const HIGH_VALUE_THRESHOLD_USD = 10_000

/**
 * Fetch current USD price for an Ethereum token from DefiLlama.
 * Returns null on any error (non-blocking — swaps should never fail because of this).
 */
export async function fetchDefiLlamaPrice(
  tokenAddress: string,
  chain: string = 'ethereum',
): Promise<DefiLlamaPrice | null> {
  const key = `${chain}:${tokenAddress.toLowerCase()}`

  // Check cache
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const res = await fetch(`${DEFILLAMA_BASE}/${key}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timeout)

    if (!res.ok) return null

    const json = await res.json()
    const coin = json.coins?.[key]
    // Q59: Validate response structure — reject malformed/zero/negative prices
    if (!coin || typeof coin.price !== 'number' || coin.price <= 0 || !isFinite(coin.price)) return null
    // Reject low-confidence prices (< 0.5) — could be stale or unreliable
    if (typeof coin.confidence === 'number' && coin.confidence < 0.5) return null

    const data: DefiLlamaPrice = {
      price: coin.price,
      symbol: coin.symbol || '?',
      timestamp: coin.timestamp || Math.floor(Date.now() / 1000),
      confidence: coin.confidence ?? 1,
    }

    // Cache result
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
    return data
  } catch {
    return null // Never block swaps on oracle failure
  }
}

/**
 * Fetch prices for multiple tokens in a single API call.
 * DefiLlama supports comma-separated coin IDs.
 */
export async function fetchDefiLlamaPrices(
  tokenAddresses: string[],
  chain: string = 'ethereum',
): Promise<Map<string, DefiLlamaPrice>> {
  const result = new Map<string, DefiLlamaPrice>()
  if (tokenAddresses.length === 0) return result

  const keys = tokenAddresses.map(a => `${chain}:${a.toLowerCase()}`)

  // Check cache first, only fetch missing
  const missing: string[] = []
  for (const key of keys) {
    const cached = cache.get(key)
    if (cached && Date.now() < cached.expiresAt) {
      result.set(key.split(':')[1], cached.data)
    } else {
      missing.push(key)
    }
  }

  if (missing.length === 0) return result

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const res = await fetch(`${DEFILLAMA_BASE}/${missing.join(',')}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timeout)

    if (!res.ok) return result

    const json = await res.json()
    for (const key of missing) {
      const coin = json.coins?.[key]
      if (!coin || !coin.price || coin.price <= 0) continue

      const data: DefiLlamaPrice = {
        price: coin.price,
        symbol: coin.symbol || '?',
        timestamp: coin.timestamp || Math.floor(Date.now() / 1000),
        confidence: coin.confidence ?? 1,
      }

      cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
      result.set(key.split(':')[1], data)
    }
  } catch {
    // Best-effort — return whatever we got from cache
  }

  return result
}

/**
 * Validate swap output against DefiLlama oracle prices.
 * Returns deviation info or null if prices unavailable.
 *
 * @param tokenIn   - Input token address
 * @param tokenOut  - Output token address
 * @param amountIn  - Raw input amount (bigint string)
 * @param amountOut - Raw output amount (bigint string)
 * @param decimalsIn  - Input token decimals
 * @param decimalsOut - Output token decimals
 */
export async function validateSwapPrice(params: {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  decimalsIn: number
  decimalsOut: number
  estimatedValueUsd?: number  // [INT-01] If provided, used for high-value threshold logic
}): Promise<{
  valid: boolean
  blocked: boolean           // [INT-01] true = swap must be blocked
  deviation: number          // 0.05 = 5%
  oraclePriceIn: number | null
  oraclePriceOut: number | null
  reason?: string
  estimatedValueUsd?: number // [INT-01] Estimated USD value of the swap
} | null> {
  const { tokenIn, tokenOut, amountIn, amountOut, decimalsIn, decimalsOut } = params

  // Fetch both prices in parallel
  const [priceIn, priceOut] = await Promise.all([
    fetchDefiLlamaPrice(tokenIn),
    fetchDefiLlamaPrice(tokenOut),
  ])

  // Need both prices to validate
  if (!priceIn || !priceOut) {
    const valueUsd = params.estimatedValueUsd ?? 0
    // [INT-01] DefiLlama blocking for high-value swaps — defense against oracle manipulation window
    if (valueUsd > HIGH_VALUE_THRESHOLD_USD) {
      return {
        valid: false,
        blocked: true,
        deviation: 0,
        oraclePriceIn: priceIn?.price ?? null,
        oraclePriceOut: priceOut?.price ?? null,
        estimatedValueUsd: valueUsd,
        reason: `Price validation unavailable for high-value swap (~$${Math.round(valueUsd).toLocaleString()}). Secondary oracle (DefiLlama) is unreachable. Try again in a few moments.`,
      }
    }
    return null // Small swaps: fail-open (current behaviour)
  }

  // Skip low-confidence prices
  if (priceIn.confidence < 0.5 || priceOut.confidence < 0.5) {
    const valueUsd = params.estimatedValueUsd ?? 0
    if (valueUsd > HIGH_VALUE_THRESHOLD_USD) {
      return {
        valid: false,
        blocked: true,
        deviation: 0,
        oraclePriceIn: priceIn.price,
        oraclePriceOut: priceOut.price,
        estimatedValueUsd: valueUsd,
        reason: `Price validation confidence too low for high-value swap (~$${Math.round(valueUsd).toLocaleString()}). Oracle data may be stale.`,
      }
    }
    return null
  }

  try {
    // Calculate fair exchange rate from oracle
    // fairAmountOut = amountIn * (priceIn / priceOut) * (10^decimalsOut / 10^decimalsIn)
    const inFloat = Number(amountIn) / 10 ** decimalsIn
    const outFloat = Number(amountOut) / 10 ** decimalsOut

    const inUsd = inFloat * priceIn.price
    const outUsd = outFloat * priceOut.price

    if (inUsd <= 0 || outUsd <= 0) return null

    // Deviation: how far is actual output from fair value
    // Negative = user gets less (normal, due to fees + slippage)
    // Positive = user gets more (suspicious if large)
    const deviation = (outUsd - inUsd) / inUsd

    // Block if user is getting >8% less than fair value
    // (accounts for: 0.1% fee + up to 5% slippage + oracle lag)
    const BLOCK_THRESHOLD = -0.08

    if (deviation < BLOCK_THRESHOLD) {
      return {
        valid: false,
        blocked: true,
        deviation,
        oraclePriceIn: priceIn.price,
        oraclePriceOut: priceOut.price,
        estimatedValueUsd: params.estimatedValueUsd,
        reason: `Swap output is ${Math.abs(deviation * 100).toFixed(1)}% below fair market value (DefiLlama oracle). Possible price manipulation or extreme slippage.`,
      }
    }

    return {
      valid: true,
      blocked: false,
      deviation,
      oraclePriceIn: priceIn.price,
      oraclePriceOut: priceOut.price,
      estimatedValueUsd: params.estimatedValueUsd,
    }
  } catch {
    const valueUsd = params.estimatedValueUsd ?? 0
    if (valueUsd > HIGH_VALUE_THRESHOLD_USD) {
      return {
        valid: false,
        blocked: true,
        deviation: 0,
        oraclePriceIn: null,
        oraclePriceOut: null,
        estimatedValueUsd: valueUsd,
        reason: 'Price validation error for high-value swap. Secondary oracle validation could not be completed.',
      }
    }
    return null // Don't block small swaps on calculation errors
  }
}
