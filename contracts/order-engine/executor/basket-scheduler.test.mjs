// Tests for basket-scheduler.js — the Basket DCA selection rules (SPEC-BASKET-DCA §3.1-3.2, §4, §4a; ADR-027).
//
// The reference is the analyst's engine, `engine_discrete.run_discrete` (v3.2), kept byte for byte beside the
// fixtures. scripts/basket-dca/export_vectors.py runs it with a real `pd0` (the price reference recorded when the
// basket is created) and writes fixtures/basket-dca/*.json (the engine's sha256 in every header). This file replays
// every vector tick by tick, feeding `next` back and counting each pick as executed, and requires the engine's picks,
// kinds, idle reasons, n and done, and at every tick the engine's own per-leg values: variation, entry, protected, in
// band, and why the leg did or did not buy. Beyond the engine: a pick that did not execute stays due, a restart
// decides the same, the same input gives the same output and is never mutated, a seeded property test holds the
// limits on random baskets, and invalid input throws.
//
// Pure: no I/O besides reading the fixtures, no clock, no network. Runs on Node 20 and 22 (keeper-tests.yml, ci.yml).

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  CHUNKS_PER_LEG_PER_TICK,
  GRACE_TICKS,
  IDLE_REASONS,
  LEG_REASONS,
  chooseN,
  decideTick,
  kSoft,
  legAmounts,
  roundVariation,
} from "./basket-scheduler.js"

const ENGINE_SHA256 = "282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685"
const RUN_FAMILIES = ["calm", "fall", "no-price", "band", "min-fill", "ties", "mixed", "no-reference"]
const SPLITS = {
  "25-25-50": [[1, 4], [1, 4], [1, 2]],
  "40-40-20": [[2, 5], [2, 5], [1, 5]],
  "33-33-33": [[1, 3], [1, 3], [1, 3]],
  "30-30-40": [[3, 10], [3, 10], [2, 5]],
}
// One `expected.perLeg` row per tick: the engine's values at that tick (the fixture header documents each column).
const PER_LEG_COLUMNS = [
  "variation0", "variation1", "variation2", "entry0", "entry1", "entry2",
  "protected0", "protected1", "protected2", "inBand", "reason0", "reason1", "reason2",
]
const [V, E, P, B, R] = [0, 3, 6, 9, 10] // first column of each group
const BLOCKED = [LEG_REASONS.COMPLETE, LEG_REASONS.NO_PRICE, LEG_REASONS.BAND, LEG_REASONS.RULE9]

function fixtureUrl(file) {
  return new URL(`./fixtures/basket-dca/${file}`, import.meta.url)
}

function fixture(name) {
  return JSON.parse(readFileSync(fixtureUrl(`${name}.json`), "utf8"))
}

const RUNS = RUN_FAMILIES.map((family) => ({ family, ...fixture(family) }))
const VECTORS = RUNS.flatMap((f) => f.vectors.map((v) => ({ family: f.family, ...v })))
const vectorById = (id) => {
  const v = VECTORS.find((x) => x.id === id)
  assert.ok(v, `no vector ${id}`)
  return v
}
const splitOf = (v) => Object.keys(SPLITS).find((name) => JSON.stringify(SPLITS[name]) === JSON.stringify(v.input.weights))

function paramsOf(input) {
  return { cycles: input.cycles, mode: input.mode, threshold: input.threshold, stableLeg: input.stableLeg, band: input.band }
}

function tickInput(input, t, legs, cooldown) {
  return {
    params: paramsOf(input),
    tick: t,
    legs,
    cooldown,
    prices: input.prices[t],
    bandAdd: input.bandAdd === null ? null : input.bandAdd[t],
  }
}

/** The state before tick 0: the reference is each leg's `last` (null = the leg has none); no leg has an entry yet. */
function freshLegs(n, reference) {
  return n.map((ni, i) => ({ n: ni, done: 0, last: reference[i], entry: null }))
}

/**
 * Run a vector from `start` (default: tick 0, the vector's reference) to its last grace tick. `executes(t, pick)`
 * says whether a picked chunk executed (default: every pick does, as in the engine); only executed chunks advance
 * `done`. `reference` replaces the vector's own (e.g. three nulls: the same prices with no reference).
 */
function replay(input, { executes = () => true, start, reference = input.reference } = {}) {
  const n = chooseN(input.weights, input.capitalUsd, input.cycles, input.minFillUsd)
  let legs = start?.legs ?? freshLegs(n, reference)
  let cooldown = start?.cooldown ?? null
  const fills = []
  const idle = []
  const steps = []
  for (let t = start?.tick ?? 0; t < input.cycles + GRACE_TICKS; t += 1) {
    const inp = tickInput(input, t, legs, cooldown)
    const out = decideTick(inp)
    steps.push({ t, inp, out })
    for (const p of out.picks) fills.push([t, p.leg, p.kind])
    if (out.picks.length === 0) idle.push([t, out.idleReason])
    const executed = [0, 0, 0]
    for (const p of out.picks) if (executes(t, p)) executed[p.leg] += 1
    legs = out.next.legs.map((leg, i) => ({ ...leg, done: leg.done + executed[i] }))
    cooldown = out.next.cooldown
  }
  return { n, fills, idle, done: legs.map((leg) => leg.done), steps, legs, cooldown }
}

function deepFreeze(x) {
  if (x !== null && typeof x === "object") {
    Object.freeze(x)
    for (const key of Object.keys(x)) deepFreeze(x[key])
  }
  return x
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The double next to a positive finite x, one step towards zero. */
function nextDown(x) {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  view.setBigUint64(0, view.getBigUint64(0) - 1n)
  return view.getFloat64(0)
}

/** The double next to a positive finite x, one step away from zero. */
function nextUp(x) {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  view.setBigUint64(0, view.getBigUint64(0) + 1n)
  return view.getFloat64(0)
}

// ------------------------------------------------------------------------------------------------ provenance
describe("fixtures: provenance", () => {
  test("the engine beside the fixtures is the pinned file, byte for byte (sha256), and its .sha256 says so", () => {
    const bytes = readFileSync(fixtureUrl("engine_discrete.py"))
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ENGINE_SHA256)
    assert.equal(readFileSync(fixtureUrl("engine_discrete.py.sha256"), "utf8"), `${ENGINE_SHA256}  engine_discrete.py\n`)
  })

  test("every fixture comes from that engine, run with L = 2, Hamilton, k_soft = max(1, ceil(N / 4)) and a real pd0", () => {
    for (const name of [...RUN_FAMILIES, "choose-n", "rounding"]) {
      const { header } = fixture(name)
      assert.equal(header.engine.sha256, ENGINE_SHA256, name)
      assert.equal(header.engine.file, "engine_discrete.py", name)
      assert.equal(header.engine.copy, "contracts/order-engine/executor/fixtures/basket-dca/engine_discrete.py (byte for byte)", name)
      assert.equal(header.generator, "scripts/basket-dca/export_vectors.py", name)
      assert.equal(header.run.L, CHUNKS_PER_LEG_PER_TICK, name)
      assert.equal(header.run.rule, "hamilton", name)
      assert.equal(header.run.kSoft, "max(1, ceil(N / 4))", name)
      assert.equal(header.run.graceTicks, GRACE_TICKS, name)
      assert.match(header.run.pd0, /^input\.reference of each vector/, name)
      assert.deepEqual(Object.values(header.idleReasons).sort(), Object.values(IDLE_REASONS).sort(), name)
    }
    for (const run of RUNS) assert.deepEqual(run.header.perLegColumns, PER_LEG_COLUMNS, run.family)
  })

  test("each run vector has a reference (a price or null per leg), N + 3 ticks of three prices and of engine values, and a band_add per tick exactly when it has a stable leg", () => {
    assert.ok(VECTORS.length >= 90, `only ${VECTORS.length} vectors`)
    for (const v of VECTORS) {
      const { cycles, prices, reference, stableLeg, bandAdd } = v.input
      assert.equal(reference.length, 3, v.id)
      for (const p of reference) assert.ok(p === null || (typeof p === "number" && p > 0), v.id)
      assert.equal(prices.length, cycles + GRACE_TICKS, v.id)
      for (const row of prices) assert.equal(row.length, 3, v.id)
      assert.equal(v.expected.perLeg.length, cycles + GRACE_TICKS, v.id)
      for (const row of v.expected.perLeg) assert.equal(row.length, PER_LEG_COLUMNS.length, v.id)
      if (stableLeg === null) assert.equal(bandAdd, null, v.id)
      else assert.equal(bandAdd.length, cycles + GRACE_TICKS, v.id)
    }
  })

  test("the vectors show every per-leg reason, and legs with and without a reference", () => {
    const reasons = new Set(VECTORS.flatMap((v) => v.expected.perLeg.flatMap((row) => row.slice(R, R + 3))))
    assert.deepEqual([...reasons].sort(), Object.values(LEG_REASONS).sort())
    assert.ok(VECTORS.filter((v) => v.input.reference.every((p) => p !== null)).length >= 60)
    assert.ok(VECTORS.filter((v) => v.input.reference.some((p) => p === null)).length >= 20)
    assert.ok(VECTORS.filter((v) => v.input.reference.every((p) => p === null)).length >= 12)
  })
})

// ------------------------------------------------------------------------------------------------ engine replay
for (const run of RUNS) {
  describe(`engine vectors: ${run.family} (${run.vectors.length}) — ${run.header.about}`, () => {
    for (const v of run.vectors) {
      test(`${v.id} replays pick for pick`, () => {
        const got = replay(v.input)
        assert.deepEqual(got.n, v.expected.n, "n per leg")
        assert.deepEqual(got.fills, v.expected.fills, "fills: [tick, leg, kind]")
        assert.deepEqual(got.idle, v.expected.idle, "idle reason of every tick without a fill")
        assert.deepEqual(got.done, v.expected.done, "done per leg")
        if (v.input.mode === "soft") assert.equal(kSoft(v.input.cycles), v.expected.kSoft, "k_soft")
        else assert.equal(v.expected.kSoft, null, "the engine reports no k_soft for a rigid run")
        for (const { out } of got.steps) {
          const seen = [0, 0, 0]
          out.picks.forEach((p, j) => {
            seen[p.leg] += 1
            assert.equal(p.slot, seen[p.leg], "slot = the leg's first or second chunk of the tick")
            assert.equal(p.kind, j === 0 ? "select" : "catchup")
          })
          assert.equal(out.idleReason === null, out.picks.length > 0, "an idle reason exactly when nothing was picked")
        }
      })

      test(`${v.id}: the per-leg values of every tick are the engine's (variation, entry, protected, in band, reason)`, () => {
        for (const { t, out } of replay(v.input).steps) {
          const row = v.expected.perLeg[t]
          const picked = new Set(out.picks.map((p) => p.leg))
          assert.equal(out.perLeg.length, 3)
          out.perLeg.forEach((leg, i) => {
            const at = `tick ${t} leg ${i}`
            assert.ok(Object.is(leg.variation, row[V + i]), `${at}: variation ${leg.variation}, the engine's ${row[V + i]}`)
            assert.equal(out.next.legs[i].entry, row[E + i], `${at}: entry`)
            assert.equal(leg.protected, row[P + i], `${at}: protected`)
            assert.equal(leg.inBand, i === v.input.stableLeg ? row[B] : null, `${at}: inBand`)
            assert.equal(leg.reason, row[R + i], `${at}: reason`)
            assert.equal(leg.reason === LEG_REASONS.PICKED, picked.has(i), `${at}: "picked" exactly for a picked leg`)
            if (BLOCKED.includes(leg.reason)) assert.ok(!picked.has(i), `${at}: ${leg.reason}, yet picked`)
          })
        }
      })
    }
  })
}

describe("end of the basket", () => {
  for (const v of VECTORS.filter((x) => x.input.mode === "soft")) {
    test(`soft: ${v.id} ends with done == n on every leg (deviation 0.00 pp)`, () => {
      const got = replay(v.input)
      assert.deepEqual(got.done, got.n)
      assert.deepEqual(v.expected.unbought, [0, 0, 0])
      assert.ok(v.expected.deviationPp < 1e-9, `engine deviation ${v.expected.deviationPp} pp`)
    })
  }
  const rigid = VECTORS.filter((x) => x.input.mode === "rigid")
  for (const v of rigid) {
    test(`rigid: ${v.id} leaves exactly the fixture's unbought chunks`, () => {
      const got = replay(v.input)
      assert.deepEqual(
        got.n.map((ni, i) => ni - got.done[i]),
        v.expected.unbought,
      )
    })
  }
  test("rigid vectors show unbought chunks (rule 9 that never stops blocking), asserted as such, not as failures", () => {
    const left = rigid.filter((v) => v.expected.unbought.some((x) => x > 0)).map((v) => v.id)
    assert.ok(left.length >= 2, `rigid vectors with unbought chunks: ${left.join(", ")}`)
  })
})

// ------------------------------------------------------------------------------------------------ the reference
describe("the price reference (owner decision 2026-11-16): recorded at creation, the first purchase compares against it", () => {
  const calm = RUNS.find((r) => r.family === "calm")
  const NO_REFERENCE = [null, null, null]

  test("a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does", () => {
    const changed = []
    for (const v of calm.vectors) {
      const withRef = replay(v.input)
      const without = replay(v.input, { reference: NO_REFERENCE })
      assert.deepEqual(without.fills[0], [0, 0, "select"], `${v.id}: no reference, leg 0 first`)
      assert.deepEqual(withRef.fills[0], v.expected.fills[0], `${v.id}: the engine's first pick`)
      // With a reference on every leg the first chunk goes to the lowest variation against it (no cooldown yet).
      const variations = v.input.prices[0].map((p, i) => p / v.input.reference[i] - 1)
      const first = withRef.fills[0][1]
      assert.equal(variations[first], Math.min(...variations), `${v.id}: leg ${first} did worst since the reference`)
      assert.deepEqual(withRef.steps[0].out.perLeg.map((leg) => leg.variation), variations, v.id)
      if (first !== 0) changed.push(v.id)
    }
    assert.ok(changed.length >= 1, "no calm vector whose first pick the reference changes")
    assert.deepEqual(changed, calm.header.referenceChangesFirstPick, "the exporter's own list")
  })

  test("with NO reference on any leg, leg 0 takes the first chunk for all 4 splits (the \"buy the first one now\" mode relies on it)", () => {
    const all = VECTORS.filter((v) => v.input.reference.every((p) => p === null) && v.family === "no-reference")
    const splits = new Set()
    for (const v of all) {
      splits.add(splitOf(v))
      assert.deepEqual(v.expected.fills[0], [0, 0, "select"], `${v.id}: the engine`)
      const first = replay(v.input).steps[0].out
      assert.deepEqual(first.picks[0], { leg: 0, kind: "select", slot: 1 }, v.id)
      assert.deepEqual(first.perLeg.map((leg) => leg.variation), [null, null, null], `${v.id}: no variation at all`)
      assert.equal(first.next.cooldown, 0, v.id)
    }
    assert.deepEqual([...splits].sort(), Object.keys(SPLITS).sort(), "one such vector per split at least")
    // And directly, whatever the prices and N: nothing to compare against, so every key ties and leg 0 is first.
    const rnd = mulberry32(0xb0b)
    for (const [name, weights] of Object.entries(SPLITS)) {
      for (const cycles of [6, 9, 26, 86]) {
        for (let k = 0; k < 25; k += 1) {
          const n = chooseN(weights, 1000, cycles, 16)
          const prices = [10 ** (6 * rnd() - 3), 10 ** (6 * rnd() - 3), 10 ** (6 * rnd() - 3)]
          const params = { cycles, mode: k % 2 ? "soft" : "rigid", threshold: 0.25, stableLeg: null, band: null }
          const out = decideTick({ params, tick: 0, legs: freshLegs(n, NO_REFERENCE), cooldown: null, prices })
          assert.equal(out.picks[0].leg, 0, `${name} N=${cycles} prices ${prices}`)
        }
      }
    }
  })

  test("the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first", () => {
    const params = { cycles: 6, mode: "rigid", threshold: 0.25, stableLeg: null, band: null }
    const legs = freshLegs([2, 2, 2], [100, 100, 100])
    const out = decideTick({ params, tick: 0, legs, cooldown: null, prices: [70, 100, 100] })
    assert.deepEqual(out.picks, [{ leg: 0, kind: "select", slot: 1 }])
    assert.deepEqual(out.perLeg[0], { variation: 70 / 100 - 1, protected: false, inBand: null, reason: "picked" })
    assert.deepEqual(out.next.legs[0], { n: 2, done: 0, last: 70, entry: 70 }, "entry = the first tick price, 70, not the reference")
    // From there rule 9 measures against 70: 52.5 is protected (= 70 × 0.75), 52.6 is not.
    const at = (price) =>
      decideTick({ params, tick: 1, legs: out.next.legs, cooldown: out.next.cooldown, prices: [price, 100, 100] }).perLeg[0]
    assert.equal(at(52.5).protected, true)
    assert.equal(at(52.5).reason, "rule9")
    assert.equal(at(52.6).protected, false)
  })

  test("fall-below-reference: 25% under its reference at every tick, never protected, it completes; fall-below-entry: over its reference, protected from tick 1, never buys", () => {
    const under = vectorById("fall-below-reference-n9-leg0-rigid")
    const u = replay(under.input)
    for (const { t, out } of u.steps) {
      assert.ok(under.input.prices[t][0] <= under.input.reference[0] * (1 - under.input.threshold), `tick ${t}`)
      assert.equal(out.perLeg[0].protected, false, `tick ${t}`)
    }
    assert.deepEqual(u.fills[0], [0, 0, "select"])
    assert.deepEqual(u.done, u.n)

    const over = vectorById("fall-below-entry-n9-leg1-rigid")
    const o = replay(over.input)
    for (const { t, out } of o.steps) {
      assert.ok(over.input.prices[t][1] > over.input.reference[1] * (1 - over.input.threshold), `tick ${t}`)
      assert.equal(out.perLeg[1].protected, t >= 1, `tick ${t}`)
      assert.equal(out.perLeg[1].reason, t >= 1 ? "rule9" : "not_due", `tick ${t}`)
    }
    assert.equal(o.done[1], 0)
    assert.equal(o.legs[1].entry, 140)
  })

  test("a leg with no reference has no variation at its first tick with a price, and that tick sets its entry", () => {
    let legsSeen = 0
    for (const v of VECTORS.filter((x) => x.input.reference.some((p) => p === null))) {
      const got = replay(v.input)
      v.input.reference.forEach((ref, i) => {
        const first = v.input.prices.findIndex((row) => row[i] !== null)
        if (first < 0) return
        const step = got.steps[first]
        assert.equal(step.inp.legs[i].entry, null, `${v.id} leg ${i}: no entry before its first price`)
        assert.equal(step.out.next.legs[i].entry, v.input.prices[first][i], `${v.id} leg ${i}: entry at tick ${first}`)
        if (ref === null) {
          assert.equal(step.out.perLeg[i].variation, null, `${v.id} leg ${i}: variation at tick ${first}`)
          legsSeen += 1
        } else {
          assert.equal(step.out.perLeg[i].variation, v.input.prices[first][i] / ref - 1, `${v.id} leg ${i}: against its reference`)
        }
      })
    }
    assert.ok(legsSeen >= 40, `only ${legsSeen} legs without a reference`)
    // It ranks as 0: first when the others rose, not first when they fell, even as leg 0.
    assert.deepEqual(vectorById("noref-leg2-others-rise-n9").expected.fills[0], [0, 2, "select"])
    assert.notEqual(vectorById("noref-leg0-others-fall-n9").expected.fills[0][1], 0)
    // And its first price may come late: leg 1 of noref-leg1-late-n9 has none at ticks 0-1.
    const late = vectorById("noref-leg1-late-n9")
    assert.deepEqual([late.input.prices[0][1], late.input.prices[1][1], late.input.reference[1]], [null, null, null])
    assert.deepEqual(replay(late.input).steps.slice(0, 3).map((s) => s.out.perLeg[1].reason), ["no_price", "no_price", late.expected.perLeg[2][R + 1]])
  })

  test("the reference spans ticks without a price: the leg's first variation is still against it", () => {
    const v = vectorById("noprice-n9-leg0-start-soft")
    assert.deepEqual([v.input.prices[0][0], v.input.prices[1][0]], [null, null])
    const got = replay(v.input)
    assert.equal(got.steps[1].out.next.legs[0].last, v.input.reference[0], "last is still the reference after two ticks without a price")
    assert.equal(got.steps[1].out.next.legs[0].entry, null)
    assert.equal(got.steps[2].out.perLeg[0].variation, v.input.prices[2][0] / v.input.reference[0] - 1)
    assert.equal(got.steps[2].out.next.legs[0].entry, v.input.prices[2][0])
  })

  test("the no-reference \"buy now\" vectors are the calm vectors' prices: the same baskets, with and without a reference", () => {
    for (const v of VECTORS.filter((x) => x.id.startsWith("noref-all-"))) {
      const twin = vectorById(v.id.replace("noref-all-", "calm-"))
      assert.deepEqual(v.input.prices, twin.input.prices, v.id)
      assert.deepEqual({ ...v.input, reference: null, prices: null }, { ...twin.input, reference: null, prices: null }, v.id)
      assert.deepEqual(replay(twin.input, { reference: NO_REFERENCE }).fills, v.expected.fills, v.id)
    }
  })
})

// ------------------------------------------------------------------------------------------------ the two edges
describe("the two edges in doubles match the engine", () => {
  test("rule 9, entry 1.2 at 25%: 1.2 × 0.75 is 0.8999999999999999, so exactly 0.9 is NOT protected (and buys); one double lower is", () => {
    assert.equal(1.2 * (1 - 0.25), 0.8999999999999999)
    assert.ok(0.9 > 1.2 * (1 - 0.25), "0.9 is entry × 0.75 on paper, above it in doubles")
    assert.equal(nextDown(0.9), 0.8999999999999999)
    const v = vectorById("fall-inexact-n12-leg0-rigid")
    assert.equal(v.input.prices[0][0], 1.2)
    assert.equal(v.input.threshold, 0.25)
    const got = replay(v.input)
    const at = { edge: 0, under: 0, boughtAtEdge: 0 }
    for (const { t, out } of got.steps) {
      const p = v.input.prices[t][0]
      if (p !== 0.9 && p !== 0.8999999999999999) continue
      const engine = v.expected.perLeg[t][P]
      assert.equal(engine, p !== 0.9, `tick ${t}: the engine's answer at ${p}`)
      assert.equal(out.perLeg[0].protected, engine, `tick ${t}: the module's`)
      if (p === 0.9) {
        at.edge += 1
        at.boughtAtEdge += out.perLeg[0].reason === "picked" ? 1 : 0
      } else {
        at.under += 1
        assert.notEqual(out.perLeg[0].reason, "picked", `tick ${t}`)
      }
    }
    assert.ok(at.edge >= 5 && at.under >= 2 && at.boughtAtEdge >= 1, JSON.stringify(at))
    assert.equal(got.legs[0].entry, 1.2)
  })

  test("band, 171 bps with band_add 0.003: |0.9859 − 1| + 0.003 and |1.0141 − 1| + 0.003 EQUAL the band, which is in band (and the stable buys); one double further is out", () => {
    assert.equal(Math.abs(0.9859 - 1) + 0.003, 0.0171)
    assert.equal(Math.abs(1.0141 - 1) + 0.003, 0.0171)
    const v = vectorById("band-edge-n9-stable2-b171-soft")
    assert.deepEqual([v.input.band, v.input.stableLeg], [0.0171, 2])
    const got = replay(v.input)
    const onEdge = []
    for (const { t, out } of got.steps) {
      const sum = Math.abs(v.input.prices[t][2] - 1) + v.input.bandAdd[t]
      const engine = v.expected.perLeg[t][B]
      assert.equal(engine, !(sum > v.input.band), `tick ${t}: the engine's answer`)
      assert.equal(out.perLeg[2].inBand, engine, `tick ${t}: the module's`)
      if (sum === v.input.band) onEdge.push([t, v.input.prices[t][2], out.perLeg[2].reason])
    }
    assert.deepEqual(onEdge, [[1, 0.9859, "picked"], [3, 1.0141, "not_due"], [7, 0.9859, "picked"]])
    assert.equal(got.steps[5].out.perLeg[2].reason, "band", "0.9858 at tick 5 is out")
    // One double past the edge, either side: out of band, and the tick that bought the stable leg no longer does.
    for (const [t, past] of [[1, nextDown(0.9859)], [3, nextUp(1.0141)], [7, nextDown(0.9859)]]) {
      const inp = structuredClone(got.steps[t].inp)
      inp.prices[2] = past
      const out = decideTick(inp)
      assert.equal(out.perLeg[2].inBand, false, `tick ${t} at ${past}`)
      assert.equal(out.perLeg[2].reason, "band", `tick ${t} at ${past}`)
      assert.ok(!out.picks.some((p) => p.leg === 2), `tick ${t} at ${past}`)
    }
  })

  test("at the four product bands a decimal price on the edge is never ON it in doubles: it lands just inside or just outside, and this table is where", () => {
    const table = [
      // band, price, band_add, in band?
      [0.01, 0.993, 0.003, false], [0.01, 1.007, 0.003, true], [0.01, 0.99, 0, false], [0.01, 1.01, 0, false],
      [0.02, 0.983, 0.003, false], [0.02, 1.017, 0.003, true], [0.02, 0.98, 0, false], [0.02, 1.02, 0, false],
      [0.05, 0.953, 0.003, false], [0.05, 1.047, 0.003, true], [0.05, 0.95, 0, false], [0.05, 1.05, 0, false],
      [0.1, 0.903, 0.003, true], [0.1, 1.097, 0.003, true], [0.1, 0.9, 0, true], [0.1, 1.1, 0, false],
    ]
    for (const [band, price, bandAdd, inBand] of table) {
      const params = { cycles: 6, mode: "soft", threshold: 0.25, stableLeg: 2, band }
      const out = decideTick({ params, tick: 0, legs: freshLegs([2, 2, 2], [100, 10, 1]), cooldown: null, prices: [100, 10, price], bandAdd })
      assert.notEqual(Math.abs(price - 1) + bandAdd, band, `band ${band} at ${price} + ${bandAdd}: not on the edge`)
      assert.equal(out.perLeg[2].inBand, inBand, `band ${band} at ${price} + ${bandAdd}`)
    }
  })
})

// ------------------------------------------------------------------------------------------------ per order (§3)
describe("chooseN and kSoft against the engine's choose_n", () => {
  const fx = fixture("choose-n")

  test(`every choose_n case of the engine tests (${fx.cases.length})`, () => {
    for (const c of fx.cases) {
      assert.deepEqual(chooseN(c.weights, c.capitalUsd, c.cycles, c.minFillUsd), c.n, `${c.source} N=${c.cycles} C=${c.capitalUsd}`)
    }
  })

  test("the engine tests' own assertions hold on chooseN: n >= 1, chunk >= minFill, Hamilton sums to N when no cap binds", () => {
    const rint = (x) => {
      const r = Math.round(x) // np.round(x): half to even
      return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
    }
    for (const c of fx.cases) {
      const n = chooseN(c.weights, c.capitalUsd, c.cycles, c.minFillUsd)
      const w = c.weights.map(([num, den]) => num / den)
      assert.ok(n.every((ni) => ni >= 1))
      assert.ok(n.every((ni, i) => (w[i] * c.capitalUsd) / ni >= c.minFillUsd - 1e-9))
      if (w.every((wi) => (wi * c.capitalUsd) / Math.max(rint(wi * c.cycles), 1) >= c.minFillUsd)) {
        assert.equal(n[0] + n[1] + n[2], c.cycles, JSON.stringify(c))
      }
    }
  })

  test("test_engine_v32 on every product N: 1 <= k_soft < N, and 2 × (k_soft + 3) >= the largest n", () => {
    const v32 = fx.cases.filter((c) => c.source.startsWith("test_engine_v32"))
    assert.equal(v32.length, fx.header.combos * 4)
    for (const c of v32) {
      const k = kSoft(c.cycles)
      assert.equal(k, c.kSoft)
      assert.ok(k >= 1 && k < c.cycles, `N=${c.cycles} k=${k}`)
      assert.ok(CHUNKS_PER_LEG_PER_TICK * (k + GRACE_TICKS) >= Math.max(...c.n), `N=${c.cycles} n=${c.n}`)
    }
  })

  test("kSoft(N) = max(1, ceil(N / 4)), no cap, for N = 1..100", () => {
    for (const [N, k] of fx.kSoft) assert.equal(kSoft(N), k, `N=${N}`)
    assert.equal(kSoft(86), 22)
    assert.equal(kSoft(26), 7)
    assert.equal(kSoft(9), 3)
  })
})

describe("roundVariation is numpy's round(np.float64(v), 12)", () => {
  const fx = fixture("rounding")
  test(`${fx.cases.length} cases, ${fx.header.halfway} exact halfway points, ${fx.header.differFromPythonRound} where Python's round() differs`, () => {
    assert.ok(fx.header.halfway >= 20 && fx.header.differFromPythonRound >= 3)
    for (const [v, r] of fx.cases) assert.ok(Object.is(roundVariation(v), r), `round(${v}, 12): got ${roundVariation(v)}, numpy ${r}`)
  })
})

describe("legAmounts: legs 1 and 2 floored, leg 3 the rest, no leg at zero", () => {
  test("the three amounts sum to the capital exactly, for every split and awkward capitals", () => {
    const capitals = [4n, 5n, 7n, 99n, 100n, 1_000_001n, 123_456_789n, 10n ** 24n + 7n]
    for (const [name, w] of Object.entries(SPLITS)) {
      for (const C of capitals) {
        const [a, b, c] = legAmounts(C, w)
        assert.equal(a + b + c, C, `${name} C=${C}`)
        assert.equal(a, (C * BigInt(w[0][0])) / BigInt(w[0][1]))
        assert.equal(b, (C * BigInt(w[1][0])) / BigInt(w[1][1]))
        assert.ok(c >= (C * BigInt(w[2][0])) / BigInt(w[2][1]), "leg 3 never gets less than its own floor")
        assert.ok(a > 0n && b > 0n && c > 0n, `${name} C=${C}`)
      }
    }
  })

  test("thirds are thirds, not 0.33: 100 units -> 33, 33, 34; 1 000 USDC (6 decimals) 25-25-50 is exact", () => {
    assert.deepEqual(legAmounts(100n, SPLITS["33-33-33"]), [33n, 33n, 34n])
    assert.deepEqual(legAmounts(1_000_000_000n, SPLITS["25-25-50"]), [250_000_000n, 250_000_000n, 500_000_000n])
    assert.deepEqual(legAmounts(10n, SPLITS["30-30-40"]), [3n, 3n, 4n])
  })

  test("a capital that would leave a leg with amount 0 throws: the smallest capital of each split works, one unit less does not", () => {
    const smallest = { "25-25-50": 4n, "40-40-20": 3n, "33-33-33": 3n, "30-30-40": 4n }
    for (const [name, w] of Object.entries(SPLITS)) {
      const C = smallest[name]
      assert.ok(legAmounts(C, w).every((x) => x > 0n), `${name} C=${C}`)
      for (let c = 1n; c < C; c += 1n) {
        assert.throws(() => legAmounts(c, w), { name: "RangeError", message: /basket-scheduler: capitalUnits \d+ leaves leg [01] with amount 0/ }, `${name} C=${c}`)
      }
    }
  })
})

// ------------------------------------------------------------------------------------------------ beyond the engine
describe("decideTick beyond the engine", () => {
  const flat = [100, 10, 1]
  const params = { cycles: 6, mode: "soft", threshold: 0.25, stableLeg: null, band: null }
  const fresh = () => freshLegs([2, 2, 2], [null, null, null])

  test("a picked chunk that did NOT execute is due again next tick (the calendar counts executed chunks)", () => {
    const t0 = decideTick({ params, tick: 0, legs: fresh(), cooldown: null, prices: flat })
    assert.deepEqual(t0.picks, [{ leg: 0, kind: "select", slot: 1 }])
    const executed = t0.next.legs.map((leg, i) => ({ ...leg, done: leg.done + (i === 0 ? 1 : 0) }))
    const a = decideTick({ params, tick: 1, legs: executed, cooldown: t0.next.cooldown, prices: flat })
    const b = decideTick({ params, tick: 1, legs: t0.next.legs, cooldown: t0.next.cooldown, prices: flat })
    assert.equal(a.picks.length, 1, "executed: one chunk due at tick 1")
    assert.equal(b.picks.length, 2, "not executed: that chunk is due again, on top of tick 1's own")
    assert.ok(b.picks.some((p) => p.leg === 0), "leg 0's missed chunk is picked again (catch-up)")
    assert.equal(b.picks[0].leg, 1, "rule 5 still applies to the first chunk: leg 0 was the previous first leg")
  })

  test("the result keeps its shape: picks, idleReason and next as before, perLeg added beside them", () => {
    const out = decideTick({ params, tick: 0, legs: fresh(), cooldown: null, prices: flat })
    assert.deepEqual(Object.keys(out).sort(), ["idleReason", "next", "perLeg", "picks"])
    assert.deepEqual(Object.keys(out.picks[0]).sort(), ["kind", "leg", "slot"])
    assert.deepEqual(Object.keys(out.next).sort(), ["cooldown", "legs"])
    assert.deepEqual(Object.keys(out.next.legs[0]).sort(), ["done", "entry", "last", "n"])
    assert.deepEqual(Object.keys(out.perLeg[0]).sort(), ["inBand", "protected", "reason", "variation"])
    assert.equal(out.idleReason, null)
  })

  test("reason \"cooldown\": the leg that did worst, sent to the back of the line by rule 5; \"not_due\": eligible, and the chunk went to another leg or none was due", () => {
    const legs = [0, 0, 1].map((done) => ({ n: 2, done, last: 100, entry: 100 })) // tick 0's chunk went to leg 2
    const prices = [90, 95, 100] // leg 0 did worst, then leg 1
    const reasons = (cooldown, tick = 1) => decideTick({ params, tick, legs, cooldown, prices }).perLeg.map((leg) => leg.reason)
    assert.deepEqual(reasons(null), ["picked", "not_due", "not_due"])
    assert.deepEqual(reasons(0), ["cooldown", "picked", "not_due"], "rule 5 took leg 0's first place")
    assert.deepEqual(reasons(1), ["picked", "not_due", "not_due"], "leg 1 was not first in line: rule 5 changed nothing for it")
    // With two chunks due the cooldown leg is still picked, as a catch-up: its reason is then "picked".
    const behind = decideTick({ params, tick: 2, legs, cooldown: 0, prices })
    assert.deepEqual(behind.picks.map((p) => [p.leg, p.kind]), [[1, "select"], [0, "catchup"]])
    assert.deepEqual(behind.perLeg.map((leg) => leg.reason), ["picked", "picked", "not_due"])
    // Nothing due (one chunk a tick, and it was executed): every eligible leg is "not_due", the tick idles on the calendar.
    const ahead = decideTick({ params, tick: 1, legs: legs.map((leg, i) => ({ ...leg, done: i === 0 ? 2 : leg.done })), cooldown: 0, prices })
    assert.equal(ahead.idleReason, "calendar")
    assert.deepEqual(ahead.perLeg.map((leg) => leg.reason), ["complete", "not_due", "not_due"])
  })

  test("a restart decides the same: state read back from storage mid-basket gives the same decision and the same end", () => {
    for (const v of VECTORS) {
      const whole = replay(v.input)
      for (const { inp, out } of whole.steps) {
        const reread = JSON.parse(JSON.stringify(inp))
        assert.deepEqual(decideTick(reread), out, `${v.id} tick ${inp.tick}`)
      }
      const cut = Math.floor((v.input.cycles + GRACE_TICKS) / 2)
      const at = whole.steps[cut].inp
      const resumed = replay(v.input, { start: JSON.parse(JSON.stringify({ tick: cut, legs: at.legs, cooldown: at.cooldown })) })
      assert.deepEqual(
        whole.fills.filter(([t]) => t < cut).concat(resumed.fills),
        whole.fills,
        `${v.id}: restarted at tick ${cut}`,
      )
      assert.deepEqual(resumed.done, whole.done, v.id)
    }
  })

  test("same input twice, same output; the input is never mutated (deep-frozen inputs, before and after)", () => {
    for (const v of VECTORS) {
      for (const { inp, out } of replay(v.input).steps) {
        const before = JSON.stringify(inp)
        const frozen = deepFreeze(structuredClone(inp))
        const first = decideTick(frozen)
        const second = decideTick(frozen)
        assert.deepEqual(first, second, v.id)
        assert.deepEqual(first, out, v.id)
        assert.equal(JSON.stringify(inp), before, v.id)
        assert.notEqual(first.next.legs, frozen.legs, "next.legs is a new array")
      }
    }
  })
})

describe("seeded property test: the limits hold on random baskets, references, prices and failed executions", () => {
  test("never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided", () => {
    const rnd = mulberry32(0x5eed2611)
    const seen = {
      ticks: 0, noPrice: 0, outOfBand: 0, rule9Blocked: 0, twoOfOneLeg: 0, softWindowProtectedPick: 0, idle: 0,
      noReference: 0, firstVariationAgainstReference: 0, cooldownReason: 0, notDue: 0, firstPickNotLeg0: 0,
    }
    const randomWeights = () => {
      if (rnd() < 0.5) return Object.values(SPLITS)[Math.floor(rnd() * 4)]
      for (;;) {
        const den = 3 + Math.floor(rnd() * 28)
        const a = 1 + Math.floor(rnd() * Math.floor(den / 2))
        const b = 1 + Math.floor(rnd() * Math.floor(den / 2))
        const c = den - a - b
        if (c >= 1 && 2 * a <= den && 2 * b <= den && 2 * c <= den) return [[a, den], [b, den], [c, den]]
      }
    }
    for (let basket = 0; basket < 400; basket += 1) {
      const weights = randomWeights()
      const cycles = 1 + Math.floor(rnd() * 90)
      const capitalUsd = [20, 100, 1000, 25_000][Math.floor(rnd() * 4)] * (0.5 + rnd())
      const minFillUsd = rnd() < 0.5 ? 3 : 16
      const mode = rnd() < 0.5 ? "soft" : "rigid"
      const threshold = [0, 0.1, 0.25, 0.5, 0.9][Math.floor(rnd() * 5)]
      const stableLeg = rnd() < 0.4 ? Math.floor(rnd() * 3) : null
      const band = stableLeg === null ? null : 0.002 + rnd() * 0.1
      const p = { cycles, mode, threshold, stableLeg, band }
      const n = chooseN(weights, capitalUsd, cycles, minFillUsd)
      const k = kSoft(cycles)
      const level = [50 + rnd() * 5000, 0.5 + rnd() * 50, 1 + rnd()]
      // The reference: each leg's price one cycle before tick 0, missing for one leg in four, for all in one basket in five.
      const buyNow = rnd() < 0.2
      const reference = level.map((x, i) => (buyNow || rnd() < 0.25 ? null : i === stableLeg ? 1 : x * (1 + 0.3 * (2 * rnd() - 1))))
      let legs = freshLegs(n, reference)
      let cooldown = null
      for (let tick = 0; tick < cycles + GRACE_TICKS; tick += 1) {
        const prices = level.map((x, i) => {
          if (rnd() < 0.12) return null
          if (i === stableLeg) return 1 + (rnd() < 0.3 ? 0.06 : 0.004) * (2 * rnd() - 1)
          level[i] = x * (rnd() < 0.05 ? 0.5 : 1 + 0.15 * (2 * rnd() - 1))
          return level[i]
        })
        const bandAdd = stableLeg === null ? null : [0, 0.003, rnd() * 0.01][Math.floor(rnd() * 3)]
        const inp = deepFreeze({ params: p, tick, legs, cooldown, prices, bandAdd })
        const out = decideTick(inp)
        seen.ticks += 1
        const count = [0, 0, 0]
        for (const pick of out.picks) count[pick.leg] += 1
        const window = mode === "soft" && tick >= cycles - k
        for (let i = 0; i < 3; i += 1) {
          const entry = legs[i].entry ?? prices[i]
          const noPrice = prices[i] === null
          const outOfBand = i === stableLeg && !noPrice && Math.abs(prices[i] - 1) + bandAdd > band
          const isProtected = !noPrice && prices[i] <= entry * (1 - threshold)
          const complete = legs[i].done >= legs[i].n
          const ctx = `basket ${basket} tick ${tick} leg ${i}`
          assert.ok(count[i] <= CHUNKS_PER_LEG_PER_TICK, `${ctx}: ${count[i]} picks`)
          assert.ok(legs[i].done + count[i] <= legs[i].n, `${ctx}: done ${legs[i].done} + ${count[i]} > n ${legs[i].n}`)
          if (noPrice) assert.equal(count[i], 0, `${ctx}: picked with no price`)
          if (outOfBand) assert.equal(count[i], 0, `${ctx}: picked out of band`)
          if (isProtected && !window) assert.equal(count[i], 0, `${ctx}: picked while rule 9 blocks`)
          // The per-leg values, recomputed here from the inputs alone.
          const got = out.perLeg[i]
          const variation = noPrice || legs[i].last === null ? null : prices[i] / legs[i].last - 1
          assert.ok(Object.is(got.variation, variation), `${ctx}: variation ${got.variation}, expected ${variation}`)
          assert.equal(got.protected, isProtected, `${ctx}: protected`)
          assert.equal(got.inBand, i === stableLeg && !noPrice ? !outOfBand : null, `${ctx}: inBand`)
          const blocked = complete ? "complete" : noPrice ? "no_price" : outOfBand ? "band" : isProtected && !window ? "rule9" : null
          if (blocked !== null) assert.equal(got.reason, blocked, `${ctx}: reason`)
          else assert.ok(["picked", "cooldown", "not_due"].includes(got.reason), `${ctx}: reason ${got.reason}`)
          assert.equal(got.reason === "picked", count[i] > 0, `${ctx}: "picked" exactly for a picked leg`)
          if (got.reason === "cooldown") assert.equal(i, cooldown, `${ctx}: only the previous first leg is in cooldown`)
          if (tick === 0) assert.equal(legs[i].entry, null, `${ctx}: no entry before tick 0`)
          seen.noPrice += noPrice && !complete ? 1 : 0
          seen.outOfBand += outOfBand && !complete ? 1 : 0
          seen.rule9Blocked += isProtected && !window && !complete ? 1 : 0
          seen.softWindowProtectedPick += isProtected && window && count[i] > 0 ? 1 : 0
          seen.twoOfOneLeg += count[i] === 2 ? 1 : 0
          seen.noReference += tick === 0 && reference[i] === null ? 1 : 0
          seen.firstVariationAgainstReference += legs[i].entry === null && !noPrice && legs[i].last === reference[i] && reference[i] !== null ? 1 : 0
          seen.cooldownReason += got.reason === "cooldown" ? 1 : 0
          seen.notDue += got.reason === "not_due" ? 1 : 0
        }
        seen.firstPickNotLeg0 += tick === 0 && out.picks.length > 0 && out.picks[0].leg !== 0 ? 1 : 0
        if (tick === 0 && buyNow && out.picks.length > 0) {
          const firstPriced = prices.findIndex((x, i) => x !== null && !(i === stableLeg && out.perLeg[i].inBand === false))
          assert.equal(out.picks[0].leg, firstPriced, `basket ${basket}: no reference, the first eligible leg in index order buys first`)
        }
        assert.ok(out.idleReason !== IDLE_REASONS.RULE5, "rule 5 never empties a tick")
        seen.idle += out.picks.length === 0 ? 1 : 0
        // next: n and done as given, last = this tick's price where there is one, entry = the first TICK price ever.
        out.next.legs.forEach((leg, i) => {
          assert.equal(leg.n, legs[i].n)
          assert.equal(leg.done, legs[i].done)
          assert.equal(leg.last, prices[i] ?? legs[i].last)
          assert.equal(leg.entry, legs[i].entry ?? prices[i])
        })
        assert.equal(out.next.cooldown, out.picks.length > 0 ? out.picks[0].leg : null)
        // Execute each pick with probability 0.8: a failed one stays due.
        legs = out.next.legs.map((leg, i) => ({ ...leg, done: leg.done + out.picks.filter((x) => x.leg === i && rnd() < 0.8).length }))
        cooldown = out.next.cooldown
      }
    }
    for (const [what, times] of Object.entries(seen)) assert.ok(times > 0, `the property test never met: ${what}`)
  })
})

// ------------------------------------------------------------------------------------------------ invalid input
describe("invalid input throws (a throw means: decide nothing, execute nothing)", () => {
  const w = SPLITS["25-25-50"]
  const legs = () => freshLegs([2, 2, 5], [null, null, null])
  const good = () => ({
    params: { cycles: 9, mode: "soft", threshold: 0.25, stableLeg: 2, band: 0.01 },
    tick: 0,
    legs: legs(),
    cooldown: null,
    prices: [100, 10, 1],
    bandAdd: 0.003,
  })
  const variant = (change) => {
    const x = good()
    change(x)
    return x
  }
  const sparse = (array, hole) => {
    const copy = array.slice()
    delete copy[hole] // a hole, not undefined: map and forEach skip it
    return copy
  }

  test("the good input is accepted, with a reference too (last set, entry null at tick 0), and mid-basket", () => {
    assert.equal(decideTick(good()).picks.length, 1)
    assert.equal(decideTick(variant((x) => { x.legs[0].last = 98 })).picks.length, 1)
    assert.equal(decideTick(variant((x) => { x.legs.forEach((leg, i) => { leg.last = [98, 11, 1][i] }) })).picks.length, 1)
    assert.equal(decideTick(variant((x) => { x.tick = 1; x.legs[0].last = 98; x.legs[0].entry = 97 })).picks.length, 2)
    assert.equal(decideTick(variant((x) => { x.tick = 1; x.legs[0].last = 98 })).picks.length, 2, "a reference, and no price at tick 0")
  })

  test("chooseN: weights not summing to 1, a leg above 50%, zero or fractional parts, NaN or negative numbers", () => {
    const bad = [
      [[[1, 4], [1, 4], [1, 4]], 1000, 9, 16],
      [[[3, 5], [1, 5], [1, 5]], 1000, 9, 16],
      [[[0, 2], [1, 2], [1, 2]], 1000, 9, 16],
      [[[1.5, 4], [1, 4], [1, 2]], 1000, 9, 16],
      [[[1, 4], [1, 4]], 1000, 9, 16],
      [[0.25, 0.25, 0.5], 1000, 9, 16],
      [w, Number.NaN, 9, 16],
      [w, -1000, 9, 16],
      [w, 0, 9, 16],
      [w, 1000, 0, 16],
      [w, 1000, -9, 16],
      [w, 1000, 9.5, 16],
      [w, 1000, Number.NaN, 16],
      [w, 1000, 9, 0],
      [w, 1000, 9, -3],
      [w, 1000, 9, Number.NaN],
      [w, "1000", 9, 16],
    ]
    for (const args of bad) assert.throws(() => chooseN(...args), /basket-scheduler/, JSON.stringify(args))
  })

  test("kSoft and legAmounts: N not a positive integer; capital not a positive bigint; bad weights", () => {
    for (const N of [0, -1, 1.5, Number.NaN, "6", 10_001]) assert.throws(() => kSoft(N), /basket-scheduler/, String(N))
    for (const C of [100, 0n, -5n, "100"]) assert.throws(() => legAmounts(C, w), /basket-scheduler/, String(C))
    assert.throws(() => legAmounts(100n, [[1, 2], [1, 2], [1, 2]]), /sum to exactly 1/)
    assert.throws(() => legAmounts(100n, [[3, 5], [1, 5], [1, 5]]), /above 50%/)
  })

  test("a sparse array throws the module's own error, for prices, legs and weights: a hole is never read as \"no price\"", () => {
    const ours = (what) => ({ name: "TypeError", message: new RegExp(`^basket-scheduler: ${what}`) })
    for (const hole of [0, 1, 2]) {
      assert.throws(() => decideTick(variant((x) => { x.prices = sparse(x.prices, hole) })), ours(`prices\\[${hole}\\] must be a number or null, got undefined`))
      assert.throws(() => decideTick(variant((x) => { x.legs = sparse(x.legs, hole) })), ours(`legs\\[${hole}\\] must be an object`))
      assert.throws(() => chooseN(sparse(w, hole), 1000, 9, 16), ours(`weights\\[${hole}\\] must be a \\[numerator, denominator\\] pair`))
      assert.throws(() => legAmounts(1000n, sparse(w, hole)), ours(`weights\\[${hole}\\] must be a \\[numerator, denominator\\] pair`))
    }
    assert.throws(() => chooseN([sparse([1, 4], 0), [1, 4], [1, 2]], 1000, 9, 16), ours("weights\\[0\\]\\[0\\] must be a number, got undefined"))
    // The length is right in every case above; a wrong length is refused too.
    assert.throws(() => decideTick(variant((x) => { x.prices = new Array(3) })), ours("prices\\[0\\]"))
    assert.throws(() => decideTick(variant((x) => { x.prices = new Array(4).fill(1) })), ours("prices must be an array of 3"))
  })

  test("a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned", () => {
    const huge = { name: "RangeError", message: /^basket-scheduler: legs\[0\]: the variation of price 1e\+308 against last 1e-308 is not finite$/ }
    const withLast = (change = () => {}) => variant((x) => {
      x.legs[0].last = 1e-308 // a valid price, and so is 1e308: their quotient overflows
      x.prices[0] = 1e308
      change(x)
    })
    assert.equal(1e308 / 1e-308 - 1, Number.POSITIVE_INFINITY)
    assert.throws(() => decideTick(withLast()), huge, "eligible, a chunk due")
    assert.throws(() => decideTick(withLast((x) => { x.legs[0].done = x.legs[0].n })), huge, "the leg is complete")
    assert.throws(() => decideTick(withLast((x) => { x.legs[1].done = 1 })), huge, "nothing is due this tick")
    assert.throws(() => decideTick(withLast((x) => { x.tick = 3; x.legs[0].entry = 1e308 })), huge, "mid-basket, protected or not")
    // The largest finite quotient is still accepted.
    const large = decideTick(variant((x) => { x.legs[0].last = 1e-300; x.prices[0] = 1e7 })).perLeg[0].variation
    assert.ok(Number.isFinite(large) && large > 1e306, String(large))
  })

  test("decideTick: NaN, negative or missing prices; done > n; an entry at tick 0 or without last; a tick, mode, threshold, band or cooldown out of range", () => {
    const cases = {
      "price NaN": (x) => { x.prices[0] = Number.NaN },
      "price negative": (x) => { x.prices[1] = -10 },
      "price zero": (x) => { x.prices[1] = 0 },
      "price Infinity": (x) => { x.prices[1] = Number.POSITIVE_INFINITY },
      "price missing (undefined, not null)": (x) => { x.prices[2] = undefined },
      "prices of 2 legs": (x) => { x.prices = [100, 10] },
      "done > n": (x) => { x.legs[0].done = 3 },
      "done negative": (x) => { x.legs[0].done = -1 },
      "n zero": (x) => { x.legs[1].n = 0 },
      "entry at tick 0 (the reference passed as entry)": (x) => { x.legs[0].last = 100; x.legs[0].entry = 100 },
      "entry without last": (x) => { x.tick = 1; x.legs[0].entry = 100 },
      "entry NaN": (x) => { x.tick = 1; x.legs[0].entry = Number.NaN; x.legs[0].last = 100 },
      "last zero": (x) => { x.legs[0].last = 0 },
      "last missing (undefined, not null)": (x) => { delete x.legs[0].last },
      "two legs": (x) => { x.legs.pop() },
      "a leg that is null": (x) => { x.legs[1] = null },
      "tick past the last grace tick": (x) => { x.tick = 12 },
      "tick negative": (x) => { x.tick = -1 },
      "tick fractional": (x) => { x.tick = 0.5 },
      "cooldown 3": (x) => { x.cooldown = 3 },
      "cooldown missing (undefined, not null)": (x) => { x.cooldown = undefined },
      "mode unknown": (x) => { x.params.mode = "hard" },
      "threshold NaN": (x) => { x.params.threshold = Number.NaN },
      "threshold negative": (x) => { x.params.threshold = -0.25 },
      "threshold 1": (x) => { x.params.threshold = 1 },
      "cycles 0": (x) => { x.params.cycles = 0 },
      "stable leg 3": (x) => { x.params.stableLeg = 3 },
      "stable leg missing (undefined, not null)": (x) => { delete x.params.stableLeg },
      "band missing with a stable leg": (x) => { x.params.band = null },
      "band 0": (x) => { x.params.band = 0 },
      "band negative": (x) => { x.params.band = -0.01 },
      "bandAdd missing with a stable leg": (x) => { x.bandAdd = undefined },
      "bandAdd negative": (x) => { x.bandAdd = -0.003 },
      "bandAdd NaN": (x) => { x.bandAdd = Number.NaN },
    }
    for (const [name, change] of Object.entries(cases)) {
      assert.throws(() => decideTick(variant(change)), /^(TypeError|RangeError): basket-scheduler: /, name)
    }
    assert.throws(() => decideTick(null), TypeError)
    assert.throws(
      () => decideTick(variant((x) => { x.legs[0].last = 100; x.legs[0].entry = 100 })),
      { name: "RangeError", message: /legs\[0\]\.entry must be null at tick 0: the reference goes in last/ },
    )
  })
})
