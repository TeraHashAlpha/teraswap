import {
  FEE_COLLECTOR_ADDRESS,
  FEE_INCOMPATIBLE_SOURCES,
  DISABLED_SOURCES,
  DEFAULT_SLIPPAGE,
  QUOTE_TIMEOUT_MS,
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  COW_SETTLEMENT,
  ODOS_ROUTER_V3,
  UNISWAP_SWAP_ROUTER_02,
  type AggregatorName,
} from './constants'
import { globalLimiter } from './rate-limiter'
import {
  ADAPTER_REGISTRY,
  withTimeout,
  friendlyError,
} from './adapters'
import { withCircuitBreaker, getCircuitBreaker, getAllCircuitStates } from './adapters/circuit-breaker'
import type { NormalizedQuote, MetaQuoteResult } from './adapters'

// ── Re-exports (preserve all existing public API) ───────
export type { NormalizedQuote, MetaQuoteResult, FeeTierCandidate, FeeTierDetection } from './adapters'
export { submitCowOrder, pollCowOrderStatus, detectUniswapV3FeeTier } from './adapters'
export { getAllCircuitStates }

// ══════════════════════════════════════════════════════════
//  META-AGGREGATOR ORCHESTRATOR
// ══════════════════════════════════════════════════════════

/**
 * Fetch quotes from ALL 11 sources in parallel,
 * normalize, sort by best net output.
 */
export async function fetchMetaQuote(
  src: string,
  dst: string,
  amount: string,
  srcDecimals: number = 18,
  dstDecimals: number = 18,
  excludeSources?: string[],
): Promise<MetaQuoteResult> {
  // Rate limit: max 30 global requests/min
  if (!globalLimiter.allow('meta_quote')) {
    throw new Error('Rate limited — too many requests. Please wait a moment.')
  }

  // All available sources from adapter registry
  const allSources = ADAPTER_REGISTRY
    .filter(a => {
      if (DISABLED_SOURCES[a.name]) {
        console.info(`[SOURCE] ${a.name} disabled: ${DISABLED_SOURCES[a.name]}`)
        return false
      }
      return true
    })
    .map(a => ({
      name: a.name,
      fetch: () => a.fetchQuote({ src, dst, amount, srcDecimals, dstDecimals }) as Promise<NormalizedQuote>,
    }))

  // [CB-01] Skip sources with OPEN circuit breaker
  const cbFiltered = allSources.filter(s => {
    const cb = getCircuitBreaker(s.name)
    return !cb.isOpen() // isOpen() handles OPEN → HALF_OPEN transition internally
  })

  // NOTE: FEE_INCOMPATIBLE_SOURCES (0x, CoW) are NOT filtered from quotes.
  // They still appear so users can choose them (e.g. MEV Protection via CoW).
  // Fee collection is skipped at execution time via usesFeeCollector() check.
  const excludeSet = excludeSources ? new Set(excludeSources.map(s => s.toLowerCase())) : null
  const activeSources = excludeSet
    ? cbFiltered.filter(s => !excludeSet.has(s.name.toLowerCase()))
    : cbFiltered

  const sourceNames: AggregatorName[] = activeSources.map(s => s.name)
  const startTime = Date.now()
  const results = await Promise.allSettled(
    activeSources.map(s =>
      withCircuitBreaker(s.name, () => withTimeout(s.fetch(), QUOTE_TIMEOUT_MS))
    )
  )
  const elapsed = Date.now() - startTime

  // ── Source monitoring: record success/failure per aggregator ──
  try {
    const { recordSourcePing } = await import('./source-monitor')
    results.forEach((r, i) => {
      const name = sourceNames[i]
      if (r.status === 'fulfilled' && r.value.toAmount && BigInt(r.value.toAmount) > 0n) {
        recordSourcePing(name, true, elapsed)
      } else {
        const error = r.status === 'rejected' ? String(r.reason) : 'Zero output'
        recordSourcePing(name, false, elapsed, error)
      }
    })
  } catch { /* monitoring is best-effort */ }

  const quotes: NormalizedQuote[] = results
    .filter((r): r is PromiseFulfilledResult<NormalizedQuote> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q) => {
      try {
        return q.toAmount && BigInt(q.toAmount) > 0n
      } catch {
        return false
      }
    })

  if (quotes.length === 0) {
    // Build a helpful error from the individual failures
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r, i) => {
        const sources = ['1inch', '0x', 'Velora', 'Odos', 'KyberSwap', 'CoW', 'Uniswap V3', 'OpenOcean', 'SushiSwap', 'Balancer', 'Curve']
        return friendlyError(sources[i] ?? 'Unknown', r.reason)
      })
    const allTimeout = errors.every(e => e.includes('timed out'))
    const allNetwork = errors.every(e => e.includes('Network error'))
    if (allTimeout) throw new Error('All sources timed out. Check your connection and try again.')
    if (allNetwork) throw new Error('Network error. Check your internet connection.')
    throw new Error(`No valid quotes. ${errors[0] || 'Try a different pair or amount.'}`)
  }

  // ── Gas-aware sorting ──
  quotes.sort((a, b) => {
    try {
      const aOut = BigInt(a.toAmount)
      const bOut = BigInt(b.toAmount)

      if (a.gasUsd > 0 || b.gasUsd > 0) {
        const gasDiffUsd = a.gasUsd - b.gasUsd
        const diff = bOut - aOut
        if (diff !== 0n) return diff > 0n ? 1 : -1
        return gasDiffUsd > 0 ? 1 : gasDiffUsd < 0 ? -1 : 0
      }

      const diff = bOut - aOut
      return diff > 0n ? 1 : diff < 0n ? -1 : 0
    } catch {
      return 0
    }
  })

  // ── Outlier detection ──
  if (quotes.length >= 2) {
    const amounts = quotes.map(q => { try { return BigInt(q.toAmount) } catch { return 0n } })
    const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2n
      : sorted[mid]
    if (median > 0n) {
      const threshold = median * 3n
      const filtered = quotes.filter(q => {
        try {
          return BigInt(q.toAmount) <= threshold
        } catch {
          return true
        }
      })

      // ── Cross-quote validation ──
      const CROSS_QUOTE_WARN_THRESHOLD = 0.05
      let crossQuoteDeviation: number | undefined
      let crossQuoteWarning = false

      if (filtered.length > 0) {
        try {
          const bestAmount = BigInt(filtered[0].toAmount)
          crossQuoteDeviation = Number(bestAmount - median) / Number(median)
          if (crossQuoteDeviation > CROSS_QUOTE_WARN_THRESHOLD) {
            crossQuoteWarning = true
          }
        } catch { /* ignore calculation errors */ }
      }

      if (filtered.length > 0) {
        return {
          best: filtered[0],
          all: filtered,
          fetchedAt: Date.now(),
          crossQuoteDeviation,
          crossQuoteWarning,
        }
      }
    }
  }

  return {
    best: quotes[0],
    all: quotes,
    fetchedAt: Date.now(),
  }
}

// ══════════════════════════════════════════════════════════
//  FEE INTEGRITY VALIDATION
// ══════════════════════════════════════════════════════════

/**
 * Validate that the swap quote respects the expected fee deduction.
 */
export function validateFeeIntegrity(
  quoteToAmount: string,
  swapToAmount: string,
  source: AggregatorName,
): { valid: boolean; reason?: string } {
  const skipSources: AggregatorName[] = ['uniswapv3', 'curve', 'cowswap']
  if (skipSources.includes(source)) return { valid: true }

  const quoted = BigInt(quoteToAmount)
  const swapped = BigInt(swapToAmount)

  if (quoted <= 0n) return { valid: true }

  const tolerance = quoted * 2n / 100n
  if (swapped > quoted + tolerance) {
    return {
      valid: false,
      reason: `Fee integrity check failed for ${source}: swap output (${swapToAmount}) is unexpectedly higher than quoted (${quoteToAmount}). Partner fee may not be applied.`,
    }
  }

  return { valid: true }
}

// ══════════════════════════════════════════════════════════
//  SWAP DISPATCHER
// ══════════════════════════════════════════════════════════

/**
 * Fetch swap tx data from the WINNING aggregator.
 */
export async function fetchSwapFromSource(
  source: AggregatorName,
  src: string,
  dst: string,
  amount: string,
  from: string,
  slippage: number = DEFAULT_SLIPPAGE,
  srcDecimals: number = 18,
  dstDecimals: number = 18,
  quoteMeta?: NormalizedQuote['meta'],
  chainId?: number,
): Promise<NormalizedQuote> {
  if (DISABLED_SOURCES[source]) throw new Error(`${source} is disabled: ${DISABLED_SOURCES[source]}`)
  const adapter = ADAPTER_REGISTRY.find(a => a.name === source)
  if (!adapter) throw new Error(`Unknown source: ${source}`)

  const result = await withCircuitBreaker(source, () =>
    adapter.fetchSwapData({
      src, dst, amount, from, slippage,
      srcDecimals, dstDecimals,
      quoteMeta: quoteMeta as Record<string, any> | undefined,
      chainId,
    })
  )
  if (!result) throw new Error(`${source}: no swap data returned`)
  return result
}

// ══════════════════════════════════════════════════════════
//  FEE COLLECTOR HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Check if FeeCollector proxy is deployed and configured.
 */
export function isFeeCollectorActive(): boolean {
  return !!FEE_COLLECTOR_ADDRESS && FEE_COLLECTOR_ADDRESS.length === 42
}

/**
 * Check if a source uses the FeeCollector proxy for fee collection.
 */
export function usesFeeCollector(source: AggregatorName): boolean {
  return isFeeCollectorActive() && !FEE_INCOMPATIBLE_SOURCES.includes(source)
}

// ══════════════════════════════════════════════════════════
//  APPROVE SPENDER
// ══════════════════════════════════════════════════════════

/**
 * Fetch approved spender address for a given source.
 */
export async function fetchApproveSpender(source: AggregatorName): Promise<`0x${string}`> {
  if (usesFeeCollector(source)) {
    return FEE_COLLECTOR_ADDRESS
  }

  switch (source) {
    case '1inch':
      return '0x111111125421cA6dc452d289314280a0f8842A65' as `0x${string}`
    case '0x':
      return PERMIT2_ADDRESS as `0x${string}`
    case 'velora':
      return '0x216B4B4Ba9F3e719726886d34a177484278BfcaE' as `0x${string}`
    case 'odos':
      return ODOS_ROUTER_V3 as `0x${string}`
    case 'kyberswap':
      return '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as `0x${string}`
    case 'cowswap':
      return COW_VAULT_RELAYER as `0x${string}`
    case 'uniswapv3':
      return UNISWAP_SWAP_ROUTER_02 as `0x${string}`
    case 'openocean':
      return '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64' as `0x${string}`
    case 'sushiswap':
      return '0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e' as `0x${string}`
    case 'balancer':
      return '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as `0x${string}`
    case 'curve':
      return '0x16C6521Dff6baB339122a0FE25a9116693265353' as `0x${string}`
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}

// ══════════════════════════════════════════════════════════
//  SECURITY: Router Address Whitelist
// ══════════════════════════════════════════════════════════

/** Whitelisted router addresses (lowercase). Only these can receive swap transactions. */
const ROUTER_WHITELIST: Set<string> = new Set([
  PERMIT2_ADDRESS.toLowerCase(),
  COW_VAULT_RELAYER.toLowerCase(),
  COW_SETTLEMENT.toLowerCase(),
  ODOS_ROUTER_V3.toLowerCase(),
  UNISWAP_SWAP_ROUTER_02.toLowerCase(),
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Aggregator Router
  '0x6352a56caadc4f1e25cd6c75970fa768a3304e64', // OpenOcean Exchange Proxy
  '0x46b3fdf7b5cde91ac049936bf0bdb12c5d22202e', // SushiSwap RouteProcessor4
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault V2
  '0x111111125421ca6dc452d289314280a0f8842a65', // 1inch AggregationRouter v6
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch AggregationRouter v5 (legacy)
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy (mainnet)
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // ParaSwap Augustus V6 (Velora)
  '0x216b4b4ba9f3e719726886d34a177484278bfcae', // ParaSwap Augustus V6.2
  '0x16c6521dff6bab339122a0fe25a9116693265353', // Curve CurveRouterNG (mainnet)
  ...(FEE_COLLECTOR_ADDRESS ? [FEE_COLLECTOR_ADDRESS.toLowerCase()] : []),
])

/**
 * Validate that a swap transaction targets a whitelisted router.
 */
export function validateRouterAddress(
  txTo: string,
  source: AggregatorName,
): { valid: boolean; reason?: string } {
  const normalized = txTo.toLowerCase()

  if (ROUTER_WHITELIST.has(normalized)) {
    return { valid: true }
  }

  console.error(
    `[TeraSwap] BLOCKED: Swap target ${txTo} for ${source} is NOT in the router whitelist. ` +
    `If this is a legitimate new router, add it to ROUTER_WHITELIST in api.ts.`
  )

  return {
    valid: false,
    reason: `Swap target ${txTo} for ${source} is NOT in the router whitelist. Possible API compromise.`,
  }
}
