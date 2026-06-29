'use client'

/**
 * [CHORE-DCA-UX-FIXES] useTokenBalance — direct on-chain balance for a SINGLE selected token
 * (curated OR imported), on a given chain.
 *
 * useTokenBalances() only multicalls the CURATED catalog of the active chain, so an imported /
 * unverified token (e.g. ETHFI on Base) — which is never in that catalog — gets no balance, and the
 * DCA spend line shows "—" with the quick-fill presets disabled even when the wallet holds it. This
 * hook reads balanceOf for ANY ERC-20 address (native ETH via useBalance), so the SELECTED spend
 * token always shows its balance and drives the 25/50/100% presets. Chain-aware: the read is pinned
 * to the passed chainId.
 */

import { useReadContract, useBalance, useAccount } from 'wagmi'
import { erc20Abi } from 'viem'
import { isNativeETH, type Token } from '@/lib/tokens'
import { formatBalance } from '@/hooks/useTokenBalances'

export interface UseTokenBalanceResult {
  /** Raw smallest-unit balance (0n when unknown/disconnected). */
  raw: bigint
  /** True once a balance value has resolved (distinguishes "0 held" from "not loaded"). */
  hasValue: boolean
  /** Pretty display string (e.g. "123", "1.25", "<0.0001"), or undefined while unknown. */
  formatted: string | undefined
  isLoading: boolean
  isError: boolean
}

export function useTokenBalance(
  token: Token | null,
  chainId: number,
  opts: { enabled?: boolean } = {},
): UseTokenBalanceResult {
  const { address, isConnected } = useAccount()
  const native = !!token && isNativeETH(token)
  const baseEnabled = (opts.enabled ?? true) && isConnected && !!address && !!token

  // ERC-20 path — balanceOf(address) for the token, pinned to the frozen chain.
  const erc20 = useReadContract({
    chainId,
    address: token && !native ? (token.address as `0x${string}`) : undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: baseEnabled && !native, refetchInterval: 30_000 },
  })

  // Native path — useBalance for native ETH (defensive: the DCA spend token is an ERC-20 today).
  const nativeBal = useBalance({
    address,
    chainId,
    query: { enabled: baseEnabled && native },
  })

  const raw: bigint | undefined = native
    ? (nativeBal.data?.value as bigint | undefined)
    : (erc20.data as bigint | undefined)
  const decimals = token?.decimals ?? 18

  return {
    raw: raw ?? 0n,
    hasValue: raw !== undefined,
    formatted: raw !== undefined ? formatBalance(raw, decimals) : undefined,
    isLoading: native ? nativeBal.isLoading : erc20.isLoading,
    isError: native ? nativeBal.isError : erc20.isError,
  }
}
