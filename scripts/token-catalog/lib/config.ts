/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Pipeline configuration — the documented knobs.
 *
 * - minSources (2): distinct sources that must agree on the SAME (chainId, EIP-55 address).
 * - lowLiqMinSources (3): agreement floor when the market signal is weak/unknown —
 *   low-liquidity = 24h volume below liquidityFloorUsd AND no DefiLlama price with
 *   confidence >= defillamaConfidenceMin. No market data at all counts as low-liquidity.
 * - requiredSourceForNew ('coingecko'): NEW tokens must be in CoinGecko's per-chain list —
 *   the SAME list the catalog-address-guard trusted-list gate reads, so additions can never
 *   immediately red that gate.
 * - maxNewTokensPerChain: growth cap for NEW (non-seed, non-core) tokens, highest-volume
 *   first. Overflow is reported (no silent caps).
 * - CORE_TOKENS: fee/routing-critical allowlist — ALWAYS included, still on-chain-validated
 *   (a core failing on-chain validation FAILS the build; a source outage can never drop one).
 *   Addresses are copied from the pinned majors fixtures in src/lib/chains/token-catalog.test.ts
 *   (themselves sourced from the pinned Uniswap snapshot) — NEVER hand-typed.
 *
 * RPC endpoints reuse the guard's env overrides: GUARD_RPC_1 / GUARD_RPC_8453.
 */
import type { CoreToken, PipelineConfig } from './types'

export const PIPELINE_CONFIG: PipelineConfig = {
  chains: [1, 8453],
  minSources: 2,
  lowLiqMinSources: 3,
  liquidityFloorUsd: 100_000,
  defillamaConfidenceMin: 0.9,
  maxNewTokensPerChain: { 1: 400, 8453: 250 },
  requiredSourceForNew: 'coingecko',
  sourcePriority: ['curated', 'superchain', 'uniswap', 'coingecko', 'oneinch', 'trustwallet', 'defillama'],
}

/** Native ETH sentinel (matches src/lib/constants NATIVE_ETH — kept literal so the
 *  pipeline stays importable without the app alias at script time). */
export const NATIVE_ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const

export const CORE_TOKENS: Record<number, CoreToken[]> = {
  1: [
    { address: NATIVE_ETH_SENTINEL, symbol: 'ETH', name: 'Ether', decimals: 18, native: true },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8 },
  ],
  8453: [
    { address: NATIVE_ETH_SENTINEL, symbol: 'ETH', name: 'Ethereum', decimals: 18, native: true },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', name: 'USD Base Coin (Bridged)', decimals: 6 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 },
    { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18 },
    // AERO backs the fee-usd oracle fallback path on Base — routing-critical.
    { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18 },
  ],
}
