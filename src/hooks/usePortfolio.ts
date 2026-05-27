'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useBalance, useReadContracts } from 'wagmi'
import { formatUnits, erc20Abi } from 'viem'
import { DEFAULT_TOKENS, isNativeETH, type Token } from '@/lib/tokens'
import { CHAIN_ID } from '@/lib/constants'

// ── Public surface ────────────────────────────────────────

export interface PortfolioToken {
  token: Token
  balance: bigint
  balanceFormatted: string
  priceUsd: number | null
  valueUsd: number | null
}

export interface PortfolioData {
  tokens: PortfolioToken[]
  totalValueUsd: number | null
  isLoading: boolean
  isError: boolean
  lastUpdated: Date | null
  refresh: () => void
}

const PRICES_REFRESH_MS = 60_000

// ── Internal helpers ─────────────────────────────────────

// Mirrors the formatBalance() in TokenSelector.tsx. Kept local on purpose:
// TokenSelector.tsx is explicitly out of scope for this sprint.
function formatBalance(value: bigint, decimals: number): string {
  if (value === 0n) return '0'
  const full = formatUnits(value, decimals)
  const num = parseFloat(full)
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`
  if (num >= 1) return num.toFixed(4).replace(/\.?0+$/, '')
  if (num >= 0.0001) return num.toFixed(6).replace(/\.?0+$/, '')
  return '<0.0001'
}

interface RawBalance {
  raw: bigint
  formatted: string
}

/**
 * Private hook that mirrors TokenSelector.useTokenBalances() so we don't
 * have to touch that file. Reads native ETH plus every ERC-20 in
 * DEFAULT_TOKENS via multicall, returns a Map keyed by lower-case address.
 */
function useTokenBalances(): {
  balances: Map<string, RawBalance>
  isLoading: boolean
  isError: boolean
} {
  const { address, isConnected, chain } = useAccount()
  const isCorrectChain = chain?.id === CHAIN_ID
  const enabled = isConnected && isCorrectChain && !!address

  const { data: ethBalance, isLoading: ethLoading, isError: ethError } = useBalance({
    address,
    query: { enabled, refetchInterval: 30_000 },
  })

  const erc20Tokens = useMemo(
    () => DEFAULT_TOKENS.filter((t) => !isNativeETH(t)),
    [],
  )

  const contracts = useMemo(
    () =>
      erc20Tokens.map((t) => ({
        address: t.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [address!] as const,
      })),
    [address, erc20Tokens],
  )

  const {
    data: erc20Results,
    isLoading: erc20Loading,
    isError: erc20Error,
  } = useReadContracts({
    contracts: enabled ? contracts : [],
    query: {
      enabled,
      refetchInterval: 30_000,
    },
  })

  const balances = useMemo(() => {
    const map = new Map<string, RawBalance>()
    if (ethBalance) {
      const ethToken = DEFAULT_TOKENS.find(isNativeETH)
      if (ethToken) {
        map.set(ethToken.address.toLowerCase(), {
          raw: ethBalance.value,
          formatted: formatBalance(ethBalance.value, 18),
        })
      }
    }
    if (erc20Results) {
      erc20Results.forEach((result, i) => {
        if (result.status === 'success' && result.result != null) {
          const val = result.result as bigint
          if (val > 0n) {
            map.set(erc20Tokens[i].address.toLowerCase(), {
              raw: val,
              formatted: formatBalance(val, erc20Tokens[i].decimals),
            })
          }
        }
      })
    }
    return map
  }, [ethBalance, erc20Results, erc20Tokens])

  return {
    balances,
    isLoading: enabled && (ethLoading || erc20Loading),
    isError: ethError || erc20Error,
  }
}

/**
 * usePortfolio — combines on-chain balances with USD prices fetched from
 * /api/portfolio/prices (DefiLlama under the hood, kept server-side).
 *
 * Refreshes prices on mount and every 60s. Zero-balance tokens are
 * filtered out of the returned `tokens` array. Tokens with a balance but
 * no DefiLlama price report `priceUsd: null` (not zero).
 */
export function usePortfolio(): PortfolioData {
  const { balances, isLoading: balancesLoading, isError: balancesError } = useTokenBalances()

  const [prices, setPrices] = useState<Record<string, number>>({})
  const [pricesLoading, setPricesLoading] = useState(false)
  const [pricesError, setPricesError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Tokens with non-zero balance — the input set for the price fetch.
  const heldTokens = useMemo(
    () => DEFAULT_TOKENS.filter((t) => {
      const b = balances.get(t.address.toLowerCase())
      return b && b.raw > 0n
    }),
    [balances],
  )

  // Stable key so the effect doesn't refetch on identity-only changes.
  const heldAddressesKey = useMemo(
    () => heldTokens.map((t) => t.address.toLowerCase()).sort().join(','),
    [heldTokens],
  )

  // Bumped by `refresh()` to force an immediate re-fetch.
  const [refreshCounter, setRefreshCounter] = useState(0)
  const refresh = () => setRefreshCounter((n) => n + 1)

  // Track the in-flight request so a stale resolution can't overwrite a
  // newer one (e.g. a manual refresh while the interval fetch is pending).
  const fetchIdRef = useRef(0)

  useEffect(() => {
    if (heldTokens.length === 0) {
      setPrices({})
      setPricesError(false)
      setPricesLoading(false)
      return
    }

    let cancelled = false
    const myFetchId = ++fetchIdRef.current

    const fetchPrices = async () => {
      setPricesLoading(true)
      try {
        const url = `/api/portfolio/prices?tokens=${encodeURIComponent(heldAddressesKey)}`
        const res = await fetch(url)
        if (!res.ok) {
          if (!cancelled && fetchIdRef.current === myFetchId) {
            setPricesError(true)
            setPricesLoading(false)
          }
          return
        }
        const data = (await res.json()) as { prices?: Record<string, number> }
        if (cancelled || fetchIdRef.current !== myFetchId) return
        setPrices(data.prices ?? {})
        setPricesError(false)
        setLastUpdated(new Date())
      } catch {
        if (!cancelled && fetchIdRef.current === myFetchId) setPricesError(true)
      } finally {
        if (!cancelled && fetchIdRef.current === myFetchId) setPricesLoading(false)
      }
    }

    fetchPrices()
    const interval = setInterval(fetchPrices, PRICES_REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [heldAddressesKey, heldTokens.length, refreshCounter])

  const tokens = useMemo<PortfolioToken[]>(() => {
    const enriched: PortfolioToken[] = heldTokens.map((token) => {
      const bal = balances.get(token.address.toLowerCase())
      const raw = bal?.raw ?? 0n
      const priceUsd = prices[token.address.toLowerCase()] ?? null
      // human-readable amount × price. Computed with floats — these values
      // are for display only, never for on-chain math.
      const amount = parseFloat(formatUnits(raw, token.decimals))
      const valueUsd = priceUsd !== null ? amount * priceUsd : null
      return {
        token,
        balance: raw,
        balanceFormatted: bal?.formatted ?? '0',
        priceUsd,
        valueUsd,
      }
    })

    // Sort: known USD values (descending) first, then unknown-price tokens
    // sorted by symbol for a stable visual ordering.
    enriched.sort((a, b) => {
      if (a.valueUsd !== null && b.valueUsd !== null) return b.valueUsd - a.valueUsd
      if (a.valueUsd !== null) return -1
      if (b.valueUsd !== null) return 1
      return a.token.symbol.localeCompare(b.token.symbol)
    })

    return enriched
  }, [heldTokens, balances, prices])

  const totalValueUsd = useMemo(() => {
    const known = tokens.filter((t) => t.valueUsd !== null)
    if (known.length === 0) return null
    return known.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
  }, [tokens])

  return {
    tokens,
    totalValueUsd,
    isLoading: balancesLoading || pricesLoading,
    isError: balancesError || pricesError,
    lastUpdated,
    refresh,
  }
}
