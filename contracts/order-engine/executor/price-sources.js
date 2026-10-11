/**
 * price-sources.js — the three independent USD price sources behind the DCA floor PRICE QUORUM
 * (ADR-024, owner decisions 2026-10-11).
 *
 * Trust order (highest first):
 *   1. chainlink  — on-chain. The OrderExecutorV3 `tokenUsdFeeds(token)` registry when it answers
 *                   `registered`, else the keeper's MIRROR of src/lib/chains/chainlink-feeds.ts for
 *                   this chain (drift-guarded by price-sources.test.mjs, same pattern as
 *                   eth-usd-feed.js), read over the keeper's own RPC. Integrity checks mirror the
 *                   contract's: answer > 0, answeredInRound >= roundId, updatedAt fresh.
 *   2. defillama  — coins.llama.fi current price by chain:address. This is the client executor.js has
 *                   used since SPRINT-ORDER-ONCHAIN-FLOOR / P1a (same endpoint, same 5 s cap),
 *                   re-homed here and BATCHED per cycle.
 *   3. coingecko  — api.coingecko.com simple/token_price by platform + contract address. The ONE new
 *                   independent off-chain source the quorum needs besides DefiLlama: no key required,
 *                   batched over every active DCA token once per cycle and cached for that cycle
 *                   (the keyless tier allows roughly 30 requests/min). COINGECKO_API_KEY (optional,
 *                   sent as the demo-tier header) raises the limit. Why CoinGecko and not something
 *                   already wired: nothing in this repo prices a token BY CONTRACT ADDRESS
 *                   independently of DefiLlama/Chainlink — the app's multi-source compare is exactly
 *                   those two, scripts/token-catalog uses CoinGecko only for catalog metadata, and
 *                   /api/token-logo only for logos. A 0x/1inch quote is not a price source: it is the
 *                   very thing the floor exists to check.
 *
 * Every source yields `{ price, ts, source }` or nothing. A quote older than MAX_PRICE_AGE_SEC
 * (order-floor.js, env-overridable) is ABSENT, not stale-but-present; a quote with NO timestamp is
 * also absent (unknown age cannot be proven fresh). Every I/O dependency — RPC client, fetch, clock,
 * env — is injected, so the module is unit-testable with ZERO network; it is separate from
 * executor.js for the same reason eth-usd-feed.js / order-floor.js are (executor.js auto-runs
 * main() on import).
 *
 * Never throws: a source that fails is simply absent for that leg this cycle. The quorum
 * (order-floor.js resolveFloorPrice) decides what an absence means.
 */

import { getMaxPriceAgeSec } from "./order-floor.js"

export const SOURCE_CHAINLINK = "chainlink"
export const SOURCE_DEFILLAMA = "defillama"
export const SOURCE_COINGECKO = "coingecko"

/** Native-ETH sentinel the app signs for an unwrapped leg. Off-chain sources and the feed mirror
 *  price it as the chain's wrapped native (what the app's getChainlinkFeed does too). */
export const NATIVE_ETH_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

/** Wrapped-native (WETH) per chain. Arbitrum does NOT reuse the OP-stack 0x4200…0006 predeploy —
 *  its entry is pinned to docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json by arbitrum-plumbing.test.mjs. */
export const WRAPPED_NATIVE_BY_CHAIN = Object.freeze({
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
})

/** ETH/WETH (and the native sentinel) on every chain — the legs an explicit ETH_USD_FEED env
 *  override applies to (eth-usd-feed.js keeps prod byte-identical where that var is set). */
export const ETH_PRICED_ADDRESSES = new Set([NATIVE_ETH_SENTINEL, ...Object.values(WRAPPED_NATIVE_BY_CHAIN)])

/** DefiLlama chain slugs — mirrors src/lib/chains/registry.ts (ethereum / base / arbitrum). An
 *  unmapped chain has no DefiLlama source (absent), never a guessed slug. */
export const DEFILLAMA_CHAIN_SLUG = Object.freeze({ 1: "ethereum", 8453: "base", 42161: "arbitrum" })

/** CoinGecko asset-platform ids — mirrors src/app/api/token-logo/route.ts COINGECKO_PLATFORM. */
export const COINGECKO_PLATFORM = Object.freeze({ 1: "ethereum", 8453: "base", 42161: "arbitrum-one" })

/**
 * Keeper-side MIRROR of the app's Chainlink token → USD-feed map (src/lib/chains/chainlink-feeds.ts
 * CHAINLINK_FEEDS_BY_CHAIN; chain 1 via src/lib/constants.ts CHAINLINK_FEEDS / CHAINLINK_ETH_USD).
 * The keeper is a standalone Node package and cannot import the app's TypeScript, so the values
 * are mirrored and price-sources.test.mjs parses the TS and FAILS on any drift (address, decimals
 * or pair description) — the mirror can never rot silently. Keys are lowercased token addresses.
 *
 * 8453 / 42161: complete copies (the drift test asserts key-set equality). Chain 1: a deliberate
 * SUBSET (ETH + the three majors) — no keeper runs DCA on mainnet today; the drift test asserts
 * every mirrored entry equals the app's. Used only when the V3 registry does not cover the token.
 */
export const CHAINLINK_USD_FEED_BY_CHAIN = Object.freeze({
  1: Object.freeze({
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", decimals: 8, pair: "ETH / USD" },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", decimals: 8, pair: "USDC / USD" },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", decimals: 8, pair: "USDT / USD" },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", decimals: 8, pair: "DAI / USD" },
  }),
  8453: Object.freeze({
    "0x4200000000000000000000000000000000000006": { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", decimals: 8, pair: "ETH / USD" },
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { feed: "0x458138Fc0D67027E9A6778ef40a6ffC318c69061", decimals: 8, pair: "USDC / USD" },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { feed: "0x591e79239a7d679378eC8c847e5038150364C78F", decimals: 8, pair: "DAI / USD" },
  }),
  42161: Object.freeze({
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", decimals: 8, pair: "ETH / USD" },
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { feed: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", decimals: 8, pair: "USDC / USD" },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { feed: "0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB", decimals: 8, pair: "DAI / USD" },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { feed: "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7", decimals: 8, pair: "USDT / USD" },
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { feed: "0xd0C7101eACbB49F3deCcCc166d238410D6D46d57", decimals: 8, pair: "WBTC / USD" },
  }),
})

/** OrderExecutorV3 `tokenUsdFeeds(address)` — the mapping `_readFeedUsd` reads on-chain
 *  (TeraSwapOrderExecutorV3.sol:229). Output order mirrors src/lib/order-engine/abi.ts. */
export const TOKEN_USD_FEEDS_ABI = [
  {
    name: "tokenUsdFeeds",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "feed", type: "address" },
      { name: "feedDecimals", type: "uint8" },
      { name: "tokenDecimals", type: "uint8" },
      { name: "maxStaleness", type: "uint256" },
      { name: "registered", type: "bool" },
    ],
  },
]

/** Chainlink AggregatorV3 `latestRoundData()`. */
export const AGGREGATOR_V3_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
]

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const ADDRESS_RE = /^0x[0-9a-f]{40}$/
/** Tolerated clock skew for a quote timestamped in the future (seconds). Beyond it ⇒ absent. */
export const FUTURE_SKEW_SEC = 300
/** Off-chain batch size per request (URL-length safe for both vendors). */
export const BATCH_SIZE = 50
/** Per-request cap — never stall a cycle on a slow vendor (same 5 s executor.js always used). */
export const SOURCE_TIMEOUT_MS = 5_000

/**
 * Lowercase a token address; the native sentinel becomes the chain's wrapped native. Anything that
 * is not a 20-byte hex address ⇒ null (no source is ever asked about junk).
 * @param {unknown} token
 * @param {number|string} chainId
 * @returns {string|null}
 */
export function normalizeToken(token, chainId) {
  if (typeof token !== "string") return null
  const addr = token.trim().toLowerCase()
  if (!ADDRESS_RE.test(addr)) return null
  if (addr === NATIVE_ETH_SENTINEL) return WRAPPED_NATIVE_BY_CHAIN[Number(chainId)] || null
  return addr
}

/**
 * Freshness gate shared by every source: age within [−FUTURE_SKEW_SEC, maxAgeSec].
 * @param {number} ts unix seconds
 * @param {number} nowSec unix seconds
 * @param {number} maxAgeSec
 */
export function isFresh(ts, nowSec, maxAgeSec) {
  const age = nowSec - ts
  return age <= maxAgeSec && age >= -FUTURE_SKEW_SEC
}

/**
 * Build a quote from raw vendor fields, or null when unusable (non-positive / non-finite price,
 * missing or stale timestamp). The single place the "age > MAX_PRICE_AGE_SEC ⇒ absent" rule lives.
 * @returns {{ price: number, ts: number, source: string }|null}
 */
export function toQuote({ price, ts, source, nowSec, maxAgeSec }) {
  const p = Number(price)
  const t = Number(ts)
  if (!Number.isFinite(p) || p <= 0) return null
  if (!Number.isFinite(t) || t <= 0) return null
  if (!isFresh(t, nowSec, maxAgeSec)) return null
  return { price: p, ts: t, source }
}

function uniqueNormalized(tokens, chainId) {
  const out = new Set()
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const a = normalizeToken(t, chainId)
    if (a) out.add(a)
  }
  return [...out]
}

function chunks(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const big = (v) => (typeof v === "bigint" ? v : BigInt(v))

/** GET + JSON with a hard timeout; any failure (non-2xx, abort, parse) ⇒ null. Never throws. */
async function getJson(fetchImpl, url, { timeoutMs = SOURCE_TIMEOUT_MS, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers })
    if (!res || !res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Source 1 — on-chain Chainlink. Feed resolution, in order:
 *   a. OrderExecutorV3 `tokenUsdFeeds(token)` when `v3Address` is set AND the registry says
 *      registered (its own feedDecimals are used);
 *   b. for an ETH-priced leg, `ethUsdFeed` (the keeper's resolved ETH_USD_FEED — env override
 *      first, else the chain default from eth-usd-feed.js);
 *   c. the CHAINLINK_USD_FEED_BY_CHAIN mirror for this chain.
 * No feed ⇒ null without a read. A registry read error falls through to b/c (the registry being
 * momentarily unreadable must not blind the leg to a feed the mirror knows about).
 *
 * @param {object} p
 * @param {string} p.token
 * @param {number|string} p.chainId
 * @param {{ readContract: Function }|null} p.publicClient
 * @param {string} [p.v3Address]
 * @param {string|null} [p.ethUsdFeed]
 * @param {number} p.nowSec
 * @param {number} p.maxAgeSec
 * @returns {Promise<{ price: number, ts: number, source: 'chainlink', feed: string, via: 'v3-registry'|'eth-usd-feed'|'mirror' }|null>}
 */
export async function readChainlinkUsd({ token, chainId, publicClient, v3Address, ethUsdFeed, nowSec, maxAgeSec }) {
  try {
    const addr = normalizeToken(token, chainId)
    if (!addr || !publicClient || typeof publicClient.readContract !== "function") return null

    let feed = null
    let decimals = null
    let via = null

    if (v3Address) {
      try {
        const r = await publicClient.readContract({
          address: v3Address,
          abi: TOKEN_USD_FEEDS_ABI,
          functionName: "tokenUsdFeeds",
          args: [addr],
        })
        const [f, feedDecimals, , , registered] = Array.isArray(r) ? r : []
        if (registered === true && typeof f === "string" && f.toLowerCase() !== ZERO_ADDRESS) {
          feed = f
          decimals = Number(feedDecimals)
          via = "v3-registry"
        }
      } catch {
        /* registry unreadable this cycle → fall through to the mirror */
      }
    }

    if (!feed && ethUsdFeed && ETH_PRICED_ADDRESSES.has(addr)) {
      feed = ethUsdFeed
      decimals = 8
      via = "eth-usd-feed"
    }

    if (!feed) {
      const m = CHAINLINK_USD_FEED_BY_CHAIN[Number(chainId)]?.[addr]
      if (!m) return null
      feed = m.feed
      decimals = m.decimals
      via = "mirror"
    }

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null

    const round = await publicClient.readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" })
    const [roundId, answer, , updatedAt, answeredInRound] = Array.isArray(round) ? round : []
    const ans = big(answer)
    if (ans <= 0n) return null
    if (big(answeredInRound) < big(roundId)) return null
    const q = toQuote({ price: Number(ans) / 10 ** decimals, ts: Number(updatedAt), source: SOURCE_CHAINLINK, nowSec, maxAgeSec })
    return q ? { ...q, feed, via } : null
  } catch {
    return null
  }
}

/**
 * Source 2 — DefiLlama, batched: ONE request per 50 tokens (`prices/current/slug:a,slug:b,…`).
 * @returns {Promise<Map<string, { price: number, ts: number, source: 'defillama' }>>} keyed by
 *   normalized token; a token with no usable/fresh price is simply absent.
 */
export async function fetchDefiLlamaUsd({ tokens, chainId, fetchImpl, nowSec, maxAgeSec, timeoutMs = SOURCE_TIMEOUT_MS }) {
  const out = new Map()
  try {
    const slug = DEFILLAMA_CHAIN_SLUG[Number(chainId)]
    if (!slug) return out
    const addrs = uniqueNormalized(tokens, chainId)
    for (const chunk of chunks(addrs, BATCH_SIZE)) {
      const keys = chunk.map((a) => `${slug}:${a}`)
      const json = await getJson(fetchImpl, `https://coins.llama.fi/prices/current/${keys.join(",")}`, { timeoutMs })
      if (!json || typeof json !== "object") continue
      for (const a of chunk) {
        const row = json?.coins?.[`${slug}:${a}`]
        const q = toQuote({ price: row?.price, ts: row?.timestamp, source: SOURCE_DEFILLAMA, nowSec, maxAgeSec })
        if (q) out.set(a, q)
      }
    }
  } catch {
    /* never throws — whatever was parsed before the error stays */
  }
  return out
}

/**
 * Source 3 — CoinGecko simple/token_price, batched: ONE request per 50 tokens, with
 * `include_last_updated_at=true` so the age gate has a timestamp. `apiKey` (COINGECKO_API_KEY) is
 * optional and sent as the demo-tier header; keyless works at the public rate limit.
 * @returns {Promise<Map<string, { price: number, ts: number, source: 'coingecko' }>>}
 */
export async function fetchCoinGeckoUsd({ tokens, chainId, fetchImpl, nowSec, maxAgeSec, apiKey, timeoutMs = SOURCE_TIMEOUT_MS }) {
  const out = new Map()
  try {
    const platform = COINGECKO_PLATFORM[Number(chainId)]
    if (!platform) return out
    const addrs = uniqueNormalized(tokens, chainId)
    const headers = apiKey ? { "x-cg-demo-api-key": apiKey } : {}
    for (const chunk of chunks(addrs, BATCH_SIZE)) {
      const url =
        `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${chunk.join(",")}&vs_currencies=usd&include_last_updated_at=true`
      const json = await getJson(fetchImpl, url, { timeoutMs, headers })
      if (!json || typeof json !== "object") continue
      // CoinGecko echoes contract addresses lowercased; tolerate a checksummed echo anyway.
      const rows = new Map(Object.entries(json).map(([k, v]) => [String(k).toLowerCase(), v]))
      for (const a of chunk) {
        const row = rows.get(a)
        const q = toQuote({ price: row?.usd, ts: row?.last_updated_at, source: SOURCE_COINGECKO, nowSec, maxAgeSec })
        if (q) out.set(a, q)
      }
    }
  } catch {
    /* never throws */
  }
  return out
}

/**
 * Per-CYCLE quote context: the executor creates one at the top of each cycle, registers every
 * active DCA token, then asks `legQuotes(token)` per leg. Off-chain sources are fetched ONCE per
 * cycle for the whole registered set (one DefiLlama + one CoinGecko request per 50 tokens) and
 * cached; Chainlink reads are memoized per token for the cycle. A token first seen AFTER the batch
 * went out gets one supplementary batch of its own — registration is an optimisation, never a
 * correctness requirement.
 *
 * @param {object} p
 * @param {number|string} p.chainId
 * @param {{ readContract: Function }|null} p.publicClient
 * @param {string} [p.v3Address]            ORDER_EXECUTOR_V3_ADDRESS ("" / undefined ⇒ mirror only)
 * @param {string|null} [p.ethUsdFeed]      the keeper's resolved ETH_USD_FEED
 * @param {Function} [p.fetchImpl]          defaults to globalThis.fetch; tests inject a fake
 * @param {() => number} [p.now]            unix SECONDS; tests inject a fixed clock
 * @param {object} [p.env]                  process.env by default (MAX_PRICE_AGE_SEC, COINGECKO_API_KEY)
 * @returns {{ registerTokens: (tokens: unknown[]) => void, legQuotes: (token: string) => Promise<Array<{price:number, ts:number, source:string}>>, maxAgeSec: number }}
 */
export function createCycleQuoteContext({
  chainId,
  publicClient,
  v3Address,
  ethUsdFeed = null,
  fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
  env = process.env,
}) {
  const maxAgeSec = getMaxPriceAgeSec(env)
  const apiKey = env && env.COINGECKO_API_KEY ? String(env.COINGECKO_API_KEY) : undefined
  const registered = new Set()
  const chainlinkMemo = new Map() // addr -> Promise<quote|null>
  const supplementary = new Map() // addr -> Promise<batch> for tokens seen after the main batch
  let mainBatch = null // Promise<batch>, created on first use

  async function fetchBatch(addrs) {
    const nowSec = now()
    const [llama, gecko] = await Promise.all([
      fetchDefiLlamaUsd({ tokens: addrs, chainId, fetchImpl, nowSec, maxAgeSec }),
      fetchCoinGeckoUsd({ tokens: addrs, chainId, fetchImpl, nowSec, maxAgeSec, apiKey }),
    ])
    return { llama, gecko, covered: new Set(addrs) }
  }

  function registerTokens(tokens) {
    for (const t of Array.isArray(tokens) ? tokens : []) {
      const a = normalizeToken(t, chainId)
      if (a) registered.add(a)
    }
  }

  async function offchainFor(addr) {
    if (!mainBatch) {
      registered.add(addr)
      mainBatch = fetchBatch([...registered])
    }
    const batch = await mainBatch
    if (batch.covered.has(addr)) return batch
    if (!supplementary.has(addr)) supplementary.set(addr, fetchBatch([addr]))
    return supplementary.get(addr)
  }

  async function legQuotes(token) {
    const addr = normalizeToken(token, chainId)
    if (!addr) return []
    if (!chainlinkMemo.has(addr)) {
      chainlinkMemo.set(
        addr,
        readChainlinkUsd({ token: addr, chainId, publicClient, v3Address: v3Address || undefined, ethUsdFeed, nowSec: now(), maxAgeSec }).catch(() => null),
      )
    }
    const [cl, off] = await Promise.all([chainlinkMemo.get(addr), offchainFor(addr).catch(() => null)])
    const quotes = []
    if (cl) quotes.push(cl)
    const l = off?.llama?.get(addr)
    if (l) quotes.push(l)
    const g = off?.gecko?.get(addr)
    if (g) quotes.push(g)
    return quotes // trust order: chainlink, defillama, coingecko
  }

  return { registerTokens, legQuotes, maxAgeSec }
}
