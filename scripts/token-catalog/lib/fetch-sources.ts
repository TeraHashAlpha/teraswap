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
import type { VolumeHistory } from './verify'
import { parseTokenList, parseOneInchMap, parseDefiLlamaCoins, parseCoingeckoMarkets, parseMarketChartDailyVolumes } from './sources'

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

// [fix/token-search-ranking-squatting Task 2] CoinGecko's per-address volume endpoint
// (simple/token_price?include_24hr_vol=true) caps free-tier requests at ONE contract
// address each — hundreds of tokens would mean hundreds of sequential calls. Instead:
// fetch the full /coins/list?include_platform=true snapshot ONCE (memoized for the life
// of the process — build.ts calls makeVolumeFetcher once per chain, all 3 chains share
// this) to map contract address → CoinGecko coin id, then batch id → 24h volume through
// /coins/markets (up to 250 ids/request) — a handful of requests covers every chain.
let coinsListPromise: Promise<Array<{ id: string; platforms?: Record<string, string> }>> | null = null
function fetchCoinsList(): Promise<Array<{ id: string; platforms?: Record<string, string> }>> {
  if (!coinsListPromise) {
    coinsListPromise = fetchJson('https://api.coingecko.com/api/v3/coins/list?include_platform=true') as Promise<
      Array<{ id: string; platforms?: Record<string, string> }>
    >
  }
  return coinsListPromise
}

const CG_MARKETS_BATCH = 250

/** Batched CoinGecko 24h-volume market signal over discovered addresses. Outage-tolerant
 *  like makeMarketFetcher: a batch failure is logged and skipped, never fatal. */
export function makeVolumeFetcher(
  chainId: number,
  getJson: (url: string, label: string) => Promise<CgJsonResult> = sharedCgJson,
): (addresses: `0x${string}`[]) => Promise<SourceFetchResult> {
  const platform = CG_PLATFORM[chainId]
  return async (addresses) => {
    const list = await fetchCoinsList()
    const idByAddress = new Map<string, string>()
    for (const coin of list) {
      const addr = coin.platforms?.[platform]
      if (addr) idByAddress.set(addr.toLowerCase(), coin.id)
    }
    const idToAddresses = new Map<string, string[]>()
    for (const addr of addresses) {
      const id = idByAddress.get(addr.toLowerCase())
      if (!id) continue
      const g = idToAddresses.get(id)
      if (g) g.push(addr)
      else idToAddresses.set(id, [addr])
    }
    const ids = [...idToAddresses.keys()]
    const market = new Map<string, MarketSignal>()
    let failures = 0
    for (let i = 0; i < ids.length; i += CG_MARKETS_BATCH) {
      const chunk = ids.slice(i, i + CG_MARKETS_BATCH)
      // [feat/catalog-single-source-volume] through the shared throttled client: an unthrottled burst of
      // ~11 batches 429'd on the keyless tier and silently dropped most volumes (found by the dry-run).
      const res = await getJson(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${chunk.join(',')}&per_page=${CG_MARKETS_BATCH}&page=1`,
        'coins/markets',
      )
      if (res.ok) for (const [k, v] of parseCoingeckoMarkets(res.json, chainId, idToAddresses)) market.set(k, v)
      else failures += 1
    }
    if (failures > 0 && market.size === 0) throw new Error(`coingecko-volume: all ${failures} batch(es) failed`)
    return {
      source: 'coingecko',
      entries: [],
      market,
      note: failures > 0 ? `${failures} batch(es) failed — partial volume coverage` : undefined,
    }
  }
}

// [feat/catalog-single-source-volume] Per-token 7-day volume history for the single-source rule.
// CoinGecko's KEYLESS public tier is documented at roughly 5-15 calls/min (shared, varies with
// global load), and market_chart takes ONE coin id per call — so calls are strictly sequential and
// spaced >= CG_HISTORY_MIN_INTERVAL_MS (6 s = 10 calls/min, inside that band). A 429 (or 5xx / network
// error) backs off exponentially — honouring Retry-After when sent — and after CG_HISTORY_MAX_RETRIES
// the token is reported as a FAILED fetch (the rule is fail-closed: never admitted on a failure).
// No API key is read or sent; the keyless endpoint is the contract.
export const CG_HISTORY_MIN_INTERVAL_MS = 6_000
export const CG_HISTORY_BACKOFF_BASE_MS = 15_000
export const CG_HISTORY_BACKOFF_MAX_MS = 120_000
export const CG_HISTORY_MAX_RETRIES = 4

export interface HistoryClientDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type CgJsonResult = { ok: true; json: unknown } | { ok: false; error: string }

/** One throttled keyless-CoinGecko JSON client — the throttle clock is shared by every call made
 *  through it. `label` only names the call in error messages. */
export function makeCoingeckoJsonClient(deps: HistoryClientDeps = {}): (url: string, label: string) => Promise<CgJsonResult> {
  const doFetch = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  let lastCallAt = Number.NEGATIVE_INFINITY

  return async (url, label) => {
    let lastError = 'unknown'
    for (let attempt = 0; attempt <= CG_HISTORY_MAX_RETRIES; attempt++) {
      const wait = lastCallAt + CG_HISTORY_MIN_INTERVAL_MS - now()
      if (wait > 0) await sleep(wait)
      lastCallAt = now()
      let retryAfterMs: number | null = null
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        let res: Response
        try {
          res = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
        } finally {
          clearTimeout(timer)
        }
        if (res.ok) return { ok: true, json: await res.json() }
        lastError = `${label}: HTTP ${res.status}`
        // 4xx other than 429 will not heal on retry (bad id, delisted coin)
        if (res.status !== 429 && res.status < 500) return { ok: false, error: lastError }
        const ra = Number(res.headers.get('retry-after'))
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000
      } catch (e) {
        lastError = `${label}: ${String((e as Error)?.message ?? e)}`
      }
      if (attempt === CG_HISTORY_MAX_RETRIES) break
      const backoff = Math.min(CG_HISTORY_BACKOFF_BASE_MS * 2 ** attempt, CG_HISTORY_BACKOFF_MAX_MS)
      await sleep(Math.max(backoff, retryAfterMs ?? 0))
    }
    return { ok: false, error: `${lastError} (gave up after ${CG_HISTORY_MAX_RETRIES + 1} attempts)` }
  }
}

// ONE process-wide client for the default wiring: /coins/markets batches (the 24h pre-filter) and
// market_chart history calls hit the same keyless budget, so they share one throttle clock.
const sharedCgJson = makeCoingeckoJsonClient()

export function makeCoingeckoHistoryClient(deps?: HistoryClientDeps): (coinId: string, days: number) => Promise<VolumeHistory> {
  const getJson = deps ? makeCoingeckoJsonClient(deps) : sharedCgJson
  return async (coinId, days) => {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`
    const res = await getJson(url, coinId)
    if (!res.ok) return { ok: false, error: res.error }
    const daily = parseMarketChartDailyVolumes(res.json)
    return daily ? { ok: true, dailyVolumeUsd: daily } : { ok: false, error: `${coinId}: malformed market_chart payload` }
  }
}

/**
 * Address → daily-volume history for the given single-source candidates. The CoinGecko coin id is
 * resolved from the /coins/list snapshot by the candidate's address (taken from the source payload,
 * compared lower-cased — an address is never typed here). An address with no coin id yields a failed
 * fetch (fail-closed), not a skip.
 */
export function makeVolumeHistoryFetcher(
  chainId: number,
  days: number,
  client: (coinId: string, days: number) => Promise<VolumeHistory> = makeCoingeckoHistoryClient(),
  log: (msg: string) => void = () => {},
): (addresses: `0x${string}`[]) => Promise<Map<string, VolumeHistory>> {
  const platform = CG_PLATFORM[chainId]
  return async (addresses) => {
    const out = new Map<string, VolumeHistory>()
    let idByAddress: Map<string, string>
    try {
      const list = await fetchCoinsList()
      idByAddress = new Map()
      for (const coin of list) {
        const addr = coin.platforms?.[platform]
        if (addr) idByAddress.set(addr.toLowerCase(), coin.id)
      }
    } catch (e) {
      const error = `coins/list unavailable: ${String((e as Error)?.message ?? e)}`
      for (const a of addresses) out.set(a.toLowerCase(), { ok: false, error })
      return out
    }
    let done = 0
    for (const a of addresses) {
      const id = idByAddress.get(a.toLowerCase())
      out.set(a.toLowerCase(), id ? await client(id, days) : { ok: false, error: 'no CoinGecko coin id for address' })
      done += 1
      if (done % 25 === 0 || done === addresses.length) log(`single-source history: ${done}/${addresses.length}`)
    }
    return out
  }
}
