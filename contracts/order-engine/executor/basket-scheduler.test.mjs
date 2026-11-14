// Tests for basket-scheduler.js — the Basket DCA selection rules (SPEC-BASKET-DCA §3.1-3.2, §4, §4a; ADR-027).
//
// The reference is the analyst's engine, `engine_discrete.run_discrete` (v3.2). scripts/basket-dca/export_vectors.py
// runs it and writes fixtures/basket-dca/*.json (the engine's sha256 in every header). This file replays every vector
// tick by tick, feeding `next` back and counting each pick as executed, and requires the engine's picks, kinds, idle
// reasons, n and done. Beyond the engine: a pick that did not execute stays due, a restart decides the same, the
// same input gives the same output and is never mutated, a seeded property test holds the limits on random baskets,
// and invalid input throws.
//
// Pure: no I/O besides reading the fixtures, no clock, no network. Runs on Node 20 and 22 (keeper-tests.yml, ci.yml).

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  CHUNKS_PER_LEG_PER_TICK,
  GRACE_TICKS,
  IDLE_REASONS,
  chooseN,
  decideTick,
  kSoft,
  legAmounts,
  roundVariation,
} from "./basket-scheduler.js"

const ENGINE_SHA256 = "282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685"
const RUN_FAMILIES = ["calm", "fall", "no-price", "band", "min-fill", "ties", "mixed"]
const SPLITS = {
  "25-25-50": [[1, 4], [1, 4], [1, 2]],
  "40-40-20": [[2, 5], [2, 5], [1, 5]],
  "33-33-33": [[1, 3], [1, 3], [1, 3]],
  "30-30-40": [[3, 10], [3, 10], [2, 5]],
}

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/basket-dca/${name}.json`, import.meta.url), "utf8"))
}

const RUNS = RUN_FAMILIES.map((family) => ({ family, ...fixture(family) }))
const VECTORS = RUNS.flatMap((f) => f.vectors.map((v) => ({ family: f.family, ...v })))

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

/**
 * Run a vector from `start` (default: tick 0, fresh legs) to its last grace tick. `executes(t, pick)` says whether a
 * picked chunk executed (default: every pick does, as in the engine); only executed chunks advance `done`.
 */
function replay(input, { executes = () => true, start } = {}) {
  const n = chooseN(input.weights, input.capitalUsd, input.cycles, input.minFillUsd)
  let legs = start?.legs ?? n.map((ni) => ({ n: ni, done: 0, last: null, entry: null }))
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

// ------------------------------------------------------------------------------------------------ provenance
describe("fixtures: provenance", () => {
  test("every fixture comes from the same pinned engine, run with L = 2, Hamilton, k_soft = max(1, ceil(N / 4))", () => {
    for (const name of [...RUN_FAMILIES, "choose-n", "rounding"]) {
      const { header } = fixture(name)
      assert.equal(header.engine.sha256, ENGINE_SHA256, name)
      assert.equal(header.engine.file, "engine_discrete.py", name)
      assert.equal(header.generator, "scripts/basket-dca/export_vectors.py", name)
      assert.equal(header.run.L, CHUNKS_PER_LEG_PER_TICK, name)
      assert.equal(header.run.rule, "hamilton", name)
      assert.equal(header.run.kSoft, "max(1, ceil(N / 4))", name)
      assert.equal(header.run.graceTicks, GRACE_TICKS, name)
      assert.deepEqual(header.run.pd0, [null, null, null], name)
      assert.deepEqual(Object.values(header.idleReasons).sort(), Object.values(IDLE_REASONS).sort(), name)
    }
  })

  test("each run vector has N + 3 ticks of three prices, and a band_add per tick exactly when it has a stable leg", () => {
    assert.ok(VECTORS.length >= 70, `only ${VECTORS.length} vectors`)
    for (const v of VECTORS) {
      const { cycles, prices, stableLeg, bandAdd } = v.input
      assert.equal(prices.length, cycles + GRACE_TICKS, v.id)
      for (const row of prices) assert.equal(row.length, 3, v.id)
      if (stableLeg === null) assert.equal(bandAdd, null, v.id)
      else assert.equal(bandAdd.length, cycles + GRACE_TICKS, v.id)
    }
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

describe("legAmounts: legs 1 and 2 floored, leg 3 the rest", () => {
  test("the three amounts sum to the capital exactly, for every split and awkward capitals", () => {
    const capitals = [1n, 2n, 3n, 7n, 99n, 100n, 1_000_001n, 123_456_789n, 10n ** 24n + 7n]
    for (const [name, w] of Object.entries(SPLITS)) {
      for (const C of capitals) {
        const [a, b, c] = legAmounts(C, w)
        assert.equal(a + b + c, C, `${name} C=${C}`)
        assert.equal(a, (C * BigInt(w[0][0])) / BigInt(w[0][1]))
        assert.equal(b, (C * BigInt(w[1][0])) / BigInt(w[1][1]))
        assert.ok(c >= (C * BigInt(w[2][0])) / BigInt(w[2][1]), "leg 3 never gets less than its own floor")
      }
    }
  })

  test("thirds are thirds, not 0.33: 100 units -> 33, 33, 34; 1 000 USDC (6 decimals) 25-25-50 is exact", () => {
    assert.deepEqual(legAmounts(100n, SPLITS["33-33-33"]), [33n, 33n, 34n])
    assert.deepEqual(legAmounts(1_000_000_000n, SPLITS["25-25-50"]), [250_000_000n, 250_000_000n, 500_000_000n])
    assert.deepEqual(legAmounts(10n, SPLITS["30-30-40"]), [3n, 3n, 4n])
  })
})

// ------------------------------------------------------------------------------------------------ beyond the engine
describe("decideTick beyond the engine", () => {
  const flat = [100, 10, 1]
  const params = { cycles: 6, mode: "soft", threshold: 0.25, stableLeg: null, band: null }
  const fresh = () => [2, 2, 2].map((n) => ({ n, done: 0, last: null, entry: null }))

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

describe("seeded property test: the limits hold on random baskets, prices and failed executions", () => {
  test("never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked", () => {
    const rnd = mulberry32(0x5eed2611)
    const seen = { ticks: 0, noPrice: 0, outOfBand: 0, rule9Blocked: 0, twoOfOneLeg: 0, softWindowProtectedPick: 0, idle: 0 }
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
      let legs = n.map((ni) => ({ n: ni, done: 0, last: null, entry: null }))
      let cooldown = null
      const level = [50 + rnd() * 5000, 0.5 + rnd() * 50, 1 + rnd()]
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
          const ctx = `basket ${basket} tick ${tick} leg ${i}`
          assert.ok(count[i] <= CHUNKS_PER_LEG_PER_TICK, `${ctx}: ${count[i]} picks`)
          assert.ok(legs[i].done + count[i] <= legs[i].n, `${ctx}: done ${legs[i].done} + ${count[i]} > n ${legs[i].n}`)
          if (noPrice) assert.equal(count[i], 0, `${ctx}: picked with no price`)
          if (outOfBand) assert.equal(count[i], 0, `${ctx}: picked out of band`)
          if (isProtected && !window) assert.equal(count[i], 0, `${ctx}: picked while rule 9 blocks`)
          seen.noPrice += noPrice && legs[i].done < legs[i].n ? 1 : 0
          seen.outOfBand += outOfBand && legs[i].done < legs[i].n ? 1 : 0
          seen.rule9Blocked += isProtected && !window && legs[i].done < legs[i].n ? 1 : 0
          seen.softWindowProtectedPick += isProtected && window && count[i] > 0 ? 1 : 0
          seen.twoOfOneLeg += count[i] === 2 ? 1 : 0
        }
        assert.ok(out.idleReason !== IDLE_REASONS.RULE5, "rule 5 never empties a tick")
        seen.idle += out.picks.length === 0 ? 1 : 0
        // next: n and done as given, last = this tick's price where there is one, entry = the first price ever.
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
  const legs = () => [2, 2, 5].map((n) => ({ n, done: 0, last: null, entry: null }))
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

  test("the good input is accepted", () => {
    assert.equal(decideTick(good()).picks.length, 1)
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

  test("decideTick: NaN, negative or missing prices; done > n; a tick, mode, threshold, band or cooldown out of range", () => {
    const cases = {
      "price NaN": (x) => { x.prices[0] = Number.NaN },
      "price negative": (x) => { x.prices[1] = -10 },
      "price zero": (x) => { x.prices[1] = 0 },
      "price missing (undefined, not null)": (x) => { x.prices[2] = undefined },
      "prices of 2 legs": (x) => { x.prices = [100, 10] },
      "done > n": (x) => { x.legs[0].done = 3 },
      "done negative": (x) => { x.legs[0].done = -1 },
      "n zero": (x) => { x.legs[1].n = 0 },
      "last without entry": (x) => { x.legs[0].last = 100 },
      "entry NaN": (x) => { x.legs[0].entry = Number.NaN; x.legs[0].last = 100 },
      "two legs": (x) => { x.legs.pop() },
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
      assert.throws(() => decideTick(variant(change)), /basket-scheduler/, name)
    }
    assert.throws(() => decideTick(null), TypeError)
  })
})
