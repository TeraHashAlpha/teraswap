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
  assertTierOrdering,
  MAINNET_CHAIN_ID,
  BASE_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
} from "./gas-tier.js"

const ENV_KEYS = [
  "GAS_TIER_NORMAL_GWEI", "GAS_TIER_ELEVATED_GWEI", "GAS_TIER_URGENT_GWEI",
  "GAS_PRIORITY_NORMAL_GWEI", "GAS_PRIORITY_ELEVATED_GWEI", "GAS_PRIORITY_URGENT_GWEI",
  "GAS_BASEFEE_MULT_NORMAL", "GAS_BASEFEE_MULT_ELEVATED", "GAS_BASEFEE_MULT_URGENT",
  "GAS_TIER_NORMAL_GWEI_BASE", "GAS_TIER_ELEVATED_GWEI_BASE", "GAS_TIER_URGENT_GWEI_BASE",
  "GAS_PRIORITY_NORMAL_GWEI_BASE", "GAS_PRIORITY_ELEVATED_GWEI_BASE", "GAS_PRIORITY_URGENT_GWEI_BASE",
  "GAS_BASEFEE_MULT_NORMAL_BASE", "GAS_BASEFEE_MULT_ELEVATED_BASE", "GAS_BASEFEE_MULT_URGENT_BASE",
  "GAS_TIER_NORMAL_GWEI_ARBITRUM", "GAS_TIER_ELEVATED_GWEI_ARBITRUM", "GAS_TIER_URGENT_GWEI_ARBITRUM",
  "GAS_PRIORITY_NORMAL_GWEI_ARBITRUM", "GAS_PRIORITY_ELEVATED_GWEI_ARBITRUM", "GAS_PRIORITY_URGENT_GWEI_ARBITRUM",
  "GAS_BASEFEE_MULT_NORMAL_ARBITRUM", "GAS_BASEFEE_MULT_ELEVATED_ARBITRUM", "GAS_BASEFEE_MULT_URGENT_ARBITRUM",
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

describe("getGasTierConfig — Arbitrum One (42161) [SPRINT-KEEPER-MULTICHAIN-ARBITRUM]", () => {
  test("priority fees are effectively ~0 — Nitro's sequencer is FCFS, a tip buys no inclusion", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    // Well under even Base's already-reduced 0.02 gwei NORMAL, and ~1500x under mainnet's 1.5.
    assert.ok(cfg.priorityFeeGwei.NORMAL < 0.01, "Arbitrum NORMAL priority must be ~0, not a Base-scale tip")
    assert.ok(cfg.priorityFeeGwei.URGENT <= 0.01, "even URGENT must stay ~0 — there is no priority auction on Nitro")
  })

  test("priority fees stay strictly ABOVE zero (a literal-0 tip risks node rejection ⇒ deferred fill)", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    for (const k of ["NORMAL", "ELEVATED", "URGENT"]) {
      assert.ok(cfg.priorityFeeGwei[k] > 0, `${k} priority must be > 0`)
    }
  })

  test("REGRESSION: Arbitrum never inherits mainnet's 1.5 gwei priority fee (the Base overpayment bug, again)", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    assert.notEqual(cfg.priorityFeeGwei.NORMAL, 1.5)
    assert.notEqual(cfg.thresholdsGwei.NORMAL, 30)
  })

  test("thresholds sit ABOVE ArbOS's 0.01 gwei base-fee floor — a quiet-market fill resolves NORMAL, never SKIP", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    const ARBOS_MIN_BASE_FEE_GWEI = 0.01
    assert.ok(
      ARBOS_MIN_BASE_FEE_GWEI < cfg.thresholdsGwei.NORMAL,
      "the ArbOS floor must resolve to NORMAL — otherwise the keeper would SKIP every quiet-market fill",
    )
  })

  test("thresholds stay far BELOW mainnet's — mainnet's 30/80/100 gwei on an L2 would disable the gates entirely", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    assert.ok(cfg.thresholdsGwei.URGENT < 30, "the whole Arbitrum band must sit under mainnet's NORMAL threshold")
  })

  test("tier ordering is strictly increasing (assertTierOrdering passes at boot for 42161)", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    assert.ok(cfg.thresholdsGwei.NORMAL < cfg.thresholdsGwei.ELEVATED)
    assert.ok(cfg.thresholdsGwei.ELEVATED < cfg.thresholdsGwei.URGENT)
    assert.doesNotThrow(() => assertTierOrdering(ARBITRUM_CHAIN_ID))
  })

  test("base-fee multipliers are the conservative 2/2.5/3 shared with mainnet and Base", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    assert.equal(cfg.baseFeeMult.NORMAL, 2)
    assert.equal(cfg.baseFeeMult.ELEVATED, 2.5)
    assert.equal(cfg.baseFeeMult.URGENT, 3)
  })

  test("is independently overridable via _ARBITRUM-suffixed env vars", () => {
    process.env.GAS_PRIORITY_NORMAL_GWEI_ARBITRUM = "0.007"
    process.env.GAS_TIER_URGENT_GWEI_ARBITRUM = "2.5"
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    assert.equal(cfg.priorityFeeGwei.NORMAL, 0.007)
    assert.equal(cfg.thresholdsGwei.URGENT, 2.5)
  })

  test("overriding Arbitrum env vars leaves mainnet AND Base untouched (independent per-chain)", () => {
    process.env.GAS_PRIORITY_NORMAL_GWEI_ARBITRUM = "0.007"
    process.env.GAS_TIER_NORMAL_GWEI_ARBITRUM = "9"
    assert.equal(getGasTierConfig(MAINNET_CHAIN_ID).priorityFeeGwei.NORMAL, 1.5)
    assert.equal(getGasTierConfig(MAINNET_CHAIN_ID).thresholdsGwei.NORMAL, 30)
    assert.equal(getGasTierConfig(BASE_CHAIN_ID).priorityFeeGwei.NORMAL, 0.02)
    assert.equal(getGasTierConfig(BASE_CHAIN_ID).thresholdsGwei.NORMAL, 0.05)
  })
})

describe("resolveGasTier — Arbitrum at Nitro's real fee regime", () => {
  test("at the ArbOS 0.01 gwei floor: executes NORMAL at the Arbitrum ~0 priority fee", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    const r = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(0.01), baseFeeWei: gwei(0.01), urgency: "NORMAL",
    })
    assert.equal(r.execute, true)
    assert.equal(r.tier, "NORMAL")
    assert.equal(r.maxPriorityFeePerGas, gwei(cfg.priorityFeeGwei.NORMAL))
    assert.equal(r.maxFeePerGas, gwei(0.01) * 2n + gwei(cfg.priorityFeeGwei.NORMAL))
  })

  test("maxFeePerGas is baseFee × the tier multiplier + the (tiny) priority fee", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    const r = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(0.02), baseFeeWei: gwei(0.015), urgency: "NORMAL",
    })
    assert.equal(r.maxFeePerGas, gwei(0.015) * 2n + gwei(cfg.priorityFeeGwei.NORMAL))
  })

  test("a mainnet-scale gas price (30 gwei) on Arbitrum resolves to SKIP (thresholds are real ceilings)", () => {
    const r = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(30), baseFeeWei: gwei(25), urgency: "URGENT",
    })
    assert.equal(r.execute, false)
    assert.equal(r.tier, "SKIP")
  })

  test("DEFER-NEVER-FAIL: every band only ever returns execute:false — identical semantics to Base", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    const midElevated = (cfg.thresholdsGwei.NORMAL + cfg.thresholdsGwei.ELEVATED) / 2
    const midUrgent = (cfg.thresholdsGwei.ELEVATED + cfg.thresholdsGwei.URGENT) / 2

    const elevated = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(midElevated), baseFeeWei: gwei(midElevated * 0.8), urgency: "NORMAL",
    })
    assert.equal(elevated.execute, false)
    assert.equal(elevated.tier, "ELEVATED")

    const urgentOnly = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(midUrgent), baseFeeWei: gwei(midUrgent * 0.8), urgency: "NORMAL",
    })
    assert.equal(urgentOnly.execute, false)
    assert.equal(urgentOnly.tier, "URGENT_ONLY")

    // Same bands as Base's shape: URGENT urgency clears the URGENT_ONLY band.
    const urgentClears = resolveGasTier({
      chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(midUrgent), baseFeeWei: gwei(midUrgent * 0.8), urgency: "URGENT",
    })
    assert.equal(urgentClears.execute, true)
    assert.equal(urgentClears.maxPriorityFeePerGas, gwei(cfg.priorityFeeGwei.URGENT))
  })

  test("REGRESSION: no Arbitrum tier ever resolves above the Arbitrum URGENT priority ceiling", () => {
    const cfg = getGasTierConfig(ARBITRUM_CHAIN_ID)
    const ceilingWei = gwei(cfg.priorityFeeGwei.URGENT)
    for (const urgency of ["NORMAL", "ELEVATED", "URGENT"]) {
      for (const priceGwei of [0.01, 0.05, 0.2, 0.9]) {
        const r = resolveGasTier({
          chainId: ARBITRUM_CHAIN_ID, currentGasPriceWei: gwei(priceGwei), baseFeeWei: gwei(priceGwei * 0.8), urgency,
        })
        if (r.execute) {
          assert.ok(
            r.maxPriorityFeePerGas <= ceilingWei,
            `urgency=${urgency} price=${priceGwei}gwei priority=${r.maxPriorityFeePerGas} exceeds Arbitrum ceiling ${ceilingWei}`,
          )
        }
      }
    }
  })
})

describe("getGasTierConfig — unknown chains fail closed to mainnet (never to Base's/Arbitrum's low values)", () => {
  test("an unconfigured chain resolves to the mainnet config — safe (higher gas), never stuck", () => {
    // Was 42161 before [SPRINT-KEEPER-MULTICHAIN-ARBITRUM] gave Arbitrum its own entry; Optimism
    // (10) is the stand-in for "a production chain this keeper has no gas model for yet".
    const cfg = getGasTierConfig(10)
    assert.equal(cfg.priorityFeeGwei.NORMAL, 1.5)
    assert.equal(cfg.thresholdsGwei.NORMAL, 30)
  })
})

describe("[SPRINT-KEEPER-MULTICHAIN-ARBITRUM] adding 42161 left chains 1 and 8453 BYTE-IDENTICAL", () => {
  // Full-config snapshots of the two live chains, spelled out as literals so any future
  // per-chain addition that perturbs mainnet or Base fails here rather than in production.
  test("mainnet (1) config is exactly the pre-Arbitrum config", () => {
    assert.deepEqual(getGasTierConfig(MAINNET_CHAIN_ID), {
      thresholdsGwei: { NORMAL: 30, ELEVATED: 80, URGENT: 100 },
      priorityFeeGwei: { NORMAL: 1.5, ELEVATED: 2.5, URGENT: 4 },
      baseFeeMult: { NORMAL: 2, ELEVATED: 2.5, URGENT: 3 },
    })
  })

  test("Base (8453) config is exactly the pre-Arbitrum config", () => {
    assert.deepEqual(getGasTierConfig(BASE_CHAIN_ID), {
      thresholdsGwei: { NORMAL: 0.05, ELEVATED: 0.15, URGENT: 0.3 },
      priorityFeeGwei: { NORMAL: 0.02, ELEVATED: 0.05, URGENT: 0.1 },
      baseFeeMult: { NORMAL: 2, ELEVATED: 2.5, URGENT: 3 },
    })
  })

  test("_ARBITRUM env overrides never leak into the 1/8453 resolved tiers", () => {
    process.env.GAS_PRIORITY_URGENT_GWEI_ARBITRUM = "0.5"
    process.env.GAS_BASEFEE_MULT_NORMAL_ARBITRUM = "9"
    const mainnet = resolveGasTier({
      chainId: MAINNET_CHAIN_ID, currentGasPriceWei: gwei(20), baseFeeWei: gwei(15), urgency: "NORMAL",
    })
    assert.equal(mainnet.maxPriorityFeePerGas, gwei(1.5))
    assert.equal(mainnet.maxFeePerGas, gwei(15) * 2n + gwei(1.5))

    const base = resolveGasTier({
      chainId: BASE_CHAIN_ID, currentGasPriceWei: gwei(0.006), baseFeeWei: gwei(0.005), urgency: "NORMAL",
    })
    assert.equal(base.maxPriorityFeePerGas, gwei(0.02))
    assert.equal(base.maxFeePerGas, gwei(0.005) * 2n + gwei(0.02))
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
