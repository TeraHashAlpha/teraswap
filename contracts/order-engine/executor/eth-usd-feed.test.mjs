/**
 * [FIX-KEEPER-ETH-USD-FEED-CHAINAWARE] eth-usd-feed.js — chain-aware, fail-closed ETH/USD
 * aggregator resolution.
 *
 * The keeper hardcoded the MAINNET aggregator as the default on every chain. readEthUsd feeds
 * fetchReferencePriceUsd — the ETH leg of the DCA Phase-0 oracle floor (order-floor.js) — so on a
 * non-mainnet chain with ETH_USD_FEED unset the keeper read a CODELESS address and the ETH leg
 * silently lost its Chainlink-first price. These tests pin the three properties that close it:
 *
 *   1. env still wins, verbatim (prod is byte-identical: Base's .env.executor sets ETH_USD_FEED);
 *   2. an unset env resolves the CHAIN's aggregator, from the app's source of truth;
 *   3. an unknown chain resolves to NULL — fail-closed, never another chain's feed.
 *
 * The DRIFT GUARD is the important one: the keeper is a standalone Node package and cannot import
 * the app's TypeScript, so the addresses are mirrored. This suite parses
 * src/lib/chains/chainlink-feeds.ts (and constants.ts for mainnet) and fails the moment the two
 * disagree — the mirror can never rot silently. No address is typed in this file.
 *
 * Run: node --test contracts/order-engine/executor/eth-usd-feed.test.mjs
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { resolveEthUsdFeed, ETH_USD_FEED_BY_CHAIN, MAINNET_CHAIN_ID } from "./eth-usd-feed.js"

const BASE = 8453
const ARBITRUM = 42161

const feedsSource = readFileSync(new URL("../../../src/lib/chains/chainlink-feeds.ts", import.meta.url), "utf-8")
const constantsSource = readFileSync(new URL("../../../src/lib/constants.ts", import.meta.url), "utf-8")

/**
 * Pull `CHAINLINK_FEEDS_BY_CHAIN[chainId]`'s ETH/USD aggregator straight out of the TS source.
 * Structural, not positional: find the chain's block, then the first `'0xtoken': '0xfeed'` pair
 * whose preceding comment line names ETH/USD (both blocks document the WETH row that way). No
 * token or feed address is written here, so a drifted mirror can only fail, never falsely pass.
 */
function ethUsdFeedFromAppSource(chainId) {
  const blockStart = feedsSource.indexOf(`\n  ${chainId}: {`)
  assert.notEqual(blockStart, -1, `chainlink-feeds.ts has no CHAINLINK_FEEDS_BY_CHAIN[${chainId}] block`)
  const blockEnd = feedsSource.indexOf("\n  },", blockStart)
  assert.notEqual(blockEnd, -1, `could not find the end of the ${chainId} block`)
  const block = feedsSource.slice(blockStart, blockEnd)

  const lines = block.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/.*ETH\s*\/\s*USD/.test(lines[i])) continue
    const entry = lines.slice(i + 1).find((l) => /'0x[0-9a-fA-F]{40}'\s*:\s*'0x[0-9a-fA-F]{40}'/.test(l))
    if (entry) return entry.match(/:\s*'(0x[0-9a-fA-F]{40})'/)[1]
  }
  assert.fail(`no ETH/USD-commented entry found in CHAINLINK_FEEDS_BY_CHAIN[${chainId}]`)
}

describe("DRIFT GUARD — the keeper's map must equal the app's source of truth", () => {
  test("mainnet (1) matches constants.ts CHAINLINK_ETH_USD", () => {
    // chainlink-feeds.ts routes chainId 1 + WETH straight to CHAINLINK_ETH_USD (getChainlinkFeed).
    const m = constantsSource.match(/export const CHAINLINK_ETH_USD = '(0x[0-9a-fA-F]{40})'/)
    assert.ok(m, "constants.ts no longer exports CHAINLINK_ETH_USD in the expected shape")
    assert.equal(ETH_USD_FEED_BY_CHAIN[MAINNET_CHAIN_ID].toLowerCase(), m[1].toLowerCase())
  })

  test("Base (8453) matches chainlink-feeds.ts CHAINLINK_FEEDS_BY_CHAIN[8453] WETH → ETH/USD", () => {
    assert.equal(ETH_USD_FEED_BY_CHAIN[BASE].toLowerCase(), ethUsdFeedFromAppSource(BASE).toLowerCase())
  })

  test("Arbitrum (42161) matches chainlink-feeds.ts CHAINLINK_FEEDS_BY_CHAIN[42161] WETH → ETH/USD", () => {
    assert.equal(ETH_USD_FEED_BY_CHAIN[ARBITRUM].toLowerCase(), ethUsdFeedFromAppSource(ARBITRUM).toLowerCase())
  })

  test("every mirrored value is a well-formed address, and no two chains share one", () => {
    const values = Object.values(ETH_USD_FEED_BY_CHAIN)
    for (const v of values) assert.match(v, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(new Set(values.map((v) => v.toLowerCase())).size, values.length, "two chains share a feed address")
  })
})

describe("resolveEthUsdFeed — an explicit ETH_USD_FEED still wins (prod byte-identical)", () => {
  test("env overrides the chain default on every chain", () => {
    const custom = "0x1234567890abcdef1234567890abcdef12345678"
    for (const chainId of [MAINNET_CHAIN_ID, BASE, ARBITRUM, 999999]) {
      const r = resolveEthUsdFeed({ chainId, envFeed: custom })
      assert.equal(r.feed, custom, `chain ${chainId} must honour the env override`)
      assert.equal(r.source, "env")
    }
  })

  test("the env value is passed through VERBATIM — no normalising, no validation added", () => {
    // Pre-fix the value went straight into getAddress(); an odd operator value must keep failing
    // exactly where it failed before, not be silently rewritten or rejected earlier.
    const odd = "  0xNOT_AN_ADDRESS  "
    assert.equal(resolveEthUsdFeed({ chainId: BASE, envFeed: odd }).feed, odd)
  })

  test("an EMPTY env string is treated as unset, matching the `||` the keeper used before", () => {
    const r = resolveEthUsdFeed({ chainId: BASE, envFeed: "" })
    assert.equal(r.source, "chain-default")
    assert.equal(r.feed, ETH_USD_FEED_BY_CHAIN[BASE])
  })
})

describe("resolveEthUsdFeed — unset env resolves the CHAIN's aggregator", () => {
  test("Base (8453) unset ⇒ the Base ETH/USD feed, NOT the mainnet one (the bug this closes)", () => {
    const r = resolveEthUsdFeed({ chainId: BASE, envFeed: undefined })
    assert.equal(r.source, "chain-default")
    assert.equal(r.feed, ETH_USD_FEED_BY_CHAIN[BASE])
    assert.notEqual(r.feed.toLowerCase(), ETH_USD_FEED_BY_CHAIN[MAINNET_CHAIN_ID].toLowerCase())
  })

  test("Arbitrum (42161) unset ⇒ the Arbitrum ETH/USD feed, NOT the mainnet one", () => {
    const r = resolveEthUsdFeed({ chainId: ARBITRUM, envFeed: undefined })
    assert.equal(r.source, "chain-default")
    assert.equal(r.feed, ETH_USD_FEED_BY_CHAIN[ARBITRUM])
    assert.notEqual(r.feed.toLowerCase(), ETH_USD_FEED_BY_CHAIN[MAINNET_CHAIN_ID].toLowerCase())
  })

  test("mainnet (1) unset ⇒ the SAME address the keeper hardcoded before this fix", () => {
    const r = resolveEthUsdFeed({ chainId: MAINNET_CHAIN_ID, envFeed: undefined })
    assert.equal(r.source, "chain-default")
    // Byte-identical to the pre-fix `|| "0x5f4e…8419"` tail, sourced from constants.ts.
    const legacy = constantsSource.match(/export const CHAINLINK_ETH_USD = '(0x[0-9a-fA-F]{40})'/)[1]
    assert.equal(r.feed, legacy)
  })

  test("a string chainId is coerced (CHAIN_ID is env-shaped)", () => {
    assert.equal(resolveEthUsdFeed({ chainId: "8453", envFeed: undefined }).feed, ETH_USD_FEED_BY_CHAIN[BASE])
  })
})

describe("resolveEthUsdFeed — FAIL-CLOSED on an unknown chain (never a wrong address)", () => {
  test("an unmodeled chain resolves to null, not to mainnet's feed", () => {
    const r = resolveEthUsdFeed({ chainId: 10, envFeed: undefined }) // Optimism — no entry
    assert.equal(r.feed, null)
    assert.equal(r.source, "none")
  })

  test("the null case NEVER leaks another chain's address", () => {
    for (const chainId of [10, 137, 56, 999999, NaN, undefined]) {
      const r = resolveEthUsdFeed({ chainId, envFeed: undefined })
      assert.equal(r.feed, null, `chain ${chainId} must not resolve a feed`)
      for (const known of Object.values(ETH_USD_FEED_BY_CHAIN)) {
        assert.ok(!String(r.reason).includes(known), "the reason must not suggest a concrete address")
      }
    }
  })

  test("the reason names the fix, so the degraded state is diagnosable from one log line", () => {
    const r = resolveEthUsdFeed({ chainId: 10, envFeed: undefined })
    assert.match(r.reason, /ETH_USD_FEED/)
    assert.match(r.reason, /DefiLlama/)
  })
})

describe("resolveEthUsdFeed — pure/deterministic (mirrors submission-policy.js's contract)", () => {
  test("repeated calls are identical and never throw", () => {
    const args = { chainId: BASE, envFeed: undefined }
    const first = resolveEthUsdFeed(args)
    for (let i = 0; i < 25; i++) assert.deepEqual(resolveEthUsdFeed(args), first)
  })

  test("reads no env of its own — process.env.ETH_USD_FEED is ignored unless PASSED IN", () => {
    const saved = process.env.ETH_USD_FEED
    try {
      process.env.ETH_USD_FEED = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      const r = resolveEthUsdFeed({ chainId: BASE, envFeed: undefined })
      assert.equal(r.source, "chain-default", "the module must not read process.env itself")
    } finally {
      if (saved === undefined) delete process.env.ETH_USD_FEED
      else process.env.ETH_USD_FEED = saved
    }
  })
})

describe("executor.js wiring — the resolution is actually used, and fails closed at the read", () => {
  const executorSource = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")

  test("ETH_USD_FEED comes from resolveEthUsdFeed(CHAIN_ID, process.env.ETH_USD_FEED)", () => {
    assert.match(
      executorSource,
      /resolveEthUsdFeed\(\{ chainId: CHAIN_ID, envFeed: process\.env\.ETH_USD_FEED \}\)/,
    )
    assert.match(executorSource, /const ETH_USD_FEED = ETH_USD_FEED_RESOLUTION\.feed/)
  })

  test("the hardcoded mainnet fallback tail is GONE from executor.js", () => {
    const legacy = constantsSource.match(/export const CHAINLINK_ETH_USD = '(0x[0-9a-fA-F]{40})'/)[1]
    assert.ok(
      !executorSource.toLowerCase().includes(legacy.toLowerCase()),
      "executor.js must no longer hardcode the mainnet aggregator — it lives in eth-usd-feed.js now",
    )
  })

  test("readEthUsd short-circuits on a null feed instead of calling getAddress(null)", () => {
    const fn = executorSource.match(/async function readEthUsd\(publicClient\) \{([\s\S]*?)\n\}/)
    assert.ok(fn, "could not locate readEthUsd")
    assert.match(fn[1], /if \(!ETH_USD_FEED\) \{/)
    const guardEnd = fn[1].indexOf("try {")
    assert.ok(fn[1].slice(0, guardEnd).includes("return null"), "the guard must return before any read")
  })

  test("the reference-price fallback semantics are untouched (fetchReferencePriceUsd still fail-safe)", () => {
    // readEthUsd returning null is the pre-existing path: fall through to DefiLlama, and for the
    // ETH leg classify a miss as TRANSIENT. This fix must not have altered either.
    assert.match(executorSource, /const eth = await readEthUsd\(publicClient\)\n\s*if \(eth != null\) return \{ price: eth, transient: false \}/)
    assert.match(executorSource, /return \{ price: null, transient: ethPriced \}/)
  })
})
