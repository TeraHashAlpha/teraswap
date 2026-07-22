/**
 * [FIX-KEEPER-GAS-TIER-BASE] gas-tier.js — per-chain gas-tier resolution.
 *
 * FILL-ECONOMICS-CALIBRATION.md (2026-07-22/23) measured that the two real OE_V3 fills cost
 * ~$3.90 each not from L1 data fees (0.0004% of cost — noise under Base's blob DA pricing) but
 * from the keeper's PRIORITY_FEE_NORMAL = 1.5 gwei, mainnet-calibrated with no Base override,
 * against a live Base gas price of ~0.005-0.006 gwei — a ~250x overpayment. This module makes
 * the tiers per-chain: mainnet stays byte-identical (its env vars are unsuffixed, unchanged),
 * Base gets its own much lower thresholds/priority fees derived from that calibration.
 *
 * Never imports executor.js (which auto-runs main() on import) — this module is pure.
 *
 * Run: node --test contracts/order-engine/executor/gas-tier.test.mjs
 */
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  getGasTierConfig,
  resolveGasTier,
  MAINNET_CHAIN_ID,
  BASE_CHAIN_ID,
} from "./gas-tier.js"

const ENV_KEYS = [
  "GAS_TIER_NORMAL_GWEI", "GAS_TIER_ELEVATED_GWEI", "GAS_TIER_URGENT_GWEI",
  "GAS_PRIORITY_NORMAL_GWEI", "GAS_PRIORITY_ELEVATED_GWEI", "GAS_PRIORITY_URGENT_GWEI",
  "GAS_BASEFEE_MULT_NORMAL", "GAS_BASEFEE_MULT_ELEVATED", "GAS_BASEFEE_MULT_URGENT",
  "GAS_TIER_NORMAL_GWEI_BASE", "GAS_TIER_ELEVATED_GWEI_BASE", "GAS_TIER_URGENT_GWEI_BASE",
  "GAS_PRIORITY_NORMAL_GWEI_BASE", "GAS_PRIORITY_ELEVATED_GWEI_BASE", "GAS_PRIORITY_URGENT_GWEI_BASE",
  "GAS_BASEFEE_MULT_NORMAL_BASE", "GAS_BASEFEE_MULT_ELEVATED_BASE", "GAS_BASEFEE_MULT_URGENT_BASE",
]
let savedEnv
beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const gwei = (n) => BigInt(Math.round(n * 1e9))

describe("getGasTierConfig — mainnet is BYTE-IDENTICAL to the pre-fix defaults", () => {
  test("thresholds match the original hardcoded 30/80/100 gwei", () => {
    const cfg = getGasTierConfig(MAINNET_CHAIN_ID)
    assert.equal(cfg.thresholdsGwei.NORMAL, 30)
    assert.equal(cfg.thresholdsGwei.ELEVATED, 80)
    assert.equal(cfg.thresholdsGwei.URGENT, 100)
  })

  test("priority fees match the original 1.5/2.5/4 gwei (the values the calibration measured)", () => {
    const cfg = getGasTierConfig(MAINNET_CHAIN_ID)
    assert.equal(cfg.priorityFeeGwei.NORMAL, 1.5)
    assert.equal(cfg.priorityFeeGwei.ELEVATED, 2.5)
    assert.equal(cfg.priorityFeeGwei.URGENT, 4)
  })

  test("base-fee multipliers match the original 2/2.5/3", () => {
    const cfg = getGasTierConfig(MAINNET_CHAIN_ID)
    assert.equal(cfg.baseFeeMult.NORMAL, 2)
    assert.equal(cfg.baseFeeMult.ELEVATED, 2.5)
    assert.equal(cfg.baseFeeMult.URGENT, 3)
  })

  test("still reads the SAME unsuffixed env vars as before this fix (no operator config break)", () => {
    process.env.GAS_TIER_NORMAL_GWEI = "42"
    process.env.GAS_PRIORITY_NORMAL_GWEI = "9.9"
    process.env.GAS_BASEFEE_MULT_URGENT = "7"
    const cfg = getGasTierConfig(MAINNET_CHAIN_ID)
    assert.equal(cfg.thresholdsGwei.NORMAL, 42)
    assert.equal(cfg.priorityFeeGwei.NORMAL, 9.9)
    assert.equal(cfg.baseFeeMult.URGENT, 7)
  })
})

describe("getGasTierConfig — Base (8453) is derived from the calibration, far below mainnet", () => {
  test("Base priority fees are dramatically lower than mainnet's — never 1.5 gwei again", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    assert.ok(cfg.priorityFeeGwei.NORMAL < 1.5, "Base NORMAL priority must be far below the mainnet default")
    assert.ok(cfg.priorityFeeGwei.NORMAL > 0, "must still be positive — zero priority risks never being included")
  })

  test("Base thresholds are scaled down — the calibration's measured ~0.005-0.006 gwei floor must sit BELOW Base NORMAL", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    assert.ok(cfg.thresholdsGwei.NORMAL < 30, "a mainnet-scaled 30 gwei threshold would never trigger on Base")
    assert.ok(0.006 < cfg.thresholdsGwei.NORMAL, "the live-measured Base gas price must still resolve to the NORMAL tier, not SKIP")
  })

  test("Base tier ordering is strictly increasing (NORMAL < ELEVATED < URGENT)", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    assert.ok(cfg.thresholdsGwei.NORMAL < cfg.thresholdsGwei.ELEVATED)
    assert.ok(cfg.thresholdsGwei.ELEVATED < cfg.thresholdsGwei.URGENT)
  })

  test("Base config is independently overridable via _BASE-suffixed env vars", () => {
    process.env.GAS_PRIORITY_NORMAL_GWEI_BASE = "0.11"
    process.env.GAS_TIER_URGENT_GWEI_BASE = "0.99"
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    assert.equal(cfg.priorityFeeGwei.NORMAL, 0.11)
    assert.equal(cfg.thresholdsGwei.URGENT, 0.99)
  })

  test("overriding Base env vars does NOT affect mainnet's config (independent per-chain)", () => {
    process.env.GAS_PRIORITY_NORMAL_GWEI_BASE = "0.11"
    const mainnetCfg = getGasTierConfig(MAINNET_CHAIN_ID)
    assert.equal(mainnetCfg.priorityFeeGwei.NORMAL, 1.5)
  })
})

describe("getGasTierConfig — unknown chains fail closed to mainnet (never to Base's low values)", () => {
  test("an unconfigured chain resolves to the mainnet config — safe (higher gas), never stuck", () => {
    const cfg = getGasTierConfig(42161) // Arbitrum — no gas-tier entry yet
    assert.equal(cfg.priorityFeeGwei.NORMAL, 1.5)
    assert.equal(cfg.thresholdsGwei.NORMAL, 30)
  })
})

describe("resolveGasTier — mainnet regression (byte-identical outcomes to the pre-fix function)", () => {
  test("NORMAL tier: gas price under 30 gwei executes at 1.5 gwei priority", () => {
    const r = resolveGasTier({
      chainId: MAINNET_CHAIN_ID, currentGasPriceWei: gwei(20), baseFeeWei: gwei(15), urgency: "NORMAL",
    })
    assert.equal(r.execute, true)
    assert.equal(r.tier, "NORMAL")
    assert.equal(r.maxPriorityFeePerGas, gwei(1.5))
    assert.equal(r.maxFeePerGas, gwei(15) * 2n + gwei(1.5))
  })

  test("ELEVATED band + NORMAL urgency ⇒ deferred (not executed, not failed)", () => {
    const r = resolveGasTier({
      chainId: MAINNET_CHAIN_ID, currentGasPriceWei: gwei(50), baseFeeWei: gwei(40), urgency: "NORMAL",
    })
    assert.equal(r.execute, false)
    assert.equal(r.tier, "ELEVATED")
  })

  test("ELEVATED band + URGENT urgency ⇒ executes at 2.5 gwei priority", () => {
    const r = resolveGasTier({
      chainId: MAINNET_CHAIN_ID, currentGasPriceWei: gwei(50), baseFeeWei: gwei(40), urgency: "URGENT",
    })
    assert.equal(r.execute, true)
    assert.equal(r.tier, "ELEVATED")
    assert.equal(r.maxPriorityFeePerGas, gwei(2.5))
  })

  test("above 100 gwei ⇒ SKIP regardless of urgency", () => {
    const r = resolveGasTier({
      chainId: MAINNET_CHAIN_ID, currentGasPriceWei: gwei(150), baseFeeWei: gwei(140), urgency: "URGENT",
    })
    assert.equal(r.execute, false)
    assert.equal(r.tier, "SKIP")
  })
})

describe("resolveGasTier — Base at the calibration's measured live gas price", () => {
  test("Base at ~0.006 gwei (the calibration's live reading) executes at the Base NORMAL priority", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    const r = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(0.006), baseFeeWei: gwei(0.005), urgency: "NORMAL",
    })
    assert.equal(r.execute, true)
    assert.equal(r.tier, "NORMAL")
    assert.equal(r.maxPriorityFeePerGas, gwei(cfg.priorityFeeGwei.NORMAL))
  })

  test("REGRESSION: Base priority fee is NEVER the mainnet 1.5 gwei value again", () => {
    const r = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(0.006), baseFeeWei: gwei(0.005), urgency: "NORMAL",
    })
    assert.notEqual(r.maxPriorityFeePerGas, gwei(1.5))
    assert.ok(r.maxPriorityFeePerGas <= gwei(getGasTierConfig(BASE_CHAIN_ID).thresholdsGwei.URGENT))
  })

  test("REGRESSION: every Base tier's resolved priority fee stays <= the Base URGENT ceiling", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    const ceilingWei = gwei(cfg.priorityFeeGwei.URGENT)
    for (const urgency of ["NORMAL", "ELEVATED", "URGENT"]) {
      for (const priceGwei of [0.001, 0.01, 0.1, 0.29]) {
        const r = resolveGasTier({
          chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(priceGwei), baseFeeWei: gwei(priceGwei * 0.8), urgency,
        })
        if (r.execute) {
          assert.ok(
            r.maxPriorityFeePerGas <= ceilingWei,
            `urgency=${urgency} price=${priceGwei}gwei priority=${r.maxPriorityFeePerGas} exceeds Base ceiling ${ceilingWei}`,
          )
        }
      }
    }
  })

  test("a mainnet-scale gas price (30 gwei) on Base resolves to SKIP (Base thresholds are real ceilings, not decorative)", () => {
    const r = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(30), baseFeeWei: gwei(25), urgency: "URGENT",
    })
    assert.equal(r.execute, false)
    assert.equal(r.tier, "SKIP")
  })

  test("Base ELEVATED band + NORMAL urgency defers exactly like mainnet's shape (never fails, never executes)", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    const midElevated = (cfg.thresholdsGwei.NORMAL + cfg.thresholdsGwei.ELEVATED) / 2
    const r = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(midElevated), baseFeeWei: gwei(midElevated * 0.8), urgency: "NORMAL",
    })
    assert.equal(r.execute, false)
    assert.equal(r.tier, "ELEVATED")
  })
})

describe("resolveGasTier — cost-scenario regression tying back to the calibration's headline numbers", () => {
  test("the SAME aggregator gas (1,364,707) at Base's new NORMAL tier costs cents, not dollars", () => {
    const cfg = getGasTierConfig(BASE_CHAIN_ID)
    const r = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(0.006), baseFeeWei: gwei(0.005), urgency: "NORMAL",
    })
    const AGGREGATOR_GAS = 1_364_707n
    const effectiveGasPriceWei = r.maxPriorityFeePerGas + gwei(0.005) // priority + observed baseFee (no congestion)
    const costWei = AGGREGATOR_GAS * effectiveGasPriceWei
    const costEth = Number(costWei) / 1e18
    // The calibration's real fill cost $3.93 at the OLD 1.505 gwei effective price. At any
    // Base NORMAL-tier price this must be at least an order of magnitude cheaper.
    assert.ok(costEth < 0.0002, `expected << the old 0.00205 ETH fee, got ${costEth}`)
  })
})
