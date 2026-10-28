'use client'

import { useEffect, useMemo } from 'react'
import { DEFAULT_TOKENS, CATEGORY_DISPLAY_ORDER, isNativeETH, type Token } from '@/lib/tokens'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import { useImportedTokens } from '@/hooks/useImportedTokens'
import { useQuoteChainId } from '@/hooks/useChainId'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { getChainTokenList, getFullCatalog, getPopularTokens, getSearchCatalog, rankSearchMatches, computeLowLiquidityDemotions, SEARCH_RESULT_LIMIT } from '@/lib/chains/tokens'

/** v1's quick-select symbols on mainnet (TokenSelector.tsx). */
const POPULAR_SYMBOLS = ['ETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'WETH', 'LINK', 'UNI']
const EMPTY_TOKENS: Token[] = []

export interface TokenListOptions {
  disabledAddress?: string
  hideNativeInput?: boolean
  search: string
  activeCategory: string | null
}

/**
 * The token selector's DATA, derived exactly as v1's TokenSelector derives it (same catalog per chain, same imported-token merge,
 * same search catalog + ranking + low-liquidity demotion, same balances-first ordering, same popular set) — only the chrome is v2's.
 * token-sheet.test.tsx renders v1's selector and the sheet over the same mocks and compares the rows.
 */
export function useTokenList({ disabledAddress, hideNativeInput = false, search, activeCategory }: TokenListOptions) {
  const activeChainId = useQuoteChainId()
  const isMainnet = activeChainId === DEFAULT_CHAIN_ID
  const { balances: balanceMap } = useTokenBalances()
  const { tokens: importedTokens, remove: removeImported, revalidate: revalidateImported } = useImportedTokens(activeChainId)

  const catalog = useMemo(() => {
    const base = [...(isMainnet ? DEFAULT_TOKENS : getChainTokenList(activeChainId)), ...importedTokens]
    return hideNativeInput ? base.filter((t) => !isNativeETH(t)) : base
  }, [isMainnet, activeChainId, hideNativeInput, importedTokens])

  const importedAddrs = useMemo(() => new Set(importedTokens.map((t) => t.address.toLowerCase())), [importedTokens])
  const catalogSymbols = useMemo(() => new Set(getFullCatalog(activeChainId).map((t) => t.symbol.toLowerCase())), [activeChainId])

  const availableCategories = useMemo(() => {
    const present = new Set<string>()
    for (const token of catalog) present.add(token.category || 'Other')
    return CATEGORY_DISPLAY_ORDER.filter((cat) => present.has(cat))
  }, [catalog])

  // v1 re-validates saved imports once per token per page load, when the picker opens.
  useEffect(() => {
    void revalidateImported()
  }, [revalidateImported])

  const isSearching = search.length > 0
  const q = search.toLowerCase()
  const isAddressSearch = /^0x[a-fA-F0-9]{40}$/.test(search.trim())

  const filtered = useMemo(() => {
    if (!isSearching) return [] as Token[]
    const disabled = disabledAddress?.toLowerCase()
    const matches = getSearchCatalog(activeChainId).filter(
      (t) =>
        t.address.toLowerCase() !== disabled &&
        !(hideNativeInput && isNativeETH(t)) &&
        (activeCategory === null || (t.category || 'Other') === activeCategory) &&
        (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)),
    )
    return rankSearchMatches(matches, q).slice(0, SEARCH_RESULT_LIMIT)
    // `importedTokens` is the change signal: getSearchCatalog reads the (non-reactive) custom-token store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearching, q, disabledAddress, activeChainId, activeCategory, hideNativeInput, importedTokens])

  const lowLiquiditySet = useMemo(() => computeLowLiquidityDemotions(filtered), [filtered])
  const normalMatches = lowLiquiditySet.size === 0 ? filtered : filtered.filter((t) => !lowLiquiditySet.has(t))
  const lowLiquidityMatches = lowLiquiditySet.size === 0 ? EMPTY_TOKENS : filtered.filter((t) => lowLiquiditySet.has(t))

  const tokensWithBalance = useMemo(() => {
    const disabled = disabledAddress?.toLowerCase()
    return catalog
      .filter((t) => {
        const addr = t.address.toLowerCase()
        if (activeCategory !== null && (t.category || 'Other') !== activeCategory) return false
        return addr !== disabled && balanceMap.has(addr)
      })
      .sort((a, b) => {
        const balA = balanceMap.get(a.address.toLowerCase())?.raw ?? 0n
        const balB = balanceMap.get(b.address.toLowerCase())?.raw ?? 0n
        if (balB > balA) return 1
        if (balA > balB) return -1
        return 0
      })
  }, [disabledAddress, balanceMap, catalog, activeCategory])

  const groups = useMemo(() => {
    if (isSearching) return null
    const disabled = disabledAddress?.toLowerCase()
    const balanceAddrs = new Set(tokensWithBalance.map((t) => t.address.toLowerCase()))
    const categoryMap = new Map<string, Token[]>()
    for (const token of catalog) {
      const addr = token.address.toLowerCase()
      if (addr === disabled || balanceAddrs.has(addr)) continue
      const cat = token.category || 'Other'
      if (activeCategory !== null && cat !== activeCategory) continue
      if (!categoryMap.has(cat)) categoryMap.set(cat, [])
      categoryMap.get(cat)!.push(token)
    }
    return CATEGORY_DISPLAY_ORDER.filter((cat) => categoryMap.has(cat)).map((cat) => ({ label: cat, tokens: categoryMap.get(cat)! }))
  }, [disabledAddress, isSearching, tokensWithBalance, catalog, activeCategory])

  const popularTokens = useMemo(() => {
    const disabled = disabledAddress?.toLowerCase()
    if (!isMainnet) {
      const popularAddrs = new Set(getPopularTokens(activeChainId).map((t) => t.address.toLowerCase()))
      return catalog.filter((t) => popularAddrs.has(t.address.toLowerCase()) && t.address.toLowerCase() !== disabled)
    }
    return POPULAR_SYMBOLS.map((sym) =>
      DEFAULT_TOKENS.find((t) => t.symbol === sym && t.address.toLowerCase() !== disabled && !(hideNativeInput && isNativeETH(t))),
    ).filter(Boolean) as Token[]
  }, [disabledAddress, isMainnet, activeChainId, catalog, hideNativeInput])

  return {
    chainId: activeChainId,
    balanceMap,
    importedAddrs,
    catalogSymbols,
    removeImported,
    availableCategories,
    isSearching,
    isAddressSearch,
    filtered,
    normalMatches,
    lowLiquidityMatches,
    tokensWithBalance,
    groups,
    popularTokens,
    resultLimit: SEARCH_RESULT_LIMIT,
  }
}
