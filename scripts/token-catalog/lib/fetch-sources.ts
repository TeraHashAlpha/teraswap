/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Real source fetchers (network). Every fetcher throws on
 * failure — buildChainCatalog catches, logs, and continues (outage-tolerant by contract).
 * The uniswap fetcher alone has an internal fallback: the vendored snapshot pinned by
 * SPRINT-9Y (scripts/token-lists/uniswap-default-v21.3.0.json), noted in the result.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { MarketSignal, SourceFetchResult } from './types'
import { parseTokenList, parseOneInchMap, parseDefiLlamaCoins } from './sources'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', '..')
const VENDORED_UNISWAP = join(ROOT, 'scripts', 'token-lists', 'uniswap-default-v21.3.0.json')

/**
 * chainId → per-source platform slug. Mainnet/Base happen to share one spelling across
 * CoinGecko, DefiLlama and Trust Wallet ('ethereum'/'base') — Arbitrum does NOT: CoinGecko
 * lists it as 'arbitrum-one' (its 'arbitrum' path 404s), DefiLlama's coins API and Trust
 * Wallet's blockchains folder are both 'arbitrum' (confirmed live 2026-09-12). Kept as
 * separate maps rather than reusing PLATFORM so a future chain's mismatch fails loudly
 * (a missing key) instead of silently sharing the wrong slug.
 */
const CG_PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum-one' }
const TW_PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum' }
const LLAMA_PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum' }

const FETCH_TIMEOUT_MS = 30_000

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export interface ChainFetchers {
  fetchers: Array<() => Promise<SourceFetchResult>>
  /** CoinGecko per-chain address set captured by the coingecko fetcher — injected into the
   *  shared verdict collector so the guard's trusted-list signal reuses the SAME download. */
  getCgSet: () => Set<string> | null
}

export function makeFetchers(chainId: number): ChainFetchers {
  let cgSet: Set<string> | null = null
  const cgPlatform = CG_PLATFORM[chainId]
  const twPlatform = TW_PLATFORM[chainId]

  const uniswap = async (): Promise<SourceFetchResult> => {
    try {
      const raw = await fetchJson('https://tokens.uniswap.org')
      return { source: 'uniswap', entries: parseTokenList(raw, chainId, 'uniswap') }
    } catch (e) {
      // vendored-snapshot fallback — still the uniswap source, loudly noted
      const raw = JSON.parse(readFileSync(VENDORED_UNISWAP, 'utf8'))
      return {
        source: 'uniswap',
        entries: parseTokenList(raw, chainId, 'uniswap'),
        note: `live fetch failed (${String((e as Error)?.message ?? e)}) — vendored snapshot v21.3.0 used`,
      }
    }
  }

  const coingecko = async (): Promise<SourceFetchResult> => {
    const raw = await fetchJson(`https://tokens.coingecko.com/${cgPlatform}/all.json`)
    // The trusted-list set mirrors verdicts.ts cgAddressSet EXACTLY (every string address,
    // no tokenlist validation) so tokens:sync and guard:refresh compute inTrustedList from
    // identical semantics — the identity ENTRIES below still go through full validation.
    const rawTokens = (raw as { tokens?: Array<{ address?: unknown }> })?.tokens
    cgSet = new Set(
      (Array.isArray(rawTokens) ? rawTokens : [])
        .filter((t) => typeof t?.address === 'string')
        .map((t) => (t.address as string).toLowerCase()),
    )
    return { source: 'coingecko', entries: parseTokenList(raw, chainId, 'coingecko') }
  }

  const oneinch = async (): Promise<SourceFetchResult> => {
    let lastError: unknown
    for (const url of [`https://tokens.1inch.io/v1.2/${chainId}`, `https://tokens.1inch.io/v1.1/${chainId}`]) {
      try {
        const raw = await fetchJson(url)
        return { source: 'oneinch', entries: parseOneInchMap(raw, chainId) }
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(`oneinch: ${String((lastError as Error)?.message ?? lastError)}`)
  }

  const trustwallet = async (): Promise<SourceFetchResult> => {
    const raw = await fetchJson(
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twPlatform}/tokenlist.json`,
    )
    return { source: 'trustwallet', entries: parseTokenList(raw, chainId, 'trustwallet') }
  }

  const superchain = async (): Promise<SourceFetchResult> => {
    const raw = await fetchJson(
      'https://raw.githubusercontent.com/ethereum-optimism/ethereum-optimism.github.io/master/optimism.tokenlist.json',
    )
    return { source: 'superchain', entries: parseTokenList(raw, chainId, 'superchain') }
  }

  // OffchainLabs' canonical Arbitrum bridged-token registry ("Arb Whitelist Era" — the SAME
  // list bridge.arbitrum.io itself renders). Lists BOTH L1 and L2 legs per bridged token, so
  // parseTokenList's chainId filter is load-bearing here (drops the L1 rows). This is where
  // 'USDC.e' ("Bridged USDC") is sourced from as a distinct, list-tagged entry — native USDC
  // (Circle-issued, not bridged) is never in this list, only in uniswap/coingecko/etc.
  const arbitrumBridge = async (): Promise<SourceFetchResult> => {
    const raw = await fetchJson('https://bridge.arbitrum.io/token-list-42161.json')
    return { source: 'arbitrumBridge', entries: parseTokenList(raw, chainId, 'arbitrumBridge') }
  }

  const fetchers = [uniswap, coingecko, oneinch, trustwallet]
  // The Superchain list is the canonical bridged-token registry for OP-stack chains (Base).
  if (chainId === 8453) fetchers.push(superchain)
  if (chainId === 42161) fetchers.push(arbitrumBridge)

  return { fetchers, getCgSet: () => cgSet }
}

/** DefiLlama coins API — batched market signal + identity votes over discovered addresses. */
export function makeMarketFetcher(chainId: number): (addresses: `0x${string}`[]) => Promise<SourceFetchResult> {
  const platform = LLAMA_PLATFORM[chainId]
  const BATCH = 100
  return async (addresses) => {
    const entries: SourceFetchResult['entries'] = []
    const market = new Map<string, MarketSignal>()
    let failures = 0
    for (let i = 0; i < addresses.length; i += BATCH) {
      const coins = addresses.slice(i, i + BATCH).map((a) => `${platform}:${a.toLowerCase()}`).join(',')
      try {
        const raw = await fetchJson(`https://coins.llama.fi/prices/current/${coins}`)
        const parsed = parseDefiLlamaCoins(raw, chainId, platform)
        entries.push(...parsed.entries)
        for (const [k, v] of parsed.market) market.set(k, v)
      } catch {
        failures += 1
      }
    }
    if (failures > 0 && market.size === 0) throw new Error(`defillama: all ${failures} batches failed`)
    return {
      source: 'defillama',
      entries,
      market,
      note: failures > 0 ? `${failures} batch(es) failed — partial market coverage` : undefined,
    }
  }
}
