// basket-scheduler.js — Basket DCA: which leg sells a chunk at each tick. Pure: no I/O, no clock, no network, no
// database, no randomness. Nothing imports it yet; the keeper wiring is a later goal (SPEC-BASKET-DCA §10 item 3).
//
// SPEC-BASKET-DCA §3.1-3.2 (amount and chunk count per leg), §4 and §4a (selection per tick); ADR-027. A basket is
// three ordinary V3 DCA orders, one per leg. The contract enforces the fixed chunk, at most n_i chunks, at most one
// chunk per leg per T / 2 and nothing after expiry; which legs sell at a given tick is the keeper's decision, and this
// module is that decision.
//
// Reference: `engine_discrete.run_discrete` of the analyst package (v3.2) with L = 2, rule = 'hamilton' and
// k_soft = max(1, ceil(N / 4)). Where the spec's prose and the engine differ, this module follows the engine; the
// differences are listed in docs/feedback/feat-basket-selection-module.md and feat-basket-selection-reference.md. The
// vectors in fixtures/basket-dca/ (written by scripts/basket-dca/export_vectors.py from the engine copy kept beside
// them) pin it pick for pick, down to the engine's floating point: the weights num / den as doubles, its +1e-9 / -1e-9
// guards, and numpy's round(v, 12) in the first-chunk sort, which is rint(v * 1e12) / 1e12, half to even (Python's
// round() on a float differs from it).
//
// State belongs to the caller: per leg { n, done, last, entry }, per basket the cooldown. `done` counts EXECUTED
// chunks (the order row), so decideTick never adds its own picks to it: a chunk that was picked and did not execute
// stays due, and the next tick picks it up (spec §4, last paragraph). Feed `next` back on the following tick with
// `done` refreshed from the orders. `peak` (spec §4, reporting only) is not kept here: it is the wiring's.
//
// The price reference (owner decision 2026-11-16, spec §4 "Reference"). In the default mode the keeper records each
// leg's price when the basket is created and buys nothing; the first purchase is one cycle later. That price is the
// engine's `pd0`: it is the leg's `last` at tick 0, so the first variation compares against it, as in every analyst
// run. It is NOT rule 9's entry: the engine sets `entry` at the leg's first TICK with a price whatever pd0 is
// (engine_discrete.py:64 and :71), and the owner chose to follow the engine. So the state at tick 0 is
// { last: reference, entry: null }. A leg with no reference ("buy the first one now" mode, or no price at creation)
// starts { last: null, entry: null }: it has no previous price, its variation counts as 0, and when no leg has one
// the ties give tick 0's first chunk to leg 0, which is what that mode relies on.
//
// Invalid input throws (TypeError: wrong type or shape; RangeError: a value out of range). A throw means "decide
// nothing, execute nothing", never a default.

const LEGS = 3
const LEG_INDEXES = [0, 1, 2]

/** Grace ticks after the N nominal ones: ticks are t = 0 … N + 2 (spec §4). */
export const GRACE_TICKS = 3

/** L: at most 2 chunks of one leg per tick, because dcaInterval = T / 2 (spec §3.4, §4.7-4.8). */
export const CHUNKS_PER_LEG_PER_TICK = 2

/** Sanity bound on N and on a leg's n. The product's largest N is 86 (spec §2); the bound keeps every integer the
 *  calendar multiplies exact in a double. */
const MAX_CYCLES = 10_000

/** Why a tick bought nothing (spec §4.10, §4a). `rule5` exists because the engine names it, but rule 5 only reorders
 *  two or more eligible legs, so the engine can never return it. */
export const IDLE_REASONS = Object.freeze({
  CALENDAR: "calendar",
  COMPLETE: "complete",
  NO_PRICE: "no_price",
  BAND: "band",
  RULE9: "rule9",
  RULE5: "rule5",
})

/** Why one leg did or did not buy at a tick (`perLeg[i].reason`). The first match wins, in this order: picked (at
 *  least one chunk); complete (done = n); no_price; band (the stable leg, out of band); rule9 (protected and still
 *  blocking); cooldown (eligible, first in the rule 4 order, sent to the back of the line by rule 5 and not picked);
 *  not_due (eligible and not picked for any other reason: nothing was due, or the chunks due went to legs ahead). */
export const LEG_REASONS = Object.freeze({
  PICKED: "picked",
  COMPLETE: "complete",
  NO_PRICE: "no_price",
  BAND: "band",
  RULE9: "rule9",
  COOLDOWN: "cooldown",
  NOT_DUE: "not_due",
})

// ------------------------------------------------------------------------------------------------ input checks
function fail(Type, message) {
  throw new Type(`basket-scheduler: ${message}`)
}

function show(x) {
  return typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" ? String(x) : typeof x
}

/** An array of exactly `length` items, each read BY INDEX: a hole in a sparse array reaches `read` as undefined and
 *  is refused there, where map and forEach would skip it in silence. */
function arrayOf(name, x, length, what, read) {
  if (!Array.isArray(x) || x.length !== length) fail(TypeError, `${name} must be an array of ${length}${what}`)
  const out = []
  for (let i = 0; i < length; i += 1) out[i] = read(x[i], i)
  return out
}

function integerIn(name, x, min, max) {
  if (typeof x !== "number") fail(TypeError, `${name} must be a number, got ${show(x)}`)
  if (!Number.isSafeInteger(x) || x < min || x > max) fail(RangeError, `${name} must be an integer in [${min}, ${max}], got ${x}`)
}

function positiveFinite(name, x) {
  if (typeof x !== "number") fail(TypeError, `${name} must be a number, got ${show(x)}`)
  if (!Number.isFinite(x) || x <= 0) fail(RangeError, `${name} must be a positive finite number, got ${x}`)
}

function priceOrNull(name, x) {
  if (x === null) return
  if (typeof x !== "number") fail(TypeError, `${name} must be a number or null, got ${show(x)}`)
  if (!Number.isFinite(x) || x <= 0) fail(RangeError, `${name} must be a positive finite number or null, got ${x}`)
}

function fractionIn(name, x, { open }) {
  if (typeof x !== "number") fail(TypeError, `${name} must be a number, got ${show(x)}`)
  if (!Number.isFinite(x) || x >= 1 || (open ? x <= 0 : x < 0)) {
    fail(RangeError, `${name} must be in ${open ? "(0, 1)" : "[0, 1)"}, got ${x}`)
  }
}

/** [[num, den] × 3] → the same pairs as bigints, after the checks: positive safe integers, no leg above 50%, sum
 *  exactly 1 (integer arithmetic, so thirds are thirds). */
function weightFractions(weights) {
  const fr = arrayOf("weights", weights, LEGS, " [numerator, denominator] pairs", (pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) fail(TypeError, `weights[${i}] must be a [numerator, denominator] pair`)
    integerIn(`weights[${i}][0]`, pair[0], 1, Number.MAX_SAFE_INTEGER)
    integerIn(`weights[${i}][1]`, pair[1], 1, Number.MAX_SAFE_INTEGER)
    const num = BigInt(pair[0])
    const den = BigInt(pair[1])
    if (2n * num > den) fail(RangeError, `weights[${i}] is ${pair[0]}/${pair[1]}, above 50%`)
    return [num, den]
  })
  const [[a, b], [c, d], [e, f]] = fr
  if (a * d * f + c * b * f + e * b * d !== b * d * f) fail(RangeError, "weights must sum to exactly 1")
  return fr
}

// ------------------------------------------------------------------------------------------------ per order (§3)
/**
 * k_soft: in soft mode, rule 9 stops blocking from tick N − k_soft on, and in the grace ticks (spec §4.3).
 * @param {number} cycles N, a positive integer
 * @returns {number} max(1, ceil(N / 4)), no cap
 */
export function kSoft(cycles) {
  integerIn("cycles", cycles, 1, MAX_CYCLES)
  return Math.max(1, Math.ceil(cycles / 4))
}

/**
 * n_i, the chunks of each leg (its `dcaTotal`), spec §3.2 as the engine computes it (`choose_n`, rule 'hamilton'):
 * floor(w_i × N + 1e-9); the units missing to reach N go to the largest remainders (ties: lower leg); then
 * max(n_i, 1); then min(n_i, max(1, floor(w_i × C ÷ minFill + 1e-9))). Weights become doubles num / den first, as in
 * every analyst run, so the arithmetic is the engine's to the last bit.
 * @param {Array<[number, number]>} weights three [numerator, denominator] pairs
 * @param {number} capitalUsd C in USD, > 0
 * @param {number} cycles N, a positive integer
 * @param {number} minFillUsd one value for the three legs, > 0 (the engine takes one; spec §3.3 sets it per leg's route)
 * @returns {number[]} n per leg
 */
export function chooseN(weights, capitalUsd, cycles, minFillUsd) {
  const w = weightFractions(weights).map(([num, den]) => Number(num) / Number(den))
  positiveFinite("capitalUsd", capitalUsd)
  integerIn("cycles", cycles, 1, MAX_CYCLES)
  positiveFinite("minFillUsd", minFillUsd)
  const raw = w.map((x) => x * cycles)
  const n = raw.map((x) => Math.floor(x + 1e-9))
  const missing = cycles - (n[0] + n[1] + n[2])
  const byRemainder = LEG_INDEXES.slice().sort((a, b) => compareKeys([-(raw[a] - n[a])], [-(raw[b] - n[b])]) || a - b)
  for (const i of byRemainder.slice(0, Math.max(missing, 0))) n[i] += 1
  return n.map((ni, i) => Math.min(Math.max(ni, 1), Math.max(Math.floor((w[i] * capitalUsd) / minFillUsd + 1e-9), 1)))
}

/**
 * amountIn of each leg order (spec §3.1): legs 1 and 2 floor(w_i × C), leg 3 the rest, so the three sum to C exactly.
 * Throws when a leg would get nothing: a basket needs a capital that gives every leg at least one unit (spec §4,
 * rules for the wiring), and an order of amount 0 must never be signed.
 * @param {bigint} capitalUnits C in units of the token sold, > 0
 * @param {Array<[number, number]>} weights three [numerator, denominator] pairs
 * @returns {bigint[]} three amounts, each > 0
 */
export function legAmounts(capitalUnits, weights) {
  if (typeof capitalUnits !== "bigint") fail(TypeError, `capitalUnits must be a bigint (token units), got ${show(capitalUnits)}`)
  if (capitalUnits <= 0n) fail(RangeError, `capitalUnits must be positive, got ${capitalUnits}`)
  const fr = weightFractions(weights)
  const first = (capitalUnits * fr[0][0]) / fr[0][1]
  const second = (capitalUnits * fr[1][0]) / fr[1][1]
  const amounts = [first, second, capitalUnits - first - second]
  for (const i of LEG_INDEXES) {
    if (amounts[i] <= 0n) fail(RangeError, `capitalUnits ${capitalUnits} leaves leg ${i} with amount ${amounts[i]}; every leg needs at least one unit`)
  }
  return amounts
}

/**
 * The variation key of the first-chunk sort: numpy's round(np.float64(v), 12), i.e. rint(v × 1e12) ÷ 1e12 with
 * ties to even. Exported so the tests can hold it to numpy's own outputs (fixtures/basket-dca/rounding.json).
 * @param {number} v a finite number
 * @returns {number}
 */
export function roundVariation(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(TypeError, `roundVariation needs a finite number, got ${show(v)}`)
  const x = v * 1e12
  const r = Math.round(x) // ties go up; for |x| < 2^52, r − x is exact
  return (r - x === 0.5 && r % 2 !== 0 ? r - 1 : r) / 1e12
}

// ------------------------------------------------------------------------------------------------ per tick (§4)
function compareKeys(a, b) {
  for (let j = 0; j < a.length; j += 1) {
    if (a[j] < b[j]) return -1
    if (a[j] > b[j]) return 1
  }
  return 0
}

function readParams(params) {
  if (params === null || typeof params !== "object") fail(TypeError, "params must be an object")
  const { cycles, mode, threshold, stableLeg, band } = params
  integerIn("params.cycles", cycles, 1, MAX_CYCLES)
  if (mode !== "soft" && mode !== "rigid") fail(RangeError, `params.mode must be "soft" or "rigid", got ${show(mode)}`)
  fractionIn("params.threshold", threshold, { open: false })
  if (stableLeg !== null) {
    // Explicit null when there is no stable leg: a missing field must not silently switch the band off.
    integerIn("params.stableLeg", stableLeg, 0, LEGS - 1)
    fractionIn("params.band", band, { open: true })
  } else if (band !== null && band !== undefined) {
    fractionIn("params.band", band, { open: true }) // checked, and unused without a stable leg
  }
  return { cycles, mode, threshold, stableLeg, band }
}

function readLegs(legs, tick) {
  return arrayOf("legs", legs, LEGS, "", (leg, i) => {
    if (leg === null || typeof leg !== "object") fail(TypeError, `legs[${i}] must be an object`)
    const { n, done, last, entry } = leg
    integerIn(`legs[${i}].n`, n, 1, MAX_CYCLES)
    integerIn(`legs[${i}].done`, done, 0, MAX_CYCLES)
    if (done > n) fail(RangeError, `legs[${i}].done is ${done}, above n ${n}`)
    priceOrNull(`legs[${i}].last`, last)
    priceOrNull(`legs[${i}].entry`, entry)
    // `last` alone is the reference (or a leg that has not had a price at a tick yet). `entry` alone cannot happen:
    // the tick that sets a leg's entry sets its last too.
    if (entry !== null && last === null) fail(RangeError, `legs[${i}]: entry is set without last; a leg's first tick with a price sets both`)
    // Nor can any leg have an entry before tick 0. This is the mistake the spec's wording invites: the reference is
    // `last`, never `entry` (the engine's entry starts empty whatever pd0 is).
    if (entry !== null && tick === 0) {
      fail(RangeError, `legs[${i}].entry must be null at tick 0: the reference goes in last, and entry is the leg's first tick with a price`)
    }
    return { n, done, last, entry }
  })
}

function readPrices(prices) {
  return arrayOf("prices", prices, LEGS, " (a price or null)", (x, i) => {
    priceOrNull(`prices[${i}]`, x)
    return x
  })
}

function readBandAdd(bandAdd, stableLeg) {
  if (stableLeg === null && (bandAdd === undefined || bandAdd === null)) return 0
  if (typeof bandAdd !== "number") {
    fail(TypeError, `bandAdd must be a number: the stable feed's deviation threshold when the feed decides, else 0; got ${show(bandAdd)}`)
  }
  if (!Number.isFinite(bandAdd) || bandAdd < 0) fail(RangeError, `bandAdd must be a finite number >= 0, got ${bandAdd}`)
  return bandAdd
}

/**
 * Decide one tick of one basket (spec §4, §4a). Never mutates its input.
 *
 * @param {object} input
 * @param {{ cycles: number, mode: "soft"|"rigid", threshold: number, stableLeg: 0|1|2|null, band?: number|null }} input.params
 *   N; rule 9 mode and threshold (0.25 = 25%); the stable leg and its band (required with a stable leg), or null
 * @param {number} input.tick t, 0 … N + 2; tick 0 is the first tick that may buy (one cycle after creation in the
 *   default mode, at creation in "buy the first one now" mode)
 * @param {Array<{ n: number, done: number, last: number|null, entry: number|null }>} input.legs
 *   n = the order's dcaTotal; done = chunks EXECUTED (order row); last = the leg's previous price: the REFERENCE
 *   recorded at creation until the leg has had a price at a tick, then its decision price at its previous tick with a
 *   price; null = no previous price at all (no reference); entry = rule 9's base, the leg's decision price at its
 *   first TICK with a price; null before that, so always null at tick 0. The reference never sets entry
 * @param {0|1|2|null} input.cooldown the leg PICKED for the first chunk of the previous tick, whether or not that
 *   chunk executed (null if that tick picked nothing, or was missed)
 * @param {Array<number|null>} input.prices the decision price per leg; null = no usable price. A volatile leg: its
 *   ADR-024 resolved price. The stable leg: its §4a price, which comes PAIRED with `bandAdd`: its own USD feed while
 *   that feed is within its maxStaleness, with bandAdd = the feed's deviation threshold; otherwise the quorum price,
 *   with bandAdd = 0
 * @param {number} [input.bandAdd] the other half of that pair; required with a stable leg (spec §4a)
 * @returns {{
 *   picks: Array<{ leg: number, kind: "select"|"catchup", slot: 1|2 }>,
 *   idleReason: string|null,
 *   perLeg: Array<{ variation: number|null, protected: boolean, inBand: boolean|null, reason: string }>,
 *   next: { legs: Array<{ n: number, done: number, last: number|null, entry: number|null }>, cooldown: number|null },
 * }} picks in decision order; slot 1 = the leg's first chunk of the tick (first slot), 2 = its second (+ T ÷ 2);
 *   idleReason (one of IDLE_REASONS) only when nothing was picked.
 *   perLeg[i] = the values this decision used for leg i, for the journal to store as they are and never recompute:
 *   variation = price ÷ last − 1, unrounded (null: no price, or no previous price, where the leg ranks as 0);
 *   protected = price ≤ entry × (1 − threshold), false without a price, reported in the soft window too, where it
 *   no longer blocks; inBand = the stable leg's band verdict (null for the other legs and when it has no price);
 *   reason = one of LEG_REASONS.
 *   next.legs keeps n and done as given (done comes from the orders) and updates last and entry; next.cooldown is
 *   the first PICKED leg (picks[0].leg), null when nothing was picked
 */
export function decideTick(input) {
  if (input === null || typeof input !== "object") fail(TypeError, "decideTick needs an object")
  const { params, tick, legs, cooldown, prices, bandAdd } = input
  const { cycles: N, mode, threshold, stableLeg: s, band } = readParams(params)
  integerIn("tick", tick, 0, N + GRACE_TICKS - 1)
  const state = readLegs(legs, tick)
  if (cooldown !== null) integerIn("cooldown", cooldown, 0, LEGS - 1)
  const px = readPrices(prices)
  const add = readBandAdd(bandAdd, s)

  // §4.1-4.4: price, variation, protection, eligibility. A leg's first tick with a price sets its entry before the
  // protection check. The variation is against `last`: the reference at the leg's first tick, null (ranked as 0)
  // for a leg that has no previous price.
  const usable = px.map((x) => x !== null)
  const entry = state.map((leg, i) => (leg.entry === null && usable[i] ? px[i] : leg.entry))
  const variation = state.map((leg, i) => {
    if (!usable[i] || leg.last === null) return null
    const v = px[i] / leg.last - 1
    // Two valid prices can be 300 orders of magnitude apart, and then the quotient overflows: not a number to rank
    // a leg by or to write in the journal.
    if (!Number.isFinite(v)) fail(RangeError, `legs[${i}]: the variation of price ${px[i]} against last ${leg.last} is not finite`)
    return v
  })
  const isProtected = state.map((_, i) => usable[i] && px[i] <= entry[i] * (1 - threshold))
  const softWindow = mode === "soft" && tick >= N - kSoft(N)
  const outOfBand = s !== null && usable[s] && Math.abs(px[s] - 1) + add > band
  const whyNot = (i) => {
    if (state[i].done >= state[i].n) return IDLE_REASONS.COMPLETE
    if (!usable[i]) return IDLE_REASONS.NO_PRICE
    if (outOfBand && i === s) return IDLE_REASONS.BAND
    if (isProtected[i] && !softWindow) return IDLE_REASONS.RULE9
    return null
  }
  const eligible = LEG_INDEXES.filter((i) => whyNot(i) === null)

  // §4.5: the calendar counts executed chunks.
  const total = state.reduce((sum, leg) => sum + leg.n, 0)
  const executed = state.reduce((sum, leg) => sum + leg.done, 0)
  const dueTotal = tick >= N - 1 ? total : Math.min(total, Math.ceil((total * (tick + 1)) / N - 1e-9))
  const due = dueTotal - executed

  const picks = []
  const taken = [0, 0, 0]
  let displaced = null // the leg rule 5 sent to the back of the line
  if (due > 0 && eligible.length > 0) {
    // §4.6 rule 4: lowest variation (rounded to 12 decimals), then furthest behind its own count, then lower leg.
    const firstKey = (i) => [
      variation[i] === null ? 0 : roundVariation(variation[i]),
      -(state[i].n - state[i].done) / state[i].n,
    ]
    const order = eligible.slice().sort((a, b) => compareKeys(firstKey(a), firstKey(b)) || a - b)
    // Rule 5: the previous tick's first leg goes to the back of the line when another leg is eligible.
    if (cooldown !== null && order.length > 1 && order[0] === cooldown) displaced = cooldown
    const first = displaced === null ? order[0] : order[1]
    picks.push(first)
    taken[first] += 1
    // §4.7 catch-up: furthest behind its own count once this tick's picks are counted, then the lowest RAW variation
    // (the engine does not round here), then lower leg; at most 2 per leg per tick and never beyond n.
    const catchKey = (i) => [(state[i].n - state[i].done - taken[i]) / state[i].n, -(variation[i] ?? 0)]
    while (picks.length < due) {
      let best = null
      for (const i of eligible) {
        if (taken[i] >= CHUNKS_PER_LEG_PER_TICK || state[i].done + taken[i] >= state[i].n) continue
        if (best === null || compareKeys(catchKey(i), catchKey(best)) > 0) best = i
      }
      if (best === null) break
      picks.push(best)
      taken[best] += 1
    }
  }

  // §4.10 + §4a: why nothing was picked.
  let idleReason = null
  if (picks.length === 0) {
    if (due <= 0) {
      idleReason = executed < total ? IDLE_REASONS.CALENDAR : IDLE_REASONS.COMPLETE
    } else {
      const reasons = LEG_INDEXES.filter((i) => state[i].done < state[i].n).map(whyNot)
      idleReason =
        reasons.length === 0
          ? IDLE_REASONS.COMPLETE
          : ([IDLE_REASONS.NO_PRICE, IDLE_REASONS.BAND, IDLE_REASONS.RULE9].find((r) => reasons.includes(r)) ??
            IDLE_REASONS.RULE5)
    }
  }

  // Why each leg did or did not buy (LEG_REASONS). whyNot's four codes are the same strings in both tables.
  const reasonOf = (i) => {
    if (taken[i] > 0) return LEG_REASONS.PICKED
    return whyNot(i) ?? (i === displaced ? LEG_REASONS.COOLDOWN : LEG_REASONS.NOT_DUE)
  }

  const slotsUsed = [0, 0, 0]
  return {
    picks: picks.map((leg, j) => {
      slotsUsed[leg] += 1
      return { leg, kind: j === 0 ? "select" : "catchup", slot: slotsUsed[leg] }
    }),
    idleReason,
    perLeg: LEG_INDEXES.map((i) => ({
      variation: variation[i],
      protected: isProtected[i],
      inBand: i === s && usable[i] ? !outOfBand : null,
      reason: reasonOf(i),
    })),
    next: {
      // §4.9: last = this tick's price for every leg that had one; done is the caller's to refresh from the orders.
      legs: state.map((leg, i) => ({ n: leg.n, done: leg.done, last: usable[i] ? px[i] : leg.last, entry: entry[i] })),
      cooldown: picks.length > 0 ? picks[0] : null,
    },
  }
}
