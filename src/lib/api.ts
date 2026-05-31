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
import { getQuote as getCachedQuote, setQuote as setCachedQuote, quoteCacheKey } from './quote-cache'
import {
  ADAPTER_REGISTRY,
  withTimeout,
  friendlyError,
} from './adapters'
import { withCircuitBreaker, getCircuitBreaker, getAllCircuitStates } from './adapters/circuit-breaker'
import { isWhitelistedRouter, ROUTER_WHITELIST_BY_CHAIN } from './chains/routers'
import { DEFAULT_CHAIN_ID, getChainConfig } from './chains/registry'
import { getFeeIncompatibleSources } from './chains/activation'
import type { NormalizedQuote, MetaQuoteResult, QuoteMeta, QuoteParams, DEXAdapter } from './adapters'

// ── Re-exports (preserve all existing public API) ───────
export type { NormalizedQuote, MetaQuoteResult, FeeTierCandidate, FeeTierDetection, QuoteMeta, CowQuoteMeta, UniswapV3QuoteMeta, GenericQuoteMeta } from './adapters'
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
  /** [P217] Target chain. Omitted → mainnet (DEFAULT_CHAIN_ID), so existing
   *  callers (which don't pass it) keep mainnet behaviour exactly. */
  chainId?: number,
): Promise<MetaQuoteResult> {
  // [P188] Server-side cache — check BEFORE the rate limiter so a
  // cache hit never costs a token in the outbound budget.
  const cacheKey = quoteCacheKey({ src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId })
  const cached = getCachedQuote(cacheKey)
  if (cached) return cached

  // Rate limit: max 120 global requests/min (P187)
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
      fetch: () => a.fetchQuote({ src, dst, amount, srcDecimals, dstDecimals, chainId }) as Promise<NormalizedQuote>,
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
        const result: MetaQuoteResult = {
          best: filtered[0],
          all: filtered,
          fetchedAt: Date.now(),
          crossQuoteDeviation,
          crossQuoteWarning,
        }
        setCachedQuote(cacheKey, result)
        return result
      }
    }
  }

  const result: MetaQuoteResult = {
    best: quotes[0],
    all: quotes,
    fetchedAt: Date.now(),
  }
  setCachedQuote(cacheKey, result)
  return result
}

// ══════════════════════════════════════════════════════════
//  READ-ONLY PER-SOURCE QUOTE DIAGNOSTIC  [debug=sources]
// ══════════════════════════════════════════════════════════
//
// Admin-only ground truth for "which sources actually answer on chain X".
// It mirrors fetchMetaQuote's per-source execution — SAME adapter call, SAME
// chainId threading, SAME QUOTE_TIMEOUT_MS — but is deliberately READ-ONLY:
//   • It does NOT route through withCircuitBreaker (which records success/
//     failure and could flip a production breaker toward OPEN).
//   • It reads breaker state via the pure getInfo() snapshot, never isOpen()
//     (which transitions OPEN→HALF_OPEN as a side effect).
// It surfaces the RAW adapter error (not friendlyError, which drops the HTTP
// status) so missing-key (early throw) vs 401/403 vs no-route vs Timeout are
// all distinguishable.

/** One source's quote outcome. `error`/`toAmount` are mutually informative. */
export interface SourceDiagnostic {
  source: string
  status: 'ok' | 'error'
  toAmount?: string
  error?: string
  latencyMs: number
}

export interface QuoteSourcesDiagnostics {
  chainId: number
  sources: SourceDiagnostic[]
  env: {
    ONEINCH_API_KEY: boolean
    ZEROX_API_KEY: boolean
    ODOS_API_KEY: boolean
    NEXT_PUBLIC_BASE_RPC_URL: boolean
    /** `getChainConfig(chainId).rpc.primary` is a non-empty string. */
    rpcPrimaryConfigured: boolean
    /** Primary RPC answered eth_chainId within the probe window. null = not probed. */
    rpcReachable: boolean | null
  }
}

/** Cap the raw upstream error surfaced so a verbose body can't bloat the payload. */
const DIAG_ERROR_MAX = 200
const RPC_PROBE_TIMEOUT_MS = 3_000

function rawDiagError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > DIAG_ERROR_MAX ? `${msg.slice(0, DIAG_ERROR_MAX)}…` : msg
}

/** Read-only probe of a single adapter. Never mutates circuit-breaker state. */
async function probeSource(adapter: DEXAdapter, params: QuoteParams): Promise<SourceDiagnostic> {
  const source = adapter.name
  // Config-disabled → report without executing (reflects production's skip).
  if (DISABLED_SOURCES[source]) {
    return { source, status: 'error', error: `disabled: ${DISABLED_SOURCES[source]}`, latencyMs: 0 }
  }
  // Read-only breaker check: getInfo() and getState() are pure; only isOpen()
  // mutates (it transitions OPEN→HALF_OPEN once cooldown elapses), so never use it here.
  const cb = getCircuitBreaker(source).getInfo()
  if (cb.state === 'OPEN' && cb.cooldownRemaining > 0) {
    return {
      source,
      status: 'error',
      error: `circuit breaker OPEN — skipped in production (cooldown ${cb.cooldownRemaining}ms)`,
      latencyMs: 0,
    }
  }
  const t0 = Date.now()
  try {
    // SAME call + SAME timeout as fetchMetaQuote, minus the state-mutating wrapper.
    const q = await withTimeout(adapter.fetchQuote(params), QUOTE_TIMEOUT_MS)
    const latencyMs = Date.now() - t0
    let positive = false
    try {
      positive = !!q && !!q.toAmount && BigInt(q.toAmount) > 0n
    } catch { /* non-numeric toAmount → treat as no usable quote */ }
    if (positive) {
      return { source, status: 'ok', toAmount: q!.toAmount, latencyMs }
    }
    return {
      source,
      status: 'error',
      error: q ? `no usable quote (toAmount=${q.toAmount ?? 'undefined'})` : 'null quote (no route)',
      toAmount: q?.toAmount,
      latencyMs,
    }
  } catch (err) {
    return { source, status: 'error', error: rawDiagError(err), latencyMs: Date.now() - t0 }
  }
}

/** Lightweight reachability probe (eth_chainId). Returns false on any failure.
 *  The URL is NEVER logged or returned — it can embed a provider key. */
async function probeRpcReachable(url: string): Promise<boolean> {
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      }),
      RPC_PROBE_TIMEOUT_MS,
    )
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return !!(data && (data.result !== undefined || data.id !== undefined))
  } catch {
    return false
  }
}

/**
 * Run the read-only per-source diagnostic for `chainId`. Reports each source's
 * outcome (ok / raw error / latency / toAmount), env-var presence as booleans,
 * and the target chain's registry RPC status. Emits ONE presence log line —
 * booleans only, never a secret value.
 */
export async function diagnoseQuoteSources(
  src: string,
  dst: string,
  amount: string,
  srcDecimals: number,
  dstDecimals: number,
  chainId: number,
): Promise<QuoteSourcesDiagnostics> {
  const params: QuoteParams = { src, dst, amount, srcDecimals, dstDecimals, chainId }

  // Per-source probes run concurrently, mirroring fetchMetaQuote's fan-out.
  const sources = await Promise.all(ADAPTER_REGISTRY.map((a) => probeSource(a, params)))

  // Registry RPC status for the target chain. Resolve primary defensively.
  let rpcPrimary = ''
  try {
    rpcPrimary = getChainConfig(chainId).rpc.primary ?? ''
  } catch { /* unsupported chain → leave empty */ }
  const rpcPrimaryConfigured = rpcPrimary.trim().length > 0
  const rpcReachable = rpcPrimaryConfigured ? await probeRpcReachable(rpcPrimary) : null

  const env = {
    ONEINCH_API_KEY: !!process.env.ONEINCH_API_KEY,
    ZEROX_API_KEY: !!process.env.ZEROX_API_KEY,
    ODOS_API_KEY: !!process.env.ODOS_API_KEY,
    NEXT_PUBLIC_BASE_RPC_URL: !!process.env.NEXT_PUBLIC_BASE_RPC_URL,
    rpcPrimaryConfigured,
    rpcReachable,
  }

  // [req 4] One-line presence log — booleans ONLY, the secret values never leave.
  console.info('[quote-diagnostic] env presence', { chainId, ...env })

  return { chainId, sources, env }
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
  quoteMeta?: QuoteMeta,
  chainId?: number,
  /** [P101] Optional output destination. Defaults to `from`. */
  recipient?: string,
): Promise<NormalizedQuote> {
  if (DISABLED_SOURCES[source]) throw new Error(`${source} is disabled: ${DISABLED_SOURCES[source]}`)
  const adapter = ADAPTER_REGISTRY.find(a => a.name === source)
  if (!adapter) throw new Error(`Unknown source: ${source}`)

  const result = await withCircuitBreaker(source, () =>
    adapter.fetchSwapData({
      src, dst, amount, from, slippage,
      srcDecimals, dstDecimals,
      quoteMeta,
      chainId,
      recipient,
    })
  )
  if (!result) throw new Error(`${source}: no swap data returned`)
  return result
}

// ══════════════════════════════════════════════════════════
//  FEE COLLECTOR HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Check if a FeeCollector is deployed/configured for `chainId`.
 * [P224 review] Mainnet keeps its exact prior check (byte-identical); other
 * chains read the per-chain registry (feeCollector !== null).
 */
export function isFeeCollectorActive(chainId: number = DEFAULT_CHAIN_ID): boolean {
  if (chainId === DEFAULT_CHAIN_ID) {
    return !!FEE_COLLECTOR_ADDRESS && FEE_COLLECTOR_ADDRESS.length === 42
  }
  try {
    return getChainConfig(chainId).contracts.feeCollector !== null
  } catch {
    return false
  }
}

/**
 * Check if a source uses the FeeCollector proxy for fee collection on `chainId`.
 * [P224 review] Now chain-aware: uses the per-chain fee-incompatible set. For
 * chainId 1 this is identical to the prior `isFeeCollectorActive() &&
 * !FEE_INCOMPATIBLE_SOURCES.includes(source)`.
 *
 * NOTE: the FeeCollector *address* used to build swap calldata (useSwap /
 * useSplitSwap / buildSimulationTx) and fetchApproveSpender's per-source
 * addresses are still mainnet-pinned — those must be made per-chain before Base
 * swaps go live (see FEEDBACK.md / DEPLOY.md). The activation guard keeps Base
 * gated until then.
 */
export function usesFeeCollector(source: AggregatorName, chainId: number = DEFAULT_CHAIN_ID): boolean {
  return isFeeCollectorActive(chainId) && !getFeeIncompatibleSources(chainId).includes(source)
}

// ══════════════════════════════════════════════════════════
//  APPROVE SPENDER
// ══════════════════════════════════════════════════════════

/**
 * Fetch the approved spender address for a given source on a given chain.
 * [P226] Chain-aware. Mainnet (chainId 1) is byte-identical to the prior
 * behaviour; other chains resolve from ROUTER_WHITELIST_BY_CHAIN.
 */
export async function fetchApproveSpender(source: AggregatorName, chainId: number = DEFAULT_CHAIN_ID): Promise<`0x${string}`> {
  // FeeCollector-routed sources approve the chain's FeeCollector.
  if (usesFeeCollector(source, chainId)) {
    const fc = getChainConfig(chainId).contracts.feeCollector
    if (fc) return fc
    // FeeCollector expected but not deployed — fall through to the per-source
    // spender so we never return null/zero.
  }

  if (chainId !== DEFAULT_CHAIN_ID) {
    // ── Non-mainnet — resolve from the per-chain router whitelist ──
    const spender = ROUTER_WHITELIST_BY_CHAIN[chainId]?.[source]
    if (!spender) throw new Error(`No spender configured for ${source} on chain ${chainId}`)
    return spender
  }

  // ── Mainnet — unchanged per-source spenders ──
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

/** Whitelisted router addresses (lowercase). Only these can receive swap transactions.
 *  [FULL-H-02] Also the source of truth for the client-side spender allowlist
 *  (src/lib/trusted-addresses.ts) — these are exactly the addresses a swap may
 *  legitimately approve as an ERC-20 spender. */
export const ROUTER_WHITELIST: Set<string> = new Set([
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
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // ParaSwap Augustus V5 (legacy)
  '0x6a000f20005980200259b80c5102003040001068', // ParaSwap Augustus V6 (Velora)
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
  chainId: number = DEFAULT_CHAIN_ID,
): { valid: boolean; reason?: string } {
  const normalized = txTo.toLowerCase()

  // [P222] Mainnet uses the existing ROUTER_WHITELIST set verbatim (byte-
  // identical behaviour). Other chains delegate to the per-chain whitelist.
  const whitelisted = chainId === DEFAULT_CHAIN_ID
    ? ROUTER_WHITELIST.has(normalized)
    : isWhitelistedRouter(normalized, chainId)
  if (whitelisted) {
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
