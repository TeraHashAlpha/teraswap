import oneinch from './oneinch'
import zerox from './zerox'
import velora from './velora'
import odos from './odos'
import kyberswap from './kyberswap'
import cow from './cow'
import uniswapv3 from './uniswapv3'
import openocean from './openocean'
import sushiswap from './sushiswap'
import balancer from './balancer'
import curve from './curve'
import bebop from './bebop'
import type { DEXAdapter, AggregatorName } from './types'

export const ADAPTER_REGISTRY: DEXAdapter[] = [
  oneinch, zerox, velora, odos, kyberswap, cow,
  uniswapv3, openocean, sushiswap, balancer, curve,
  bebop, // [ADR-010] 12th source — chain-aware (Ethereum 1 + Base 8453)
]

/**
 * [SEC-3, fix/log-routes-bounded-input] The registered adapters' names, derived from ADAPTER_REGISTRY so it cannot drift
 * from it: the only source names /api/log-quote stores and the source-health monitor reads or alerts on. Disabled
 * sources (DISABLED_SOURCES) stay in the list: they are registered adapters, and a re-enabled one needs no second edit.
 */
export const ADAPTER_SOURCE_NAMES: readonly AggregatorName[] = Object.freeze(ADAPTER_REGISTRY.map((a) => a.name))

const ADAPTER_SOURCE_NAME_SET: ReadonlySet<string> = new Set(ADAPTER_SOURCE_NAMES)

/** True only for a string that is one of ADAPTER_SOURCE_NAMES. */
export function isAdapterSourceName(value: unknown): value is AggregatorName {
  return typeof value === 'string' && ADAPTER_SOURCE_NAME_SET.has(value)
}

/**
 * The registry names in `value`, each once, in first-seen order. Anything else (a non-array, a non-string, an unknown
 * name, a repeat) is dropped. Stops reading once every registry name has been seen, so the result never holds more
 * entries than ADAPTER_SOURCE_NAMES.
 */
export function registrySourceNames(value: unknown): AggregatorName[] {
  if (!Array.isArray(value)) return []
  const kept: AggregatorName[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (kept.length === ADAPTER_SOURCE_NAMES.length) break
    if (isAdapterSourceName(entry) && !seen.has(entry)) {
      seen.add(entry)
      kept.push(entry)
    }
  }
  return kept
}

// Re-exports
export * from './types'
export * from './shared'
export { submitCowOrder, pollCowOrderStatus } from './cow'
export { detectUniswapV3FeeTier } from './uniswapv3'
export { withCircuitBreaker, getCircuitBreaker, getAllCircuitStates, resetAllCircuitBreakers, classifyFailure } from './circuit-breaker'
export type { CircuitState, CircuitBreakerConfig } from './circuit-breaker'
