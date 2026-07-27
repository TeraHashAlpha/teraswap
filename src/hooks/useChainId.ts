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

/**
 * [FIX-ORACLE-FAIL-CLOSED] The active chain id with NO fallback — `undefined` means "we do not know
 * which chain this is" (wallet disconnected, still connecting, or on an unsupported chain).
 *
 * Why this exists alongside useActiveChainId: the `?? DEFAULT_CHAIN_ID` fallback above is a sensible
 * default for display-ish consumers (explorer links, token lists, balances), but it is actively
 * unsafe for a SECURITY GATE. A safety check that silently assumes mainnet during a transient will
 * resolve mainnet's feed registry, find no exchange-rate pair there (only Base has one today), and
 * report a confident "nothing to worry about" — the guard disappears without a trace precisely when
 * the chain is in flux. A gate must know which chain it is guarding, or admit that it does not.
 *
 * Deliberately a SEPARATE hook rather than a change to useActiveChainId: ~15 unrelated consumers
 * depend on the numeric fallback and are out of scope here. Only oracle-safety callers should use
 * this one, and they must treat `undefined` as unverified — never as "assume mainnet".
 */
export function useResolvedChainId(): number | undefined {
  const { chain } = useAccount()
  return chain?.id
}
