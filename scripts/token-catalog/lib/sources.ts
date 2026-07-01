/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Source normalizers — pure parsers over fetched JSON.
 *
 * Every parser is defensive: a malformed entry is SKIPPED (never crashes the build) and a
 * completely alien payload yields []. Addresses are normalized to EIP-55 via viem getAddress.
 */
import { getAddress } from 'viem'
import type { MarketSignal, SourceEntry, SourceId } from './types'

function checksum(address: unknown): `0x${string}` | null {
  if (typeof address !== 'string') return null
  try {
    return getAddress(address)
  } catch {
    return null
  }
}

function validDecimals(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 36
}

function entryFrom(
  raw: { address?: unknown; symbol?: unknown; name?: unknown; decimals?: unknown; logoURI?: unknown },
  chainId: number,
  source: SourceId,
): SourceEntry | null {
  const address = checksum(raw.address)
  if (!address) return null
  if (typeof raw.symbol !== 'string' || raw.symbol.length === 0) return null
  if (!validDecimals(raw.decimals)) return null
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.symbol
  const logoURI = typeof raw.logoURI === 'string' && raw.logoURI.length > 0 ? raw.logoURI : undefined
  return { chainId, address, symbol: raw.symbol, name, decimals: raw.decimals, logoURI, source }
}

/** Standard tokenlist shape ({tokens: [{chainId, address, symbol, name, decimals, logoURI}]}) —
 *  used by uniswap, coingecko per-chain lists, superchain, trustwallet. */
export function parseTokenList(raw: unknown, chainId: number, source: SourceId): SourceEntry[] {
  const tokens = (raw as { tokens?: unknown })?.tokens
  if (!Array.isArray(tokens)) return []
  const out: SourceEntry[] = []
  for (const t of tokens) {
    if (!t || typeof t !== 'object') continue
    const row = t as Record<string, unknown>
    // tokenlists carry many chains; a missing chainId is treated as "the requested chain"
    // (coingecko's per-chain lists omit it — the URL already scopes the chain).
    if (row.chainId != null && row.chainId !== chainId) continue
    const e = entryFrom(row, chainId, source)
    if (e) out.push(e)
  }
  return out
}

/** 1inch shape: an object map { [address]: {symbol, name, decimals, address, logoURI} }. */
export function parseOneInchMap(raw: unknown, chainId: number): SourceEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: SourceEntry[] = []
  for (const [addr, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const e = entryFrom({ ...row, address: row.address ?? addr }, chainId, 'oneinch')
    if (e) out.push(e)
  }
  return out
}

/**
 * DefiLlama coins API shape: { coins: { "<platform>:<address>": {price, symbol, decimals, confidence} } }.
 * A coin with symbol+decimals is an IDENTITY vote; any coin with a price is a MARKET signal.
 */
export function parseDefiLlamaCoins(
  raw: unknown,
  chainId: number,
  platform: string,
): { entries: SourceEntry[]; market: Map<string, MarketSignal> } {
  const entries: SourceEntry[] = []
  const market = new Map<string, MarketSignal>()
  const coins = (raw as { coins?: unknown })?.coins
  if (!coins || typeof coins !== 'object' || Array.isArray(coins)) return { entries, market }
  const prefix = `${platform}:`
  for (const [coinKey, value] of Object.entries(coins as Record<string, unknown>)) {
    if (!coinKey.startsWith(prefix) || !value || typeof value !== 'object') continue
    const address = checksum(coinKey.slice(prefix.length))
    if (!address) continue
    const row = value as Record<string, unknown>
    const marketKey = `${chainId}:${address.toLowerCase()}`
    if (typeof row.price === 'number') {
      market.set(marketKey, {
        priceUsd: row.price,
        priceConfidence: typeof row.confidence === 'number' ? row.confidence : undefined,
      })
    }
    const e = entryFrom({ address, symbol: row.symbol, name: row.symbol, decimals: row.decimals }, chainId, 'defillama')
    if (e) entries.push(e)
  }
  return { entries, market }
}
