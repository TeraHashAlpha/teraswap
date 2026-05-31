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
import type { DEXAdapter } from './types'

export const ADAPTER_REGISTRY: DEXAdapter[] = [
  oneinch, zerox, velora, odos, kyberswap, cow,
  uniswapv3, openocean, sushiswap, balancer, curve,
  bebop, // [ADR-010] 12th source — chain-aware (Ethereum 1 + Base 8453)
]

// Re-exports
export * from './types'
export * from './shared'
export { submitCowOrder, pollCowOrderStatus } from './cow'
export { detectUniswapV3FeeTier } from './uniswapv3'
export { withCircuitBreaker, getCircuitBreaker, getAllCircuitStates, resetAllCircuitBreakers } from './circuit-breaker'
export type { CircuitState, CircuitBreakerConfig } from './circuit-breaker'
