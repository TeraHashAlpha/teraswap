/**
 * [ADR-024 / feat/keeper-price-quorum] price-sources.js — the three price sources behind the DCA
 * floor quorum, with ZERO network: every RPC / HTTP / clock / env dependency is injected, and
 * globalThis.fetch is replaced by a tripwire for the whole file so an accidental real call fails
 * loudly instead of silently reaching a vendor.
 *
 *   1. DRIFT GUARD — the Chainlink mirror equals the app's src/lib/chains/chainlink-feeds.ts
 *      (address, decimals, pair) and, for mainnet, src/lib/constants.ts. No address typed here.
 *   2. Chainlink resolution order: V3 registry (registered) → ETH_USD_FEED → mirror; integrity
 *      (answer > 0, answeredInRound >= roundId); stale ⇒ ABSENT.
 *   3. DefiLlama / CoinGecko: batched, parsed, stale/non-2xx/junk ⇒ absent, unmapped chain ⇒ no call.
 *   4. Cycle context: one off-chain batch per cycle, per-token Chainlink memo, trust-ordered quotes.
 *
 * Run: node --test contracts/order-engine/executor/price-sources.test.mjs
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  CHAINLINK_USD_FEED_BY_CHAIN,
  WRAPPED_NATIVE_BY_CHAIN,
  NATIVE_ETH_SENTINEL,
  ETH_PRICED_ADDRESSES,
  DEFILLAMA_CHAIN_SLUG,
  COINGECKO_PLATFORM,
  FUTURE_SKEW_SEC,
  normalizeToken,
  isFresh,
  toQuote,
  readChainlinkUsd,
  fetchDefiLlamaUsd,
  fetchCoinGeckoUsd,
  createCycleQuoteContext,
} from "./price-sources.js"
import { MAX_PRICE_AGE_SEC, PRICE_SOURCE_TRUST_ORDER } from "./order-floor.js"

// ── Zero-network tripwire ────────────────────────────────────────────────────────────────────────
let realNetworkCalls = 0
const originalFetch = globalThis.fetch
before(() => {
  globalThis.fetch = async () => {
    realNetworkCalls++
    throw new Error("price-sources.test.mjs: real network call attempted")
  }
})
after(() => {
  globalThis.fetch = originalFetch
  assert.equal(realNetworkCalls, 0, "a test reached globalThis.fetch — every source must be injected")
})

const NOW = 1_760_000_000 // fixed clock (unix seconds)
const MAX_AGE = MAX_PRICE_AGE_SEC
const BASE = 8453
const ARB = 42161
const WETH_BASE = WRAPPED_NATIVE_BY_CHAIN[BASE]
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const UNKNOWN = "0x1111111111111111111111111111111111111111"
const V3 = "0x686b4f812291f4de238e59ed00ba6dd6129e60a0"
const ZERO = "0x0000000000000000000000000000000000000000"

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────
/** registry: tokenLower -> tuple; rounds: feedLower -> [roundId, answer, startedAt, updatedAt, answeredInRound] */
function fakeClient({ registry = {}, rounds = {}, registryThrows = false } = {}) {
  const calls = []
  return {
    calls,
    async readContract({ address, functionName, args }) {
      calls.push({ address: String(address).toLowerCase(), functionName, args })
      if (functionName === "tokenUsdFeeds") {
        if (registryThrows) throw new Error("registry unreachable")
        return registry[String(args[0]).toLowerCase()] || [ZERO, 0, 0, 0n, false]
      }
      if (functionName === "latestRoundData") {
        const r = rounds[String(address).toLowerCase()]
        if (!r) throw new Error(`no code at ${address}`)
        return r
      }
      throw new Error(`unexpected call ${functionName}`)
    },
  }
}
const round = ({ answer, updatedAt = NOW - 10, roundId = 100n, answeredInRound = 100n }) => [roundId, answer, updatedAt, BigInt(updatedAt), answeredInRound]

/** routes(url, init) -> { ok?, status?, json } | Error (thrown). Records every call. */
function fakeFetch(routes) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init })
    const r = routes(url, init)
    if (r instanceof Error) throw r
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json }
  }
  fn.calls = []
  return fn
}

// ── 1. Drift guard ───────────────────────────────────────────────────────────────────────────────
const feedsSource = readFileSync(new URL("../../../src/lib/chains/chainlink-feeds.ts", import.meta.url), "utf-8")
const constantsSource = readFileSync(new URL("../../../src/lib/constants.ts", import.meta.url), "utf-8")
const PAIR_RE = /'(0x[0-9a-fA-F]{40})'\s*:\s*'(0x[0-9a-fA-F]{40})'/g

function appFeedsForChain(chainId) {
  const start = feedsSource.indexOf(`\n  ${chainId}: {`)
  assert.notEqual(start, -1, `chainlink-feeds.ts has no CHAINLINK_FEEDS_BY_CHAIN[${chainId}] block`)
  const end = feedsSource.indexOf("\n  },", start)
  const block = feedsSource.slice(start, end)
  const map = {}
  for (const m of block.matchAll(PAIR_RE)) map[m[1].toLowerCase()] = m[2].toLowerCase()
  return map
}
function appMainnetFeeds() {
  const start = constantsSource.indexOf("export const CHAINLINK_FEEDS")
  assert.notEqual(start, -1, "constants.ts no longer exports CHAINLINK_FEEDS")
  const end = constantsSource.indexOf("\n}", start)
  const map = {}
  for (const m of constantsSource.slice(start, end).matchAll(PAIR_RE)) map[m[1].toLowerCase()] = m[2].toLowerCase()
  const eth = constantsSource.match(/export const CHAINLINK_ETH_USD = '(0x[0-9a-fA-F]{40})'/)
  assert.ok(eth, "constants.ts no longer exports CHAINLINK_ETH_USD")
  map[WRAPPED_NATIVE_BY_CHAIN[1]] = eth[1].toLowerCase()
  return map
}
function appExpectation(feed) {
  const re = new RegExp(`'${feed}':\\s*\\{\\s*description:\\s*'([^']+)',\\s*decimals:\\s*(\\d+)`, "i")
  const m = feedsSource.match(re)
  assert.ok(m, `FEED_EXPECTATIONS has no entry for ${feed}`)
  return { pair: m[1], decimals: Number(m[2]) }
}

describe("DRIFT GUARD — the keeper's Chainlink mirror equals the app's source of truth", () => {
  for (const chainId of [BASE, ARB]) {
    test(`chain ${chainId}: key set AND every feed address equal chainlink-feeds.ts`, () => {
      const app = appFeedsForChain(chainId)
      const mirror = CHAINLINK_USD_FEED_BY_CHAIN[chainId]
      assert.deepEqual(Object.keys(mirror).sort(), Object.keys(app).sort(), "token key set drifted")
      for (const [token, entry] of Object.entries(mirror)) assert.equal(entry.feed.toLowerCase(), app[token], `feed for ${token} drifted`)
    })
  }
  test("mainnet (1): every mirrored entry equals constants.ts (a deliberate subset)", () => {
    const app = appMainnetFeeds()
    for (const [token, entry] of Object.entries(CHAINLINK_USD_FEED_BY_CHAIN[1])) {
      assert.ok(app[token], `constants.ts has no CHAINLINK_FEEDS entry for ${token}`)
      assert.equal(entry.feed.toLowerCase(), app[token], `mainnet feed for ${token} drifted`)
    }
  })
  test("every mirrored feed's decimals + pair equal the app's FEED_EXPECTATIONS", () => {
    for (const chainMap of Object.values(CHAINLINK_USD_FEED_BY_CHAIN)) {
      for (const entry of Object.values(chainMap)) {
        const exp = appExpectation(entry.feed.toLowerCase())
        assert.equal(entry.decimals, exp.decimals, `${entry.feed} decimals drifted`)
        assert.equal(entry.pair, exp.pair, `${entry.feed} pair drifted`)
      }
    }
  })
  test("keys are lowercased addresses; the wrapped-native of each chain is in its map", () => {
    for (const [chainId, chainMap] of Object.entries(CHAINLINK_USD_FEED_BY_CHAIN)) {
      for (const k of Object.keys(chainMap)) assert.match(k, /^0x[0-9a-f]{40}$/)
      assert.ok(chainMap[WRAPPED_NATIVE_BY_CHAIN[chainId]], `chain ${chainId} mirror lacks its WETH`)
    }
  })
  test("slug maps cover exactly the chains the keeper serves", () => {
    assert.deepEqual(DEFILLAMA_CHAIN_SLUG, { 1: "ethereum", 8453: "base", 42161: "arbitrum" })
    assert.deepEqual(COINGECKO_PLATFORM, { 1: "ethereum", 8453: "base", 42161: "arbitrum-one" })
    assert.deepEqual([...PRICE_SOURCE_TRUST_ORDER], ["chainlink", "defillama", "coingecko"])
  })
})

// ── normalizeToken / freshness ───────────────────────────────────────────────────────────────────
describe("normalizeToken + the age gate", () => {
  test("lowercases, maps the native sentinel to the chain's WETH, rejects junk", () => {
    assert.equal(normalizeToken(USDC_BASE.toUpperCase().replace("0X", "0x"), BASE), USDC_BASE)
    assert.equal(normalizeToken(NATIVE_ETH_SENTINEL, BASE), WETH_BASE)
    assert.equal(normalizeToken(NATIVE_ETH_SENTINEL, ARB), WRAPPED_NATIVE_BY_CHAIN[ARB])
    assert.equal(normalizeToken(NATIVE_ETH_SENTINEL, 999), null)
    for (const junk of [null, undefined, 42, "", "0x12", "not-an-address", "0x" + "g".repeat(40)]) assert.equal(normalizeToken(junk, BASE), null)
    assert.ok(ETH_PRICED_ADDRESSES.has(NATIVE_ETH_SENTINEL) && ETH_PRICED_ADDRESSES.has(WETH_BASE))
  })
  test("isFresh: within max age (inclusive) and within future skew", () => {
    assert.equal(isFresh(NOW - MAX_AGE, NOW, MAX_AGE), true)
    assert.equal(isFresh(NOW - MAX_AGE - 1, NOW, MAX_AGE), false)
    assert.equal(isFresh(NOW + FUTURE_SKEW_SEC, NOW, MAX_AGE), true)
    assert.equal(isFresh(NOW + FUTURE_SKEW_SEC + 1, NOW, MAX_AGE), false)
  })
  test("toQuote: stale ⇒ ABSENT; missing timestamp ⇒ ABSENT; non-positive price ⇒ ABSENT", () => {
    assert.deepEqual(toQuote({ price: 3000, ts: NOW - 5, source: "x", nowSec: NOW, maxAgeSec: MAX_AGE }), { price: 3000, ts: NOW - 5, source: "x" })
    assert.equal(toQuote({ price: 3000, ts: NOW - MAX_AGE - 1, source: "x", nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    assert.equal(toQuote({ price: 3000, ts: undefined, source: "x", nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    assert.equal(toQuote({ price: 0, ts: NOW, source: "x", nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    assert.equal(toQuote({ price: "abc", ts: NOW, source: "x", nowSec: NOW, maxAgeSec: MAX_AGE }), null)
  })
})

// ── 2. Chainlink ─────────────────────────────────────────────────────────────────────────────────
describe("readChainlinkUsd — V3 registry first, then ETH_USD_FEED, then the mirror", () => {
  const REG_FEED = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  const MIRROR_WETH_FEED = CHAINLINK_USD_FEED_BY_CHAIN[BASE][WETH_BASE].feed.toLowerCase()

  test("registered in V3 ⇒ reads the registry's feed with the registry's decimals", async () => {
    const client = fakeClient({
      registry: { [USDC_BASE]: [REG_FEED, 6, 6, 3600n, true] },
      rounds: { [REG_FEED]: round({ answer: 1_000_500n }) }, // 6-dp feed ⇒ $1.0005
    })
    const q = await readChainlinkUsd({ token: USDC_BASE, chainId: BASE, publicClient: client, v3Address: V3, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(q.source, "chainlink")
    assert.equal(q.via, "v3-registry")
    assert.equal(q.feed, REG_FEED)
    assert.equal(q.price, 1.0005)
    assert.equal(q.ts, NOW - 10)
    assert.deepEqual(client.calls.map((c) => c.functionName), ["tokenUsdFeeds", "latestRoundData"])
  })

  test("NOT registered in V3 ⇒ falls to the mirror for this chain (8 dp)", async () => {
    const client = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_12345678n }) } })
    const q = await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, v3Address: V3, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(q.via, "mirror")
    assert.equal(q.feed.toLowerCase(), MIRROR_WETH_FEED)
    assert.equal(q.price, 3000.12345678)
  })

  test("registry read THROWS ⇒ still falls to the mirror (a flaky registry must not blind the leg)", async () => {
    const client = fakeClient({ registryThrows: true, rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n }) } })
    const q = await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, v3Address: V3, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(q?.via, "mirror")
  })

  test("no V3 address ⇒ the registry is never asked", async () => {
    const client = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n }) } })
    await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.deepEqual(client.calls.map((c) => c.functionName), ["latestRoundData"])
  })

  test("ETH leg honours the resolved ETH_USD_FEED over the mirror (prod byte-identical where set)", async () => {
    const ENV_FEED = "0x1234567890abcdef1234567890abcdef12345678"
    const client = fakeClient({ rounds: { [ENV_FEED]: round({ answer: 2_500_00000000n }) } })
    const q = await readChainlinkUsd({ token: NATIVE_ETH_SENTINEL, chainId: BASE, publicClient: client, ethUsdFeed: ENV_FEED, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(q.via, "eth-usd-feed")
    assert.equal(q.price, 2500)
    // …but a NON-ETH leg ignores it.
    const client2 = fakeClient({ rounds: { [ENV_FEED]: round({ answer: 2_500_00000000n }) } })
    assert.equal(await readChainlinkUsd({ token: USDC_BASE, chainId: BASE, publicClient: client2, ethUsdFeed: ENV_FEED, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
  })

  test("V3 registry wins over ETH_USD_FEED when both apply", async () => {
    const ENV_FEED = "0x1234567890abcdef1234567890abcdef12345678"
    const client = fakeClient({
      registry: { [WETH_BASE]: [REG_FEED, 8, 18, 3600n, true] },
      rounds: { [REG_FEED]: round({ answer: 3_000_00000000n }), [ENV_FEED]: round({ answer: 1n }) },
    })
    const q = await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, v3Address: V3, ethUsdFeed: ENV_FEED, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(q.via, "v3-registry")
  })

  test("unknown token with no registry hit ⇒ null WITHOUT a feed read", async () => {
    const client = fakeClient()
    assert.equal(await readChainlinkUsd({ token: UNKNOWN, chainId: BASE, publicClient: client, v3Address: V3, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    assert.deepEqual(client.calls.map((c) => c.functionName), ["tokenUsdFeeds"])
  })

  test("STALE updatedAt ⇒ ABSENT (null), even though the feed answered", async () => {
    const client = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n, updatedAt: NOW - MAX_AGE - 1 }) } })
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    const fresh = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n, updatedAt: NOW - MAX_AGE }) } })
    assert.ok(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: fresh, nowSec: NOW, maxAgeSec: MAX_AGE }))
  })

  test("integrity: answer <= 0 or answeredInRound < roundId ⇒ null", async () => {
    const neg = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: -1n }) } })
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: neg, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    const zero = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 0n }) } })
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: zero, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    const lagging = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n, roundId: 101n, answeredInRound: 100n }) } })
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: lagging, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
  })

  test("feed read throws / no client ⇒ null, never throws", async () => {
    const client = fakeClient() // no rounds ⇒ the read throws
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: client, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
    assert.equal(await readChainlinkUsd({ token: WETH_BASE, chainId: BASE, publicClient: null, nowSec: NOW, maxAgeSec: MAX_AGE }), null)
  })
})

// ── 3. DefiLlama ─────────────────────────────────────────────────────────────────────────────────
describe("fetchDefiLlamaUsd — batched, parsed, fail-absent", () => {
  test("ONE request for the whole batch; fresh rows parsed, stale/missing rows absent", async () => {
    const fetchImpl = fakeFetch(() => ({
      json: {
        coins: {
          [`base:${WETH_BASE}`]: { price: 3001.5, timestamp: NOW - 30 },
          [`base:${USDC_BASE}`]: { price: 1.0001, timestamp: NOW - MAX_AGE - 1 }, // stale
        },
      },
    }))
    const m = await fetchDefiLlamaUsd({ tokens: [WETH_BASE, USDC_BASE, UNKNOWN, NATIVE_ETH_SENTINEL], chainId: BASE, fetchImpl, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].url, `https://coins.llama.fi/prices/current/base:${WETH_BASE},base:${USDC_BASE},base:${UNKNOWN}`)
    assert.deepEqual(m.get(WETH_BASE), { price: 3001.5, ts: NOW - 30, source: "defillama" })
    assert.equal(m.has(USDC_BASE), false, "stale row must be absent")
    assert.equal(m.has(UNKNOWN), false)
  })
  test("non-2xx / thrown / junk body ⇒ empty map, never throws", async () => {
    for (const routes of [() => ({ ok: false, status: 503, json: {} }), () => new Error("boom"), () => ({ json: "not json" })]) {
      const m = await fetchDefiLlamaUsd({ tokens: [WETH_BASE], chainId: BASE, fetchImpl: fakeFetch(routes), nowSec: NOW, maxAgeSec: MAX_AGE })
      assert.equal(m.size, 0)
    }
  })
  test("unmapped chain ⇒ no request at all", async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }))
    const m = await fetchDefiLlamaUsd({ tokens: [WETH_BASE], chainId: 999, fetchImpl, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(m.size, 0)
    assert.equal(fetchImpl.calls.length, 0)
  })
})

// ── 3. CoinGecko ─────────────────────────────────────────────────────────────────────────────────
describe("fetchCoinGeckoUsd — batched simple/token_price, optional demo key, fail-absent", () => {
  test("ONE request per batch with include_last_updated_at; lowercase echo tolerated; stale absent", async () => {
    const fetchImpl = fakeFetch(() => ({
      json: {
        [WETH_BASE]: { usd: 2999.9, last_updated_at: NOW - 60 },
        [USDC_BASE.toUpperCase().replace("0X", "0x")]: { usd: 1, last_updated_at: NOW - MAX_AGE - 1 }, // stale
      },
    }))
    const m = await fetchCoinGeckoUsd({ tokens: [WETH_BASE, USDC_BASE], chainId: BASE, fetchImpl, nowSec: NOW, maxAgeSec: MAX_AGE })
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(
      fetchImpl.calls[0].url,
      `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${WETH_BASE},${USDC_BASE}&vs_currencies=usd&include_last_updated_at=true`,
    )
    assert.deepEqual(fetchImpl.calls[0].init.headers, {}, "no key ⇒ no auth header")
    assert.deepEqual(m.get(WETH_BASE), { price: 2999.9, ts: NOW - 60, source: "coingecko" })
    assert.equal(m.has(USDC_BASE), false)
  })
  test("COINGECKO_API_KEY (when given) rides the demo header; Arbitrum uses the arbitrum-one platform", async () => {
    const fetchImpl = fakeFetch(() => ({ json: {} }))
    await fetchCoinGeckoUsd({ tokens: [WRAPPED_NATIVE_BY_CHAIN[ARB]], chainId: ARB, fetchImpl, nowSec: NOW, maxAgeSec: MAX_AGE, apiKey: "k" })
    assert.match(fetchImpl.calls[0].url, /\/simple\/token_price\/arbitrum-one\?/)
    assert.deepEqual(fetchImpl.calls[0].init.headers, { "x-cg-demo-api-key": "k" })
  })
  test("429 / thrown / unmapped chain ⇒ empty, never throws", async () => {
    assert.equal((await fetchCoinGeckoUsd({ tokens: [WETH_BASE], chainId: BASE, fetchImpl: fakeFetch(() => ({ ok: false, status: 429, json: {} })), nowSec: NOW, maxAgeSec: MAX_AGE })).size, 0)
    assert.equal((await fetchCoinGeckoUsd({ tokens: [WETH_BASE], chainId: BASE, fetchImpl: fakeFetch(() => new Error("net")), nowSec: NOW, maxAgeSec: MAX_AGE })).size, 0)
    const f = fakeFetch(() => ({ json: {} }))
    assert.equal((await fetchCoinGeckoUsd({ tokens: [WETH_BASE], chainId: 999, fetchImpl: f, nowSec: NOW, maxAgeSec: MAX_AGE })).size, 0)
    assert.equal(f.calls.length, 0)
  })
})

// ── 4. Cycle context ─────────────────────────────────────────────────────────────────────────────
describe("createCycleQuoteContext — one off-chain batch per cycle, memoized Chainlink, trust order", () => {
  const MIRROR_WETH_FEED = CHAINLINK_USD_FEED_BY_CHAIN[BASE][WETH_BASE].feed.toLowerCase()
  const MIRROR_USDC_FEED = CHAINLINK_USD_FEED_BY_CHAIN[BASE][USDC_BASE].feed.toLowerCase()

  function routes(url) {
    if (url.startsWith("https://coins.llama.fi/")) {
      return { json: { coins: { [`base:${WETH_BASE}`]: { price: 3002, timestamp: NOW - 20 }, [`base:${USDC_BASE}`]: { price: 1.0002, timestamp: NOW - 20 } } } }
    }
    if (url.startsWith("https://api.coingecko.com/")) {
      return { json: { [WETH_BASE]: { usd: 2998, last_updated_at: NOW - 40 } } } // no USDC row
    }
    return new Error(`unexpected url ${url}`)
  }

  test("two legs, one DefiLlama + one CoinGecko request, Chainlink read once per token, trust-ordered", async () => {
    const client = fakeClient({ rounds: { [MIRROR_WETH_FEED]: round({ answer: 3_000_00000000n }), [MIRROR_USDC_FEED]: round({ answer: 1_00000000n }) } })
    const fetchImpl = fakeFetch(routes)
    const ctx = createCycleQuoteContext({ chainId: BASE, publicClient: client, v3Address: "", fetchImpl, now: () => NOW, env: {} })
    ctx.registerTokens([WETH_BASE, USDC_BASE, "junk"])
    const [weth, usdc, wethAgain] = await Promise.all([ctx.legQuotes(WETH_BASE), ctx.legQuotes(USDC_BASE), ctx.legQuotes(NATIVE_ETH_SENTINEL)])
    assert.deepEqual(weth.map((q) => q.source), ["chainlink", "defillama", "coingecko"])
    assert.deepEqual(weth.map((q) => q.price), [3000, 3002, 2998])
    assert.deepEqual(usdc.map((q) => q.source), ["chainlink", "defillama"], "CoinGecko had no USDC row ⇒ absent, not zero")
    assert.deepEqual(wethAgain, weth, "the native sentinel is the WETH leg")
    const urls = fetchImpl.calls.map((c) => c.url)
    assert.equal(urls.filter((u) => u.includes("llama.fi")).length, 1, "exactly one DefiLlama batch per cycle")
    assert.equal(urls.filter((u) => u.includes("coingecko")).length, 1, "exactly one CoinGecko batch per cycle")
    assert.match(urls.find((u) => u.includes("llama.fi")), new RegExp(`${WETH_BASE}.*${USDC_BASE}|${USDC_BASE}.*${WETH_BASE}`), "the batch carries every registered token")
    assert.equal(client.calls.filter((c) => c.functionName === "latestRoundData").length, 2, "one Chainlink read per token per cycle")
    assert.equal(ctx.maxAgeSec, MAX_PRICE_AGE_SEC)
  })

  test("a token first seen AFTER the main batch gets one supplementary batch (registration is an optimisation)", async () => {
    const fetchImpl = fakeFetch(routes)
    const ctx = createCycleQuoteContext({ chainId: BASE, publicClient: fakeClient(), v3Address: "", fetchImpl, now: () => NOW, env: {} })
    ctx.registerTokens([WETH_BASE])
    await ctx.legQuotes(WETH_BASE)
    const usdc = await ctx.legQuotes(USDC_BASE)
    await ctx.legQuotes(USDC_BASE) // memoized — no third batch
    assert.deepEqual(usdc.map((q) => q.source), ["defillama"])
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("llama.fi")).length, 2)
  })

  test("MAX_PRICE_AGE_SEC env override (by name) tightens the gate; COINGECKO_API_KEY is read from env", async () => {
    const fetchImpl = fakeFetch(routes)
    const ctx = createCycleQuoteContext({ chainId: BASE, publicClient: fakeClient(), v3Address: "", fetchImpl, now: () => NOW, env: { MAX_PRICE_AGE_SEC: "30", COINGECKO_API_KEY: "demo" } })
    const weth = await ctx.legQuotes(WETH_BASE)
    assert.equal(ctx.maxAgeSec, 30)
    assert.deepEqual(weth.map((q) => q.source), ["defillama"], "CoinGecko's 40 s-old row is now stale ⇒ absent")
    assert.deepEqual(fetchImpl.calls.find((c) => c.url.includes("coingecko")).init.headers, { "x-cg-demo-api-key": "demo" })
  })

  test("every source down ⇒ an empty quote list (the quorum turns that into a SKIP), never a throw", async () => {
    const ctx = createCycleQuoteContext({ chainId: BASE, publicClient: fakeClient({ registryThrows: true }), v3Address: V3, fetchImpl: fakeFetch(() => new Error("down")), now: () => NOW, env: {} })
    assert.deepEqual(await ctx.legQuotes(WETH_BASE), [])
    assert.deepEqual(await ctx.legQuotes("junk"), [])
  })
})
