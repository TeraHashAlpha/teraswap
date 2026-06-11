'use client'

import { useMemo } from 'react'
import { useAccount, useBalance, useReadContracts } from 'wagmi'
import { formatUnits, erc20Abi } from 'viem'
import { DEFAULT_TOKENS, isNativeETH } from '@/lib/tokens'
import { useActiveChainId } from '@/hooks/useChainId'
import { isChainActive, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { getChainTokenList } from '@/lib/chains/tokens'

/**
 * [SPRINT-9G G5 / M08] Fetch ERC-20 + native balances for the token catalog of
 * the ACTIVE chain via multicall.
 *
 * Chain-aware: reads run over the active chain's RPC (`chainId: activeChainId`),
 * for that chain's catalog, gated by `isChainActive` — so Base balances render
 * once Base is live. Mainnet (DEFAULT_CHAIN_ID) keeps DEFAULT_TOKENS and the
 * connected-mainnet behaviour, so it stays byte-identical (the old gate was the
 * strict `chain.id === CHAIN_ID`, which left every L2 balance empty).
 */
// [E-3] `enabled` lets usePortfolio park the multicall while Alchemy discovery
// is doing its job (defaults true — existing callers unaffected).
export function useTokenBalances(enabled: boolean = true) {
  const { address, isConnected } = useAccount()
  const activeChainId = useActiveChainId()
  // Only fetch on a chain that is live (FeeCollector set). isChainActive(1) is
  // true in production, so mainnet behaves exactly as before.
  const chainEnabled = enabled && isChainActive(activeChainId)

  // Per-chain catalog. Mainnet keeps the canonical DEFAULT_TOKENS list verbatim.
  const tokens = useMemo(
    () => (activeChainId === DEFAULT_CHAIN_ID ? DEFAULT_TOKENS : getChainTokenList(activeChainId)),
    [activeChainId],
  )

  // Native balance — read on the active chain.
  const { data: ethBalance, isLoading: ethLoading, isError: ethError } = useBalance({
    address,
    chainId: activeChainId,
    query: { enabled: isConnected && chainEnabled },
  })

  // ERC-20 balances via multicall.
  const erc20Tokens = useMemo(() => tokens.filter((t) => !isNativeETH(t)), [tokens])

  const contracts = useMemo(
    () =>
      erc20Tokens.map((t) => ({
        address: t.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [address!] as const,
        // [SPRINT-9G G5] Pin each read to the active chain so an L2 multicall
        // never silently resolves over mainnet.
        chainId: activeChainId,
      })),
    [address, erc20Tokens, activeChainId],
  )

  const { data: erc20Results, isLoading: erc20Loading, isError: erc20Error } = useReadContracts({
    contracts: isConnected && chainEnabled && address ? contracts : [],
    query: {
      enabled: isConnected && chainEnabled && !!address,
      refetchInterval: 30_000, // refresh every 30s
    },
  })

  // Build a map: address → formatted balance string
  const balanceMap = useMemo(() => {
    const map = new Map<string, { raw: bigint; formatted: string }>()

    // Native (ETH) — keyed by the active chain's native-token entry.
    if (ethBalance) {
      const ethToken = tokens.find((t) => isNativeETH(t))
      if (ethToken) {
        map.set(ethToken.address.toLowerCase(), {
          raw: ethBalance.value,
          formatted: formatBalance(ethBalance.value, 18),
        })
      }
    }

    // ERC-20s
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
  }, [ethBalance, erc20Results, erc20Tokens, tokens])

  // [E-3] Widened return: usePortfolio's fallback path needs loading/error
  // signals alongside the map. (Loading only counts while reads are enabled.)
  return {
    balances: balanceMap,
    isLoading: Boolean(isConnected && chainEnabled && (ethLoading || erc20Loading)),
    isError: Boolean(ethError || erc20Error),
  }
}

// Format balance nicely: show up to 6 significant digits
export function formatBalance(value: bigint, decimals: number): string {
  if (value === 0n) return '0'
  const full = formatUnits(value, decimals)
  const num = parseFloat(full)
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`
  if (num >= 1) return num.toFixed(4).replace(/\.?0+$/, '')
  if (num >= 0.0001) return num.toFixed(6).replace(/\.?0+$/, '')
  return '<0.0001'
}
