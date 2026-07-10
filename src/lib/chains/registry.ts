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
    // [Sprint 45] Env-driven activation. Base goes live for swaps only once
    // NEXT_PUBLIC_BASE_FEE_COLLECTOR holds the REAL deployed Base FeeCollector
    // address; until then this is null → isChainActive(8453) === false → the UI
    // shows "Coming Soon". Deliberately NO hardcoded fallback: a wrong default
    // would route Base swap fees to a contract that is not the FeeCollector.
    // `|| null` (not `??`) so an empty env value ("NEXT_PUBLIC_BASE_FEE_COLLECTOR="
    // in .env*) is treated as unset rather than falsely activating Base with a
    // blank address. Set the env var only after the Base mainnet deploy +
    // post-deploy checklist (docs/Runbooks/BASE-ACTIVATION.md §C).
    feeCollector: (process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR || null) as
      | `0x${string}`
      | null,
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

// [SPRINT-46-ARBITRUM-CONFIG → SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum One. Every
// address/feed/slug below is sourced from docs/Reports/ARBITRUM-READINESS.md + on-chain
// re-verification in docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md.
// `contracts.feeCollector` is now ENV-DRIVEN (the Base Sprint-44/45 pattern) rather than
// hard-null: unset ⇒ exactly today's dark behavior (isChainActive(42161) === false →
// "Coming Soon" / not offered on the chain selector, no quotes servable, no orders/DCA surface —
// order-engine's ORDER_EXECUTOR_BY_CHAIN has no 42161 entry regardless, see
// order-engine/config.test.ts). Setting NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR after a real deploy
// (docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md) is the ONLY way to flip this chain live — no
// code change required at go-live, same as Base.
const ARBITRUM: ChainConfig = {
  chainId: 42161,
  name: 'Arbitrum One',
  slug: 'arbitrum',
  nativeCurrency: {
    symbol: 'ETH',
    decimals: 18,
    // Arbitrum-native WETH (report-verified on-chain read).
    wrappedAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  contracts: {
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Env-driven, null default (Base Sprint-45 pattern).
    // `|| null` (not `??`) so an empty env value ("NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR=" in
    // .env*) is treated as unset rather than falsely activating Arbitrum with a blank address.
    // No hardcoded fallback: a wrong default would route Arbitrum swap fees to a contract that
    // is not the FeeCollector. Set only after the Arbitrum mainnet deploy + post-deploy
    // checklist (docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md).
    feeCollector: (process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR || null) as
      | `0x${string}`
      | null,
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', // same CREATE2 address as mainnet/Base
    cowVaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // cross-chain deterministic
  },
  rpc: {
    // env var name reserved; empty default keeps Arbitrum inactive until wired up (Base pattern).
    primary: process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL || '',
    fallbacks: ['https://arb1.arbitrum.io/rpc'],
  },
  blockExplorer: 'https://arbiscan.io',
  gasModel: 'arbitrum',
  // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] AUDIT-ARBITRUM-46-47 HIGH: the recon value
  // (0xFdB631f5eE196f5C5AA41F952B0282f59B2Eff9E) had ZERO on-chain code — a hand-transcribed
  // hex drift (note the matching prefix, diverging suffix vs the real feed below). Corrected via
  // scripts/verify-arbitrum-addresses.mjs — resolved from Chainlink's official reference-data
  // directory (ENS-named "l2-sequencer-uptime-status-feed" path), on-chain verified on two
  // independent Arbitrum RPCs: description() = "L2 Sequencer Uptime Status Feed", decimals() = 0,
  // latestRoundData() uptime semantics sane. See docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json.
  sequencerUptimeFeed: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D',
  tokens: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    // [CURATION] USDC NATIVE only — USDC.e (bridged, 0xFF970A61A0…B5F86) deliberately excluded
    // from v1 per the report's flag. Do not add USDC.e without an explicit Architect decision.
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] AUDIT-ARBITRUM-46-47 HIGH: recon value
    // (0xFd086b2F39B6b86fEe29f27E8f6be40e7F2E7D2b) had ZERO on-chain code. Corrected via
    // scripts/verify-arbitrum-addresses.mjs; verified on two independent RPCs (eth_getCode +
    // decimals()===6). NOTE: on-chain symbol() reads "USD₮0" — this is Tether's newer LayerZero
    // omnichain USDT standard, confirmed (via GeckoTerminal's live top-volume pools) as the
    // dominant USDT-pegged token on Arbitrum by trading volume today. The config key stays `USDT`
    // for continuity with mainnet/Base; see docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md.
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] AUDIT-ARBITRUM-46-47 HIGH: recon value
    // (0xda10009754f1dF9137293aed5d6DD0dB0Bb075e9) had ZERO on-chain code. Corrected via
    // scripts/verify-arbitrum-addresses.mjs; verified on two independent RPCs (symbol()="DAI",
    // decimals()===18), cross-referenced against 3 independent public token lists.
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] AUDIT-ARBITRUM-46-47 HIGH: recon value
    // (0x2F2a2440D2f12C0cDdE18Fe9AEf0cc0d6cF3FC30) had ZERO on-chain code. Corrected via
    // scripts/verify-arbitrum-addresses.mjs; verified on two independent RPCs (symbol()="WBTC",
    // decimals()===8), cross-referenced against 3 independent public token lists.
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },
}

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: ETHEREUM_MAINNET,
  8453: BASE,
  42161: ARBITRUM,
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

/**
 * [SPRINT-9W] Chain-aware wrapped-native (WETH) address, from each chain's registry config:
 * mainnet → 0xC02a…6Cc2 (WETH_ADDRESS), Base → 0x4200…0006. Falls back to mainnet WETH on an
 * unsupported chain so a native→wrapped mapping on the hot path never throws.
 *
 * Use this (not the global WETH_ADDRESS) whenever mapping the native-ETH sentinel to its wrapped
 * form for a PER-CHAIN request — asking a chain's API for another chain's WETH yields no quote
 * (the Base CoW MEV-protection bug this sprint fixes).
 */
export function getWrappedNative(chainId: number = DEFAULT_CHAIN_ID): `0x${string}` {
  try {
    return getChainConfig(chainId).nativeCurrency.wrappedAddress
  } catch {
    return WETH_ADDRESS
  }
}
