/**
 * [SPRINT-9C] Per-chain Uniswap V3 core contract addresses.
 *
 * chainId 1 REFERENCES the canonical mainnet constants (UNISWAP_QUOTER_V2 /
 * UNISWAP_SWAP_ROUTER_02) so the mainnet quote/swap path stays byte-identical —
 * it never redefines them. Base addresses were verified, May 2026, against BOTH
 * Basescan name tags AND developers.uniswap.org base-deployments, mirroring the
 * verification discipline in `chains/routers.ts`.
 *
 * The current uniswapv3 adapter quotes via QuoterV2 directly (no Factory call),
 * so `factory` is reference-only — kept for completeness and future pool/TWAP
 * work, and to make the per-chain deployment self-documenting.
 */
import { UNISWAP_QUOTER_V2, UNISWAP_SWAP_ROUTER_02 } from '@/lib/constants'

export interface UniswapV3Contracts {
  quoterV2: `0x${string}`
  /** V3 core factory — reference only (the quote path uses QuoterV2 directly). */
  factory: `0x${string}`
  swapRouter02: `0x${string}`
}

const UNISWAP_V3_BY_CHAIN: Record<number, UniswapV3Contracts> = {
  // Ethereum mainnet — canonical constants (do NOT inline; preserves byte-identical mainnet).
  1: {
    quoterV2: UNISWAP_QUOTER_V2,
    // UniswapV3Factory (mainnet) — Etherscan: "Uniswap V3: Factory".
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter02: UNISWAP_SWAP_ROUTER_02,
  },
  // Base (8453) — verified on Basescan + developers.uniswap.org base-deployments (May 2026):
  8453: {
    // Basescan: "Uniswap V3: QuoterV2"
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    // Basescan: "Uniswap V3: Pool Factory" (reference only — quote path uses QuoterV2)
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    // Basescan: "Uniswap V3: Swap Router02" (also whitelisted in chains/routers.ts)
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
  },
  // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum One (42161) — CORRECTED from the Sprint-46 recon
  // values, all three of which resolved to EMPTY on-chain code (no contract deployed) or, for
  // swapRouter02, the wrong contract entirely (the original V1 SwapRouter, not SwapRouter02 — see
  // docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md for the full method + evidence). All three
  // corrected values are confirmed via eth_getCode against the public Arbitrum RPC and are the SAME
  // addresses as the mainnet deployment (Arbitrum was part of Uniswap's original synchronized
  // multi-chain deploy; only Base has its own distinct addresses). Inert while
  // contracts.feeCollector is null (dark launch).
  42161: {
    quoterV2: UNISWAP_QUOTER_V2, // same address as mainnet, confirmed deployed on Arbitrum
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', // same address as mainnet, confirmed deployed
    swapRouter02: UNISWAP_SWAP_ROUTER_02, // same address as mainnet, confirmed deployed (48,996 B)
  },
}

/** Resolve the Uniswap V3 contracts for a chain, or `null` if V3 isn't configured there. */
export function getUniswapV3Contracts(chainId: number): UniswapV3Contracts | null {
  return UNISWAP_V3_BY_CHAIN[chainId] ?? null
}
