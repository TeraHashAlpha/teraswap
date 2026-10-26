'use client'

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  getCustomTokens,
  getCustomTokensVersion,
  hydrateCustomTokens,
  removeCustomToken,
  setCustomTokenUnavailable,
  subscribeCustomTokens,
  type Token,
} from '@/lib/tokens'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { probeImportedToken } from '@/hooks/useTokenImport'

/** `${chainId}:${addr}` of imports probed this page-load, so two selectors / reopens don't re-probe. */
const probedThisSession = new Set<string>()

/**
 * [fix/imported-tokens-persist] Lazily re-check this chain's saved imports over the chain-scoped
 * RPC path. A token the chain no longer answers for (contract gone / not ERC-20 / decimals changed)
 * is KEPT and flagged unavailable — never dropped; the user decides via Remove. An unreadable
 * answer (transport / proxy failure) says nothing about the token, so it neither flags the token
 * nor counts as probed — the next open retries.
 */
export async function revalidateImportedTokens(chainId: number): Promise<void> {
  const targets = getCustomTokens().filter(
    (t) => (t.chainId ?? DEFAULT_CHAIN_ID) === chainId && !probedThisSession.has(`${chainId}:${t.address.toLowerCase()}`),
  )
  await Promise.all(
    targets.map(async (t) => {
      const key = `${chainId}:${t.address.toLowerCase()}`
      probedThisSession.add(key)
      const status = await probeImportedToken(chainId, t.address, t.decimals)
      if (status === 'unreadable') probedThisSession.delete(key)
      else setCustomTokenUnavailable(t.address, chainId, status === 'invalid')
    }),
  )
}

/**
 * The user's imports for `chainId`, hydrated from localStorage on mount.
 */
export function useImportedTokens(chainId: number) {
  const version = useSyncExternalStore(subscribeCustomTokens, getCustomTokensVersion, () => 0)

  useEffect(() => {
    hydrateCustomTokens(chainId)
  }, [chainId])

  const tokens = useMemo((): Token[] => {
    return getCustomTokens().filter((t) => (t.chainId ?? DEFAULT_CHAIN_ID) === chainId)
    // `version` is the change signal for the module-level store behind getCustomTokens().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, version])

  const remove = useCallback((address: string) => removeCustomToken(address, chainId), [chainId])
  const revalidate = useCallback(() => revalidateImportedTokens(chainId), [chainId])

  return { tokens, remove, revalidate }
}
