'use client'

import { useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { useDisconnectedChainSelection, useQuoteChainId } from '@/hooks/useChainId'

/**
 * [ADR-025] The SELECTED chain for the shell and a way to change it — the exact semantics of v1's ChainSelector:
 * connected → wagmi `switchChain`; disconnected → the shared `useDisconnectedChainSelection` store (which is also
 * what `useQuoteChainId` reads, so quoting, the footer block and this menu agree on one chain).
 */
export function useShellChain() {
  const chainId = useQuoteChainId()
  const { isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const setDisconnectedChainId = useDisconnectedChainSelection((s) => s.setChainId)

  const select = useCallback(
    (next: number) => {
      if (isPending || next === chainId) return
      if (isConnected) switchChain({ chainId: next })
      else setDisconnectedChainId(next)
    },
    [chainId, isConnected, isPending, switchChain, setDisconnectedChainId],
  )

  return { chainId, select, isPending }
}
