/**
 * [P216 / ADR-009] Chain configuration registry.
 *
 * The mainnet (chainId 1) config REFERENCES the canonical values already
 * defined in `constants.ts` — it does not redefine them. This guarantees the
 * registry can never drift from the live mainnet constants (and avoids
 * relocating env-var-derived values like FEE_COLLECTOR_ADDRESS, which would
 * risk a behavioural change). `constants.ts` stays the source of truth for
 * chain 1; the registry adds the multi-chain layer on top. See FEEDBACK.md.
 *
 * NOTE: this module imports FROM constants.ts (one-way). constants.ts must NOT
 * import from here, to keep the dependency acyclic.
 */
import {
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_V1_ADDRESS,
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  WETH_ADDRESS,
} from '../constants'
import type { ChainConfig } from './types'

/** Mainnet default — preserves the existing `CHAIN_ID = 1` assumption. */
export const DEFAULT_CHAIN_ID = 1

const ETHEREUM_MAINNET: ChainConfig = {
  chainId: 1,
  name: 'Ethereum',
  slug: 'ethereum',
  nativeCurrency: {
    symbol: 'ETH',
    decimals: 18,
    wrappedAddress: WETH_ADDRESS,
  },
  contracts: {
    feeCollector: FEE_COLLECTOR_ADDRESS,
    feeCollectorV1: FEE_COLLECTOR_V1_ADDRESS,
    permit2: PERMIT2_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER,
  },
  rpc: {
    primary: process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com',
    fallbacks: ['https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
  },
  blockExplorer: 'https://etherscan.io',
  gasModel: 'eip1559',
  // No sequencerUptimeFeed — mainnet is an L1.
  tokens: {
    WETH: WETH_ADDRESS,
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
}

const BASE: ChainConfig = {
  chainId: 8453,
  name: 'Base',
  slug: 'base',
  nativeCurrency: {
    symbol: 'ETH',
    decimals: 18,
    wrappedAddress: '0x4200000000000000000000000000000000000006',
  },
  contracts: {
    feeCollector: null, // not deployed yet — swaps show "Coming Soon"
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', // same CREATE2 address as mainnet
    cowVaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  },
  rpc: {
    // env var name reserved; empty default keeps Base inactive until wired up.
    primary: process.env.NEXT_PUBLIC_BASE_RPC_URL || '',
    fallbacks: ['https://mainnet.base.org'],
  },
  blockExplorer: 'https://basescan.org',
  gasModel: 'op-stack',
  sequencerUptimeFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
  tokens: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    WETH: '0x4200000000000000000000000000000000000006',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  },
}

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: ETHEREUM_MAINNET,
  8453: BASE,
}

/** Resolve a chain config. Throws on an unsupported chain. */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAIN_CONFIGS[chainId]
  if (!config) throw new Error(`Unsupported chain: ${chainId}`)
  return config
}

export function getSupportedChainIds(): number[] {
  return Object.keys(CHAIN_CONFIGS).map(Number)
}
