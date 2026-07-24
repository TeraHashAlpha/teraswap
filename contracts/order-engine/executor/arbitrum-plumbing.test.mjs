/**
 * [SPRINT-KEEPER-MULTICHAIN-ARBITRUM 3/3] Chain-plumbing + dark-safety proof for CHAIN_ID=42161.
 *
 * The keeper is already CHAIN_ID-parameterized, so serving Arbitrum One is mostly a matter of
 * CONFIRMING each chain-dependent path resolves for 42161 rather than rewriting them. This file
 * is that confirmation, plus the two guards that make it durable:
 *
 *   1. MANIFEST PINNING. Every Arbitrum address the keeper hardcodes must equal the value in
 *      docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json (each entry eth_getCode / description /
 *      decimals-verified on two independent RPCs). A hand-typed or drifted hex fails here rather
 *      than mis-routing funds on-chain. executor.js cannot be imported (it calls main() at module
 *      load), so its literals are asserted against the file's SOURCE — the only way to pin them
 *      without booting a keeper.
 *   2. DARK-STATE REGRESSION. This sprint ships DARK: no OrderExecutorV3 is deployed on Arbitrum,
 *      so ORDER_EXECUTOR_V3_ADDRESS is unset for a 42161 instance. The v3 order MUST then take the
 *      submission-blocked path (skipped + flagged + left active), never fall back to the v2
 *      contract. That property is what makes shipping this before the deploy safe.
 *
 * Run: node --test contracts/order-engine/executor/arbitrum-plumbing.test.mjs
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { sourceForRouter } from "./swap-route.js"
import { resolveExecutorRouting } from "./executor-routing.js"
import { resolveGasTier, getGasTierConfig, assertTierOrdering, ARBITRUM_CHAIN_ID } from "./gas-tier.js"
import { resolveSubmissionPolicy } from "./submission-policy.js"

const ARBITRUM_ONE = 42161

const manifest = JSON.parse(
  readFileSync(new URL("../../../docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json", import.meta.url), "utf-8"),
)
/** key -> address, straight from the manifest. Never re-typed anywhere in this file. */
const MANIFEST = Object.fromEntries(manifest.entries.map((e) => [e.key, e.address]))

const executorSource = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
const swapRouteSource = readFileSync(new URL("./swap-route.js", import.meta.url), "utf-8")

/** Case-insensitive "this source file contains this address" (checksummed vs lowercased). */
function containsAddress(source, address) {
  return source.toLowerCase().includes(address.toLowerCase())
}

describe("manifest sanity — the pin is only as good as what it pins", () => {
  test("every manifest entry used below is present and verified ok on both RPCs", () => {
    for (const key of ["WETH", "ETH/USD", "router:uniswapv3", "router:velora"]) {
      const entry = manifest.entries.find((e) => e.key === key)
      assert.ok(entry, `manifest is missing entry '${key}'`)
      assert.equal(entry.ok, true, `manifest entry '${key}' is not verified ok`)
      assert.match(entry.address, /^0x[0-9a-fA-F]{40}$/, `manifest entry '${key}' is not an address`)
    }
    assert.ok(manifest.rpcs.length >= 2, "manifest must have been cross-checked on >= 2 RPCs")
  })
})

describe("order query + RPC client are CHAIN_ID-parameterized (nothing to add for 42161)", () => {
  test("the active-order query filters on chain_id, so a 42161 instance only ever sees 42161 orders", () => {
    assert.match(executorSource, /orders\?status=eq\.active&chain_id=eq\.\$\{CHAIN_ID\}/)
  })

  test("the lock + stale-unlock queries are chain-scoped too (no cross-chain order theft between instances)", () => {
    assert.match(executorSource, /orders\?id=eq\.\$\{orderId\}&status=eq\.active&chain_id=eq\.\$\{CHAIN_ID\}/)
    assert.match(executorSource, /orders\?status=eq\.executing&chain_id=eq\.\$\{CHAIN_ID\}/)
  })

  test("the viem chain object takes its id from CHAIN_ID and its RPC from RPC_URL (per-instance, no hardcoded chain)", () => {
    assert.match(executorSource, /id:\s*CHAIN_ID/)
    assert.match(executorSource, /rpcUrls:\s*\{\s*default:\s*\{\s*http:\s*\[RPC_URL/)
  })

  test("CHAIN_ID is read from env with the mainnet default (an Arbitrum instance is pure config)", () => {
    assert.match(executorSource, /const CHAIN_ID = parseInt\(process\.env\.CHAIN_ID \|\| "1"\)/)
  })
})

describe("oracle floor resolves for 42161", () => {
  test("DefiLlama has an 'arbitrum' slug for 42161 — without it every non-ETH leg would read FEEDLESS", () => {
    assert.match(executorSource, /const DEFILLAMA_CHAIN_SLUG = \{[^}]*42161:\s*"arbitrum"/)
  })

  test("mainnet + Base slugs are untouched", () => {
    assert.match(executorSource, /const DEFILLAMA_CHAIN_SLUG = \{ 1: "ethereum", 8453: "base", 42161: "arbitrum" \}/)
  })

  test("Arbitrum WETH is Chainlink-first priced, and its address is the manifest's", () => {
    // Arbitrum does NOT reuse the OP-stack 0x42..06 WETH predeploy, so the leg needs its own entry.
    assert.ok(
      containsAddress(executorSource, MANIFEST.WETH),
      `executor.js must list the manifest's Arbitrum WETH (${MANIFEST.WETH}) in ETH_PRICED_ADDRESSES`,
    )
    const ethPricedBlock = executorSource.match(/const ETH_PRICED_ADDRESSES = new Set\(([\s\S]*?)\)\n/)
    assert.ok(ethPricedBlock, "could not locate ETH_PRICED_ADDRESSES")
    assert.ok(containsAddress(ethPricedBlock[1], MANIFEST.WETH), "Arbitrum WETH must be INSIDE ETH_PRICED_ADDRESSES")
  })

  test("the 42161 ETH/USD aggregator default is the manifest's Arbitrum feed, not the mainnet one", () => {
    const feedBlock = executorSource.match(/const ETH_USD_FEED_BY_CHAIN = \{([\s\S]*?)\}/)
    assert.ok(feedBlock, "could not locate ETH_USD_FEED_BY_CHAIN")
    assert.ok(
      containsAddress(feedBlock[1], MANIFEST["ETH/USD"]),
      `the 42161 ETH/USD default must be the manifest's ${MANIFEST["ETH/USD"]}`,
    )
    assert.match(feedBlock[1], /42161:/)
  })

  test("an explicit ETH_USD_FEED env var still wins over the per-chain default", () => {
    assert.match(
      executorSource,
      /process\.env\.ETH_USD_FEED \|\|\s*ETH_USD_FEED_BY_CHAIN\[CHAIN_ID\] \|\|/,
    )
  })

  test("BYTE-IDENTICAL 1/8453: neither chain has a per-chain feed entry, so both keep the mainnet default", () => {
    const feedBlock = executorSource.match(/const ETH_USD_FEED_BY_CHAIN = \{([\s\S]*?)\}/)[1]
    assert.ok(!/(^|[^0-9])1:/.test(feedBlock), "chain 1 must have no entry (it already defaults to its own feed)")
    assert.ok(!/8453:/.test(feedBlock), "chain 8453 must have no entry — changing Base's default is out of scope")
    assert.match(executorSource, /"0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"/)
  })
})

describe("routing — the committed order.router maps to an /api/swap source on 42161", () => {
  test("Arbitrum Uniswap SwapRouter02 (manifest) → uniswapv3", () => {
    assert.equal(sourceForRouter(MANIFEST["router:uniswapv3"]), "uniswapv3")
    assert.equal(sourceForRouter(MANIFEST["router:uniswapv3"].toLowerCase()), "uniswapv3")
  })

  test("Arbitrum Velora Augustus V6.2 (manifest) → velora, via the entry Base already had", () => {
    // Velora deploys Augustus at the SAME address on Base and Arbitrum, and ROUTER_SOURCE is keyed
    // by (globally unique) address — so this resolves with no new row, and must NOT be duplicated.
    assert.equal(sourceForRouter(MANIFEST["router:velora"]), "velora")
    const occurrences = swapRouteSource.toLowerCase().split(MANIFEST["router:velora"].toLowerCase()).length - 1
    assert.equal(occurrences, 1, "the Augustus address must appear exactly once in ROUTER_SOURCE")
  })

  test("both Arbitrum router literals in swap-route.js come from the manifest", () => {
    for (const key of ["router:uniswapv3", "router:velora"]) {
      assert.ok(containsAddress(swapRouteSource, MANIFEST[key]), `swap-route.js is missing manifest ${key}`)
    }
  })

  test("BYTE-IDENTICAL: the mainnet + Base rows still resolve exactly as before", () => {
    assert.equal(sourceForRouter("0x2626664c2603336E57B271c5C0b26F421741e481"), "uniswapv3") // Base SwapRouter02
    assert.equal(sourceForRouter("0x111111125421cA6dc452d289314280a0f8842A65"), "1inch")     // mainnet 1inch v6
    assert.equal(sourceForRouter("0xdef1c0ded9bec7f1a1670819833240f027b25eff"), "0x")        // mainnet 0x proxy
  })

  test("an Arbitrum router the keeper does NOT map still returns null (skip, never mis-route)", () => {
    // e.g. Odos on Arbitrum is in the manifest but is not a keeper-supported /api/swap source.
    assert.equal(sourceForRouter(MANIFEST["router:odos"]), null)
  })
})

describe("gas tier + submission compose for 42161 (commits 1+2 seen from the executor's angle)", () => {
  test("assertTierOrdering(42161) passes, so a 42161 keeper boots instead of throwing", () => {
    assert.doesNotThrow(() => assertTierOrdering(ARBITRUM_CHAIN_ID))
    assert.equal(ARBITRUM_CHAIN_ID, ARBITRUM_ONE)
  })

  test("a quiet-market Arbitrum fill executes NORMAL rather than deferring forever", () => {
    const r = resolveGasTier({
      chainId: ARBITRUM_ONE,
      currentGasPriceWei: 10_000_000n, // 0.01 gwei — the ArbOS base-fee floor
      baseFeeWei: 10_000_000n,
      urgency: "NORMAL",
    })
    assert.equal(r.execute, true)
    assert.equal(r.tier, "NORMAL")
    assert.ok(r.maxPriorityFeePerGas > 0n, "a literal-0 tip risks node rejection ⇒ a deferred fill")
    // …and nowhere near the mainnet tip that caused the Base overpayment.
    const mainnetNormalTipWei = BigInt(Math.round(getGasTierConfig(1).priorityFeeGwei.NORMAL * 1e9))
    assert.ok(
      r.maxPriorityFeePerGas < mainnetNormalTipWei,
      `Arbitrum tip ${r.maxPriorityFeePerGas} must be far under mainnet's ${mainnetNormalTipWei}`,
    )
  })

  test("submission resolves sequencer-private with no relay configured — an Arbitrum keeper can fill", () => {
    const d = resolveSubmissionPolicy({ chainId: ARBITRUM_ONE, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
  })
})

// ── DARK STATE ───────────────────────────────────────────────────────────────
// The whole point of shipping this sprint before the Arbitrum deploy.
describe("DARK STATE: 42161 with ORDER_EXECUTOR_V3_ADDRESS unset stays submission-blocked", () => {
  const v3OrderData = { owner: "0x0", maxSlippageBps: 100 } // maxSlippageBps ⇒ v3-signed
  const v2Address = "0x1111111111111111111111111111111111111111"

  test("a v3 order on a keeper with no v3 address is REFUSED, not executed", () => {
    // Mirrors executor.js exactly: V3_CONTRACT_ADDRESS = process.env.ORDER_EXECUTOR_V3_ADDRESS || ""
    const v3Address = process.env.ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM_UNSET_FIXTURE || ""
    const routing = resolveExecutorRouting({
      orderData: v3OrderData, v2Address, v2Abi: [], v3Address, v3Abi: [],
    })
    assert.equal(routing.ok, false, "a v3 order must NOT execute while Arbitrum is dark")
    assert.equal(routing.execAddress, null)
  })

  test("it is never mis-routed to the v2 contract (wrong typehash ⇒ silent loss of maxSlippageBps)", () => {
    const routing = resolveExecutorRouting({
      orderData: v3OrderData, v2Address, v2Abi: [], v3Address: "", v3Abi: [],
    })
    assert.notEqual(routing.execAddress, v2Address)
    assert.equal(routing.isV3, true)
  })

  test("executor.js's !routing.ok branch flags it as 'submission-blocked' and leaves the order ACTIVE", () => {
    // The dark state must be RECOVERABLE: the order is unlocked back to 'active' and retried once
    // the executor is deployed — never marked failed, never dropped.
    assert.match(executorSource, /kind: "submission-blocked"/)
    assert.match(executorSource, /ORDER_EXECUTOR_V3_ADDRESS is unset for chain \$\{CHAIN_ID\}/)
    const blockedBranch = executorSource.match(/if \(!routing\.ok\) \{([\s\S]*?)\n      \}/)
    assert.ok(blockedBranch, "could not locate the !routing.ok branch")
    assert.match(blockedBranch[1], /updateOrderStatus\(dbOrder\.id, "active"\)/)
    assert.ok(!/updateOrderStatus\([^)]*"failed"/.test(blockedBranch[1]), "dark state must never fail an order")
  })

  test("the same order DOES route once an Arbitrum v3 executor is configured (dark, not broken)", () => {
    const v3Address = "0x2222222222222222222222222222222222222222"
    const routing = resolveExecutorRouting({
      orderData: v3OrderData, v2Address, v2Abi: [], v3Address, v3Abi: [],
    })
    assert.equal(routing.ok, true)
    assert.equal(routing.execAddress, v3Address)
  })

  test("v2 orders are unaffected by the dark state on ANY chain (they never needed v3)", () => {
    const routing = resolveExecutorRouting({
      orderData: { owner: "0x0" }, v2Address, v2Abi: [], v3Address: "", v3Abi: [],
    })
    assert.equal(routing.ok, true)
    assert.equal(routing.isV3, false)
    assert.equal(routing.execAddress, v2Address)
  })
})
