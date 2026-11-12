/**
 * [B8] Shared test fixtures for the Portfolio tab: wallet / RPC / API are fakes, nothing is signed or sent. Per chain, one wallet holds native
 * ETH, a curated stable and BTC (mainnet only — v1's curated set is mainnet's `DEFAULT_TOKENS`), a priced unknown token and an unpriced one.
 */
import { vi } from 'vitest'
import { fmtUsd } from '@/lib/format'

export const WALLET = '0xd44d00000000000000000000000000000000962d' as const
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
export const EXPLORER_HOST: Record<number, string> = { 1: 'etherscan.io', 8453: 'basescan.org', 42161: 'arbiscan.io' }

export interface Held { address: string; symbol: string; name: string; decimals: number; balance: bigint; priceCents: bigint | null }

/** What the discovery endpoint reports per chain (ERC-20s only — native ETH comes from `useBalance`). */
export const ERC20_BY_CHAIN: Record<number, Held[]> = {
  1: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, balance: 2_500_000_000n, priceCents: 100n },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, balance: 10_000_000n, priceCents: 6_000_000n },
    { address: '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2', symbol: 'ETHFI', name: 'EtherFi governance token', decimals: 18, balance: 460n * 10n ** 18n, priceCents: 50n },
    { address: '0x3ff0000000000000000000000000000000033ca0', symbol: 'SPAM', name: 'Airdrop Claim', decimals: 18, balance: 1n * 10n ** 18n, priceCents: null },
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, balance: 1_250_000_000n, priceCents: 100n },
    { address: '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2', symbol: 'ETHFI', name: 'EtherFi governance token', decimals: 18, balance: 460n * 10n ** 18n, priceCents: 50n },
    { address: '0x3ff0000000000000000000000000000000033ca0', symbol: 'SPAM', name: 'Airdrop Claim', decimals: 18, balance: 1n * 10n ** 18n, priceCents: null },
  ],
  42161: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6, balance: 800_000_000n, priceCents: 100n },
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', name: 'Arbitrum', decimals: 18, balance: 1_000n * 10n ** 18n, priceCents: 80n },
  ],
}
export const NATIVE_WEI = 5n * 10n ** 17n // 0.5 ETH
export const ETH_CENTS = 300_000n // $3 000.00

/** The expected portfolio total in whole cents, computed with bigint arithmetic only (no float on the way). */
export function expectedTotalCents(chainId: number): bigint {
  let cents = (NATIVE_WEI * ETH_CENTS) / 10n ** 18n
  for (const t of ERC20_BY_CHAIN[chainId]) if (t.priceCents !== null) cents += (t.balance * t.priceCents) / 10n ** BigInt(t.decimals)
  return cents
}
export const expectedTotalText = (chainId: number): string => fmtUsd(Number(expectedTotalCents(chainId)) / 100)

/** A `fetch` that answers the two portfolio endpoints from the fixtures (parsed URL, never a substring of the raw string). */
export function portfolioFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
    const chainId = Number(url.searchParams.get('chainId'))
    if (url.pathname === '/api/portfolio/tokens') {
      return json({ tokens: ERC20_BY_CHAIN[chainId].map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logoURI: null, balance: t.balance.toString(), isDefault: false })) })
    }
    if (url.pathname === '/api/portfolio/prices') {
      const wanted = (url.searchParams.get('tokens') ?? '').split(',')
      const prices: Record<string, number> = { [NATIVE.toLowerCase()]: Number(ETH_CENTS) / 100 }
      for (const t of ERC20_BY_CHAIN[chainId]) if (t.priceCents !== null) prices[t.address.toLowerCase()] = Number(t.priceCents) / 100
      return json({ prices: Object.fromEntries(Object.entries(prices).filter(([a]) => wanted.includes(a))) })
    }
    throw new Error(`unexpected fetch ${url.pathname}`)
  })
}
