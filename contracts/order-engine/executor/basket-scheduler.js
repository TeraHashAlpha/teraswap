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
// differences are listed in docs/feedback/feat-basket-selection-module.md. The vectors in fixtures/basket-dca/
// (written by scripts/basket-dca/export_vectors.py) pin it pick for pick, down to the engine's floating point: the
// weights num / den as doubles, its +1e-9 / -1e-9 guards, and numpy's round(v, 12) in the first-chunk sort, which is
// rint(v * 1e12) / 1e12, half to even (Python's round() on a float differs from it).
//
// State belongs to the caller: per leg { n, done, last, entry }, per basket the cooldown. `done` counts EXECUTED
// chunks (the order row), so decideTick never adds its own picks to it: a chunk that was picked and did not execute
// stays due, and the next tick picks it up (spec §4, last paragraph). Feed `next` back on the following tick with
// `done` refreshed from the orders. Invalid input throws (TypeError: wrong type or shape; RangeError: a value out of
// range). A throw means "decide nothing, execute nothing", never a default.

const LEGS = 3
const LEG_INDEXES = [0, 1, 2]

/** Grace ticks after the N nominal ones: ticks are t = 0 … N + 2 (spec §4; expiry = t0 + (N + 3) × T + 3 600 s). */
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

// ------------------------------------------------------------------------------------------------ input checks
function fail(Type, message) {
  throw new Type(`basket-scheduler: ${message}`)
}

function show(x) {
  return typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" ? String(x) : typeof x
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
  if (!Array.isArray(weights) || weights.length !== LEGS) {
    fail(TypeError, `weights must be an array of ${LEGS} [numerator, denominator] pairs`)
  }
  const fr = weights.map((pair, i) => {
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
 * @param {bigint} capitalUnits C in units of the token sold, > 0
 * @param {Array<[number, number]>} weights three [numerator, denominator] pairs
 * @returns {bigint[]}
 */
export function legAmounts(capitalUnits, weights) {
  if (typeof capitalUnits !== "bigint") fail(TypeError, `capitalUnits must be a bigint (token units), got ${show(capitalUnits)}`)
  if (capitalUnits <= 0n) fail(RangeError, `capitalUnits must be positive, got ${capitalUnits}`)
  const fr = weightFractions(weights)
  const first = (capitalUnits * fr[0][0]) / fr[0][1]
  const second = (capitalUnits * fr[1][0]) / fr[1][1]
  return [first, second, capitalUnits - first - second]
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

function readLegs(legs) {
  if (!Array.isArray(legs) || legs.length !== LEGS) fail(TypeError, `legs must be an array of ${LEGS}`)
  return legs.map((leg, i) => {
    if (leg === null || typeof leg !== "object") fail(TypeError, `legs[${i}] must be an object`)
    const { n, done, last, entry } = leg
    integerIn(`legs[${i}].n`, n, 1, MAX_CYCLES)
    integerIn(`legs[${i}].done`, done, 0, MAX_CYCLES)
    if (done > n) fail(RangeError, `legs[${i}].done is ${done}, above n ${n}`)
    priceOrNull(`legs[${i}].last`, last)
    priceOrNull(`legs[${i}].entry`, entry)
    if ((last === null) !== (entry === null)) {
      fail(RangeError, `legs[${i}]: last and entry are set together, by the leg's first tick with a price`)
    }
    return { n, done, last, entry }
  })
}

function readPrices(prices) {
  if (!Array.isArray(prices) || prices.length !== LEGS) fail(TypeError, `prices must be an array of ${LEGS} (a price or null)`)
  prices.forEach((x, i) => priceOrNull(`prices[${i}]`, x))
  return prices.slice()
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
 * @param {number} input.tick t, 0 … N + 2
 * @param {Array<{ n: number, done: number, last: number|null, entry: number|null }>} input.legs
 *   n = the order's dcaTotal; done = chunks EXECUTED (order row); last = the decision price at the leg's previous tick
 *   with a price; entry = its decision price at its first tick with a price (null, null before it)
 * @param {0|1|2|null} input.cooldown the leg of the previous tick's first chunk (null if it picked nothing)
 * @param {Array<number|null>} input.prices the ADR-024 resolved decision price per leg; null = no usable price
 * @param {number} [input.bandAdd] with a stable leg (required then): the feed's deviation threshold when the feed
 *   decides the stable's price, else 0 (spec §4a)
 * @returns {{
 *   picks: Array<{ leg: number, kind: "select"|"catchup", slot: 1|2 }>,
 *   idleReason: string|null,
 *   next: { legs: Array<{ n: number, done: number, last: number|null, entry: number|null }>, cooldown: number|null },
 * }} picks in decision order; slot 1 = the leg's first chunk of the tick (first slot), 2 = its second (+ T ÷ 2);
 *   idleReason (one of IDLE_REASONS) only when nothing was picked; next.legs keeps n and done as given (done comes
 *   from the orders) and updates last and entry
 */
export function decideTick(input) {
  if (input === null || typeof input !== "object") fail(TypeError, "decideTick needs an object")
  const { params, tick, legs, cooldown, prices, bandAdd } = input
  const { cycles: N, mode, threshold, stableLeg: s, band } = readParams(params)
  integerIn("tick", tick, 0, N + GRACE_TICKS - 1)
  const state = readLegs(legs)
  if (cooldown !== null) integerIn("cooldown", cooldown, 0, LEGS - 1)
  const px = readPrices(prices)
  const add = readBandAdd(bandAdd, s)

  // §4.1-4.4: price, variation, protection, eligibility. A leg's first tick with a price sets its entry before the
  // protection check, and a leg with no previous price varies by 0 (tick 0 for every leg).
  const usable = px.map((x) => x !== null)
  const entry = state.map((leg, i) => (leg.entry === null && usable[i] ? px[i] : leg.entry))
  const variation = state.map((leg, i) => (usable[i] && leg.last !== null ? px[i] / leg.last - 1 : null))
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
  if (due > 0 && eligible.length > 0) {
    // §4.6 rule 4: lowest variation (rounded to 12 decimals), then furthest behind its own count, then lower leg.
    const firstKey = (i) => [
      variation[i] === null ? 0 : roundVariation(variation[i]),
      -(state[i].n - state[i].done) / state[i].n,
    ]
    const order = eligible.slice().sort((a, b) => compareKeys(firstKey(a), firstKey(b)) || a - b)
    // Rule 5: the previous tick's first leg goes to the back of the line when another leg is eligible.
    const first = cooldown !== null && order.length > 1 && order[0] === cooldown ? order[1] : order[0]
    const taken = [0, 0, 0]
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

  const slotsUsed = [0, 0, 0]
  return {
    picks: picks.map((leg, j) => {
      slotsUsed[leg] += 1
      return { leg, kind: j === 0 ? "select" : "catchup", slot: slotsUsed[leg] }
    }),
    idleReason,
    next: {
      // §4.9: last = this tick's price for every leg that had one; done is the caller's to refresh from the orders.
      legs: state.map((leg, i) => ({ n: leg.n, done: leg.done, last: usable[i] ? px[i] : leg.last, entry: entry[i] })),
      cooldown: picks.length > 0 ? picks[0] : null,
    },
  }
}
