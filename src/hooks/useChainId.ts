'use client'

import { useAccount } from 'wagmi'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

/**
 * [P219] The active chain id, derived from the connected wallet.
 *
 * Falls back to DEFAULT_CHAIN_ID (1, mainnet) when no wallet is connected or
 * the wallet is on an unsupported chain — so every chain-aware consumer keeps
 * behaving exactly as the single-chain app did until the user explicitly
 * switches to another supported chain.
 */
export function useActiveChainId(): number {
  const { chain } = useAccount()
  return chain?.id ?? DEFAULT_CHAIN_ID
}
