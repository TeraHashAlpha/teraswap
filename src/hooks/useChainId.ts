'use client'

import { create } from 'zustand'
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
 * [feat/quote-before-wallet] The chain a DISCONNECTED visitor picked in
 * ChainSelector. Wagmi has no `chain` to report without a wallet, so this
 * tiny store is the only place that memory lives — written by ChainSelector,
 * read by useQuoteChainId below. Global/shared (not per-component state) so
 * the selector and the quote path agree on the same chain.
 */
interface DisconnectedChainSelection {
  chainId: number | null
  setChainId: (chainId: number | null) => void
}

export const useDisconnectedChainSelection = create<DisconnectedChainSelection>((set) => ({
  chainId: null,
  setChainId: (chainId) => set({ chainId }),
}))

/**
 * [feat/quote-before-wallet] Chain id for the QUOTE/browse path only. A quote
 * is a read, not an account action — it should reflect whatever chain a
 * disconnected visitor is looking at, not silently assume mainnet the way
 * useActiveChainId's fallback does for its ~15 wallet-action consumers
 * (balances, approvals, swap execution, portfolio — all correctly mainnet-
 * biased while there's no wallet to act with).
 *
 * Deliberately a SEPARATE hook from useActiveChainId, same reasoning as
 * useResolvedChainId below: changing the shared fallback would silently
 * change balances/approvals/portfolio behavior for every disconnected
 * visitor, which is out of scope for a quote-before-wallet change.
 */
export function useQuoteChainId(): number {
  const { chain, isConnected } = useAccount()
  const disconnectedChainId = useDisconnectedChainSelection((s) => s.chainId)
  if (isConnected) return chain?.id ?? DEFAULT_CHAIN_ID
  return disconnectedChainId ?? DEFAULT_CHAIN_ID
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
