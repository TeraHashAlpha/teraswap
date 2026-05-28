'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useBalance, useReadContracts } from 'wagmi'
import { formatUnits, erc20Abi } from 'viem'
import { DEFAULT_TOKENS, isNativeETH, type Token, type TokenCategory } from '@/lib/tokens'
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
const DISCOVERY_REFRESH_MS = 60_000
const PRICES_BATCH_SIZE = 100 // Mirrors the cap in /api/portfolio/prices

/**
 * [P193] After this many consecutive non-503 discovery failures
 * (502 Bad Gateway, 500, 429, network errors, ...), `useDiscoveredTokens`
 * flips `isAvailable` to false so usePortfolio() falls back to the
 * multicall path. Any subsequent successful response resets the counter
 * and re-enables the Alchemy path on the next tick.
 */
export const MAX_DISCOVERY_FAILURES = 2

// Shape returned by /api/portfolio/tokens — kept local to avoid pulling
// in the route module just for a type.
interface DiscoveredToken {
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI: string | null
  balance: string
  isDefault: boolean
}

// ── Internal helpers ─────────────────────────────────────

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

const DEFAULT_BY_ADDRESS = (() => {
  const m = new Map<string, Token>()
  for (const t of DEFAULT_TOKENS) m.set(t.address.toLowerCase(), t)
  return m
})()

function logo1inch(address: string): string {
  return `https://tokens.1inch.io/${address.toLowerCase()}.png`
}

interface RawBalance {
  raw: bigint
  formatted: string
}

// ── Fallback hook: DEFAULT_TOKENS multicall ──────────────
//
// Kept as the safety net for environments where ALCHEMY_API_KEY is
// unset. When discovery is available, we explicitly disable the wagmi
// hooks so RPC quota isn't wasted on a 80-call multicall we won't read.

function useTokenBalances(enabled: boolean): {
  balances: Map<string, RawBalance>
  isLoading: boolean
  isError: boolean
} {
  const { address, isConnected, chain } = useAccount()
  const isCorrectChain = chain?.id === CHAIN_ID
  const wagmiEnabled = enabled && isConnected && isCorrectChain && !!address

  const { data: ethBalance, isLoading: ethLoading, isError: ethError } = useBalance({
    address,
    query: { enabled: wagmiEnabled, refetchInterval: 30_000 },
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
    contracts: wagmiEnabled ? contracts : [],
    query: {
      enabled: wagmiEnabled,
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
    isLoading: wagmiEnabled && (ethLoading || erc20Loading),
    isError: ethError || erc20Error,
  }
}

// ── Primary path: Alchemy token discovery ────────────────
//
// Fetches /api/portfolio/tokens which wraps Alchemy's
// alchemy_getTokenBalances. A 503 response means ALCHEMY_API_KEY is
// unset on the server — we surface isAvailable=false so usePortfolio()
// can switch to the multicall fallback for this render.

function useDiscoveredTokens(address: string | undefined): {
  tokens: DiscoveredToken[]
  isLoading: boolean
  isError: boolean
  isAvailable: boolean
  refreshCounter: number
  bump: () => void
} {
  const [tokens, setTokens] = useState<DiscoveredToken[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const [isAvailable, setIsAvailable] = useState(true)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const fetchIdRef = useRef(0)
  const failCountRef = useRef(0)

  const bump = () => setRefreshCounter((n) => n + 1)

  useEffect(() => {
    if (!address) {
      setTokens([])
      setIsAvailable(true)
      setIsLoading(false)
      setIsError(false)
      return
    }

    let cancelled = false
    const myFetchId = ++fetchIdRef.current

    const fetchDiscovery = async () => {
      setIsLoading(true)
      try {
        const res = await fetch(`/api/portfolio/tokens?address=${encodeURIComponent(address)}`)
        if (cancelled || fetchIdRef.current !== myFetchId) return
        if (res.status === 503) {
          // Discovery not configured server-side — falls through to the
          // multicall path in usePortfolio.
          failCountRef.current = 0
          setIsAvailable(false)
          setTokens([])
          setIsError(false)
          return
        }
        if (!res.ok) {
          failCountRef.current += 1
          if (failCountRef.current >= MAX_DISCOVERY_FAILURES) {
            console.warn(
              '[useDiscoveredTokens] Discovery failed %d times consecutively, falling back to multicall',
              failCountRef.current,
            )
            setIsAvailable(false)
            setIsError(false)
          } else {
            setIsError(true)
            setIsAvailable(true)
          }
          return
        }
        const data = (await res.json()) as { tokens?: DiscoveredToken[] }
        failCountRef.current = 0
        setTokens(data.tokens ?? [])
        setIsAvailable(true)
        setIsError(false)
      } catch {
        if (!cancelled && fetchIdRef.current === myFetchId) {
          failCountRef.current += 1
          if (failCountRef.current >= MAX_DISCOVERY_FAILURES) {
            console.warn(
              '[useDiscoveredTokens] Discovery failed %d times consecutively, falling back to multicall',
              failCountRef.current,
            )
            setIsAvailable(false)
            setIsError(false)
          } else {
            setIsError(true)
            setIsAvailable(true)
          }
        }
      } finally {
        if (!cancelled && fetchIdRef.current === myFetchId) {
          setIsLoading(false)
        }
      }
    }

    fetchDiscovery()
    const interval = setInterval(fetchDiscovery, DISCOVERY_REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [address, refreshCounter])

  return { tokens, isLoading, isError, isAvailable, refreshCounter, bump }
}

// Build a price-fetch URL from an arbitrary slice of token addresses.
// Used both by the Alchemy path (potentially >100 addresses) and by the
// fallback path. The /api/portfolio/prices route caps at 100 addresses
// per call, so we chunk; results merge into one record.
async function fetchPricesBatched(
  addresses: string[],
): Promise<Record<string, number>> {
  if (addresses.length === 0) return {}
  const out: Record<string, number> = {}
  for (let i = 0; i < addresses.length; i += PRICES_BATCH_SIZE) {
    const batch = addresses.slice(i, i + PRICES_BATCH_SIZE)
    const res = await fetch(
      `/api/portfolio/prices?tokens=${encodeURIComponent(batch.join(','))}`,
    )
    if (!res.ok) {
      // Surface the first batch failure as an exception so the caller
      // marks isError=true. Partial results from earlier batches are
      // discarded — we'd rather render nothing than half-priced data.
      throw new Error(`prices batch failed: ${res.status}`)
    }
    const data = (await res.json()) as { prices?: Record<string, number> }
    Object.assign(out, data.prices ?? {})
  }
  return out
}

// ── Main hook ────────────────────────────────────────────

/**
 * usePortfolio — combines on-chain balances with USD prices.
 *
 * Primary path: Alchemy discovery (server-side /api/portfolio/tokens),
 * which returns every ERC-20 the wallet holds with curated metadata
 * for DEFAULT_TOKENS and Alchemy-resolved metadata for everything else.
 *
 * Fallback path: DEFAULT_TOKENS multicall. Triggered when discovery
 * returns 503 (no ALCHEMY_API_KEY configured). Identical to the
 * original Sprint 31 behaviour.
 *
 * Zero-balance tokens are filtered upstream by the discovery route or
 * by the multicall result-filter. Prices come from /api/portfolio/prices,
 * batched at 100 addresses per request.
 */
export function usePortfolio(): PortfolioData {
  const { address } = useAccount()

  const discovery = useDiscoveredTokens(address)
  const useAlchemyPath = discovery.isAvailable

  // The wagmi multicall hooks must NOT fire when Alchemy is doing its
  // job — they'd burn a 79-call multicall every 30s that we'd throw away.
  const {
    balances: multicallBalances,
    isLoading: multicallLoading,
    isError: multicallError,
  } = useTokenBalances(!useAlchemyPath)

  // [P195] Native ETH balance for the Alchemy path. alchemy_getTokenBalances
  // only returns ERC-20 entries, so without this useBalance() the user's ETH
  // balance is invisible when discovery is active. Enabled ONLY when the
  // Alchemy path is selected; the multicall path already covers ETH via
  // useTokenBalances() — keeping both gated avoids double-counting and
  // wasted RPC.
  const { data: nativeEthBalance } = useBalance({
    address,
    query: { enabled: useAlchemyPath && !!address, refetchInterval: 30_000 },
  })

  // ── Step 1: assemble the held-token set + balances ────
  //
  // Each path produces the same "raw shape" for the next step:
  //   Array<{ token: Token, balance: bigint, balanceFormatted: string }>
  //
  // Alchemy path: derive Token from DEFAULT_TOKENS when possible
  // (curated logos), otherwise from the Alchemy metadata. Balance is
  // already parsed as a decimal string by the API.
  //
  // Fallback path: walk DEFAULT_TOKENS, look up each by lowercase
  // address in the multicall map, keep the ones with non-zero balance.

  interface HeldEntry {
    token: Token
    balance: bigint
    balanceFormatted: string
  }

  const heldEntries = useMemo<HeldEntry[]>(() => {
    if (useAlchemyPath) {
      const out: HeldEntry[] = []
      // [P195] Prepend native ETH so it shows at the top of the list;
      // alchemy_getTokenBalances never returns it.
      if (nativeEthBalance && nativeEthBalance.value > 0n) {
        const ethToken = DEFAULT_TOKENS.find(isNativeETH)
        if (ethToken) {
          out.push({
            token: ethToken,
            balance: nativeEthBalance.value,
            balanceFormatted: formatBalance(nativeEthBalance.value, 18),
          })
        }
      }
      for (const d of discovery.tokens) {
        let raw: bigint
        try {
          raw = BigInt(d.balance)
        } catch {
          continue
        }
        if (raw <= 0n) continue
        const lower = d.address.toLowerCase()
        const curated = DEFAULT_BY_ADDRESS.get(lower)
        const token: Token = curated ?? {
          address: d.address as `0x${string}`,
          symbol: d.symbol,
          name: d.name,
          decimals: d.decimals,
          logoURI: d.logoURI || logo1inch(d.address),
          category: 'Other' as TokenCategory,
        }
        out.push({
          token,
          balance: raw,
          balanceFormatted: formatBalance(raw, token.decimals),
        })
      }
      return out
    }
    // Fallback: walk DEFAULT_TOKENS and pick up non-zero entries.
    const out: HeldEntry[] = []
    for (const token of DEFAULT_TOKENS) {
      const bal = multicallBalances.get(token.address.toLowerCase())
      if (bal && bal.raw > 0n) {
        out.push({ token, balance: bal.raw, balanceFormatted: bal.formatted })
      }
    }
    return out
  }, [useAlchemyPath, discovery.tokens, multicallBalances, nativeEthBalance])

  // ── Step 2: fetch USD prices ───────────────────────────
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [pricesLoading, setPricesLoading] = useState(false)
  const [pricesError, setPricesError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const heldAddressesKey = useMemo(
    () => heldEntries.map((e) => e.token.address.toLowerCase()).sort().join(','),
    [heldEntries],
  )

  const [refreshCounter, setRefreshCounter] = useState(0)
  const refresh = () => {
    setRefreshCounter((n) => n + 1)
    discovery.bump()
  }
  const fetchIdRef = useRef(0)

  useEffect(() => {
    if (heldEntries.length === 0) {
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
        const addresses = heldAddressesKey ? heldAddressesKey.split(',') : []
        const merged = await fetchPricesBatched(addresses)
        if (cancelled || fetchIdRef.current !== myFetchId) return
        setPrices(merged)
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
  }, [heldAddressesKey, heldEntries.length, refreshCounter])

  // ── Step 3: enrich + sort ──────────────────────────────
  const tokens = useMemo<PortfolioToken[]>(() => {
    const enriched: PortfolioToken[] = heldEntries.map((entry) => {
      const priceUsd = prices[entry.token.address.toLowerCase()] ?? null
      const amount = parseFloat(formatUnits(entry.balance, entry.token.decimals))
      const valueUsd = priceUsd !== null ? amount * priceUsd : null
      return {
        token: entry.token,
        balance: entry.balance,
        balanceFormatted: entry.balanceFormatted,
        priceUsd,
        valueUsd,
      }
    })

    enriched.sort((a, b) => {
      if (a.valueUsd !== null && b.valueUsd !== null) return b.valueUsd - a.valueUsd
      if (a.valueUsd !== null) return -1
      if (b.valueUsd !== null) return 1
      return a.token.symbol.localeCompare(b.token.symbol)
    })

    return enriched
  }, [heldEntries, prices])

  const totalValueUsd = useMemo(() => {
    const known = tokens.filter((t) => t.valueUsd !== null)
    if (known.length === 0) return null
    return known.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
  }, [tokens])

  return {
    tokens,
    totalValueUsd,
    isLoading:
      pricesLoading ||
      (useAlchemyPath ? discovery.isLoading : multicallLoading),
    isError:
      pricesError ||
      (useAlchemyPath ? discovery.isError : multicallError),
    lastUpdated,
    refresh,
  }
}
