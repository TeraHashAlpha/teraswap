/**
 * [SEC-3, fix/log-routes-bounded-input] Bounds on what POST /api/log-quote stores and tracks.
 *
 * The route is public fire-and-forget telemetry. Before this module it stored `sourcesQueried`/`sourcesResponded` as
 * any strings in any number and turned every queried name that "did not respond" into one security_events row, which
 * the authenticated /api/monitor run then multiplied into key-value commands and operator alerts (audit 2026-11-17).
 *
 * Rules (owner answers of 2026-11-17 in docs/feedback/fix-log-routes-bounded-input.md):
 * - source names: only adapter-registry names (ADAPTER_SOURCE_NAMES), each once, at most one per registry source;
 *   anything else is dropped silently and the request answers as before.
 * - every other field has a size bound; a value past its bound or of the wrong type is dropped as if it were absent,
 *   so a dropped required field answers 400 exactly like a missing one.
 * The swap screen (lib/analytics.ts logQuoteToSupabase) sends registry names, a token symbol, an address, decimal
 * amount strings and a millisecond count, all inside these bounds: its rows are stored unchanged.
 */
import { isAdapterSourceName, registrySourceNames, type AggregatorName } from '@/lib/adapters'

/** Longest token symbol kept (catalog symbols are a few characters; 32 leaves room for long bridged names). */
export const MAX_SYMBOL_CHARS = 32
/** Longest token address / wallet kept: a 0x address is 42 characters. */
export const MAX_ADDRESS_CHARS = 64
/** Longest amount kept: uint256 has at most 78 decimal digits. */
export const MAX_AMOUNT_CHARS = 80

export interface BoundedLogQuote {
  tokenIn?: string
  tokenInSymbol?: string
  tokenOut?: string
  tokenOutSymbol?: string
  amountIn?: string | number
  sourcesQueried: AggregatorName[]
  sourcesResponded: AggregatorName[]
  bestSource?: AggregatorName
  bestAmountOut?: string | number
  allQuotes?: Partial<Record<AggregatorName, string | number>>
  responseTimeMs: number
  wallet?: string
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** A decimal amount as the client sends it: a string up to MAX_AMOUNT_CHARS, or a finite number. */
function boundedAmount(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  return boundedString(value, MAX_AMOUNT_CHARS)
}

/** `{ <registry source>: <amount> }`, nothing else: at most one entry per registry source. Not a plain object → absent. */
function boundedAllQuotes(value: unknown): Partial<Record<AggregatorName, string | number>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const kept: Array<[AggregatorName, string | number]> = []
  for (const [key, amount] of Object.entries(value)) {
    if (!isAdapterSourceName(key)) continue
    const bounded = boundedAmount(amount)
    if (bounded !== undefined) kept.push([key, bounded])
  }
  // Object.fromEntries defines own properties: a key can never reach a prototype (and only registry names get here).
  return Object.fromEntries(kept) as Partial<Record<AggregatorName, string | number>>
}

/** The fields of a parsed /api/log-quote body, each within its bound; see the module doc. */
export function boundLogQuoteBody(body: Record<string, unknown>): BoundedLogQuote {
  const bestSource = isAdapterSourceName(body.bestSource) ? body.bestSource : undefined
  const responseTimeMs = typeof body.responseTimeMs === 'number' && Number.isFinite(body.responseTimeMs) ? body.responseTimeMs : 0
  return {
    tokenIn: boundedString(body.tokenIn, MAX_ADDRESS_CHARS),
    tokenInSymbol: boundedString(body.tokenInSymbol, MAX_SYMBOL_CHARS),
    tokenOut: boundedString(body.tokenOut, MAX_ADDRESS_CHARS),
    tokenOutSymbol: boundedString(body.tokenOutSymbol, MAX_SYMBOL_CHARS),
    amountIn: boundedAmount(body.amountIn),
    sourcesQueried: registrySourceNames(body.sourcesQueried),
    sourcesResponded: registrySourceNames(body.sourcesResponded),
    bestSource,
    bestAmountOut: boundedAmount(body.bestAmountOut),
    allQuotes: boundedAllQuotes(body.allQuotes),
    responseTimeMs,
    wallet: boundedString(body.wallet, MAX_ADDRESS_CHARS),
  }
}
