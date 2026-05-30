/**
 * [P216 / ADR-009] Multi-chain configuration types.
 *
 * Every chain-specific value (RPC, contracts, Chainlink feeds, adapter URLs,
 * gas model, tokens) is resolved through a `ChainConfig` in the registry —
 * no hardcoded chain assumptions. See docs/ADR/ADR-009-multi-chain-architecture.md.
 */

export type GasModel = 'eip1559' | 'op-stack'

export interface ChainNativeCurrency {
  symbol: string
  decimals: number
  /** Wrapped-native (WETH-equivalent) address on this chain. */
  wrappedAddress: `0x${string}`
}

export interface ChainContracts {
  /** FeeCollector proxy. `null` when not yet deployed on this chain. */
  feeCollector: `0x${string}` | null
  /** Legacy FeeCollector (mainnet only) — kept for analytics continuity. */
  feeCollectorV1?: `0x${string}`
  /** Permit2 — same CREATE2 address on every chain. */
  permit2: `0x${string}`
  /** CoW Protocol VaultRelayer (when CoW is available on the chain). */
  cowVaultRelayer?: `0x${string}`
}

export interface ChainRpc {
  primary: string
  fallbacks: string[]
}

export interface ChainConfig {
  chainId: number
  name: string
  /** API path segment used by adapter URLs: 'ethereum', 'base', … */
  slug: string
  nativeCurrency: ChainNativeCurrency
  contracts: ChainContracts
  rpc: ChainRpc
  blockExplorer: string
  gasModel: GasModel
  /** L2 only — Chainlink sequencer-uptime feed. Absent on L1 (mainnet). */
  sequencerUptimeFeed?: `0x${string}`
  /** Symbol → token address map for this chain (USDC, USDT, DAI, WBTC, …). */
  tokens: Record<string, `0x${string}`>
}
