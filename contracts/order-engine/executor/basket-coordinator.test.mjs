// Tests for basket-coordinator.js — the Split DCA coordinator (SPEC-BASKET-DCA §4 "Coordinator rules", §4a, §5, §6;
// ADR-027) and for the migration that holds its rows.
//
// The database is an in-memory fake that hands rows out and takes them in THROUGH JSON, as PostgREST does, and
// enforces UNIQUE (basket_id, tick). Every poll is a fresh coordinateBasket call with fresh row copies: nothing
// survives from one poll to the next except what the fake database holds, which is what a restart leaves.
//
//   1. The engine vectors (fixtures/basket-dca/, written by the analyst's engine) replayed end to end through the
//      coordinator, in both modes: the journal must hold the selection module's decision pick for pick and value for
//      value, every decided pick must come out as executable exactly once, and in 'reference' mode the result is the
//      engine's own.
//   2. One test per Coordinator rule, named after it.
//   3. The migration as text: it cannot be run here, so its shape is pinned against what the coordinator reads and
//      writes, and against its mirror in schema.sql.
//
// No network, no real clock. Runs on Node 20 and 22 (keeper-tests.yml, ci.yml).

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

import { GRACE_TICKS, IDLE_REASONS, LEG_REASONS, chooseN, decideTick } from "./basket-scheduler.js"
import {
  BASKET_STATUS,
  COORDINATOR_REASONS as R,
  FAIL_CLOSED_REASONS,
  FIRST_BUY,
  REFERENCE_TICK,
  basketTimeline,
  coordinateBasket,
} from "./basket-coordinator.js"

// ------------------------------------------------------------------------------------------------ fixtures
const T0 = 1_800_000_000 // 2027-01-15T08:00:00Z, unix seconds
const DAY = 86_400
const HALF = DAY / 2
// Synthetic addresses and hashes: nothing here is a real token (SPEC §11: never type one by hand).
const WALLET = `0x${"b".repeat(40)}`
const TOKEN_IN = `0x${"a".repeat(40)}`
const LEG_TOKENS = [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, `0x${"3".repeat(40)}`]
const LEG_HASHES = [`0x${"0a".repeat(32)}`, `0x${"0b".repeat(32)}`, `0x${"0c".repeat(32)}`]
const FLAT = [100, 200, 300]
const THIRDS = [[1, 3], [1, 3], [1, 3]]
const LEGS = [0, 1, 2]

/** What a row looks like after a trip to the database and back: JSON out, JSON in. */
const through = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))

function makeBasket({
  id = "0d9d3a54-1f6e-4c0b-9c41-6a1b7a2f0001",
  firstBuy = FIRST_BUY.REFERENCE,
  cycles = 6,
  n = [2, 2, 2],
  weights = THIRDS,
  cadence = DAY,
  t0 = T0,
  mode = "soft",
  thresholdBps = 2500,
  stableLeg = null,
  bandBps = null,
  status = BASKET_STATUS.ACTIVE,
} = {}) {
  const row = {
    id,
    created_at: "2027-01-15T08:00:00+00:00",
    wallet: WALLET,
    chain_id: 8453,
    token_in: TOKEN_IN,
    capital: "1000000000",
    cadence_s: cadence,
    cycles,
    t0,
    first_buy: firstBuy,
    mode,
    threshold_bps: thresholdBps,
    stable_leg: stableLeg,
    band_bps: bandBps,
    band_ack_at: null,
    status,
  }
  for (const i of LEGS) {
    row[`leg${i}_token_out`] = LEG_TOKENS[i]
    row[`leg${i}_weight_num`] = weights[i][0]
    row[`leg${i}_weight_den`] = weights[i][1]
    row[`leg${i}_n`] = n[i]
    row[`leg${i}_order_hash`] = LEG_HASHES[i]
  }
  return row
}

/** The three leg orders as `orders` rows. order_data is the signed struct the executor builds the transaction from;
 *  it keeps addresses in checksum case and uint256 as text, hence the upper case and the string here. */
function makeOrders(basket, done = [0, 0, 0]) {
  const mixedCase = (address) => `0x${address.slice(2).toUpperCase()}`
  return LEGS.map((i) => ({
    id: `order-${i}`,
    basket_id: basket.id,
    order_type: "dca",
    status: "active",
    chain_id: basket.chain_id,
    wallet: basket.wallet,
    token_in: basket.token_in,
    token_out: basket[`leg${i}_token_out`],
    dca_interval: basket.cadence_s / 2,
    dca_total: basket[`leg${i}_n`],
    dca_executed: done[i],
    dca_last_exec: null,
    order_hash: basket[`leg${i}_order_hash`],
    order_data: {
      owner: mixedCase(basket.wallet),
      tokenIn: mixedCase(basket.token_in),
      tokenOut: mixedCase(basket[`leg${i}_token_out`]),
      dcaInterval: String(basket.cadence_s / 2),
      dcaTotal: String(basket[`leg${i}_n`]),
    },
  }))
}

function uniqueViolation() {
  const err = new Error('duplicate key value violates unique constraint "basket_ticks_basket_tick_unique"')
  err.code = "23505"
  return err
}

/** The in-memory database: basket_ticks with its unique key, and baskets.status. Hooks let a test break one call. */
function fakeDb(world) {
  const state = {
    ticks: [],
    log: [],
    statusWrites: [],
    failRead: null, // an error to throw from readTicks
    leak: false, // readTicks hands out every row it has, whatever basket it belongs to
    failInsert: null, // an error to throw from insertTick
    failStatus: null, // an error to throw from setBasketStatus
    beforeInsert: null, // (row) => void, once: what another keeper does between this one's read and its write
    storedAs: null, // (stored) => row: what the database answers the insert with
  }
  const api = {
    async readTicks(basketId) {
      state.log.push("readTicks")
      if (state.failRead) throw state.failRead
      // Newest first: a query with no ORDER BY promises no order, and the coordinator must not rely on one.
      return through(state.ticks.filter((row) => state.leak || row.basket_id === basketId)).reverse()
    },
    async insertTick(row) {
      state.log.push(`insertTick ${row.tick}`)
      if (state.beforeInsert) {
        const hook = state.beforeInsert
        state.beforeInsert = null
        hook(row)
      }
      if (state.failInsert) throw state.failInsert
      if (state.ticks.some((have) => have.basket_id === row.basket_id && have.tick === row.tick)) throw uniqueViolation()
      const stored = { id: `tick-row-${state.ticks.length + 1}`, created_at: "2027-01-15T08:00:01+00:00", ...through(row) }
      state.ticks.push(stored)
      return state.storedAs ? state.storedAs(through(stored)) : through(stored)
    },
    async setBasketStatus(basketId, status) {
      state.log.push(`setBasketStatus ${status}`)
      if (state.failStatus) throw state.failStatus
      if (world.basket.id !== basketId || world.basket.status !== BASKET_STATUS.ACTIVE) return false
      world.basket.status = status
      state.statusWrites.push(status)
      return true
    },
  }
  return { state, api }
}

/**
 * One basket, its three orders, a price table and a database.
 *   prices   { ref: [p0, p1, p2], 0: [...], 1: [...] } by tick ("ref" = before the first tick); a missing key is FLAT;
 *            null = no usable price
 *   bandAdd  the stable leg's bandAdd: a number, or (tick) => number
 *   answer   (leg, tick, token, hint) => whatever resolvePrice should return, replacing the table
 */
function makeWorld(opts = {}) {
  const w = {}
  w.basket = makeBasket(opts)
  w.orders = makeOrders(w.basket, opts.done)
  w.tl = basketTimeline(w.basket)
  w.prices = { ...(opts.prices ?? {}) }
  w.bandAdd = opts.bandAdd ?? 0
  w.answer = opts.answer ?? null
  w.calls = [] // every resolvePrice call
  w.clock = null
  w.store = fakeDb(w)
  w.resolvePrice = async (token, hint) => {
    w.calls.push([token, hint])
    const leg = LEG_TOKENS.indexOf(token)
    const tick = w.tl.tickAt(w.clock)
    if (w.answer) return w.answer(leg, tick, token, hint)
    const price = (w.prices[tick === null ? "ref" : tick] ?? FLAT)[leg]
    if (price === null) return leg === 1 ? null : { price: null } // both spellings of "no usable price"
    const answer = { price, source: `test-source-${leg}` }
    if (hint.stable) answer.bandAdd = typeof w.bandAdd === "function" ? w.bandAdd(tick) : w.bandAdd
    return answer
  }
  /** One poll at `now`: a fresh call, fresh copies of the rows (the orders in no particular order). */
  w.call = (now, input = {}, deps = {}) => {
    w.clock = now
    return coordinateBasket(
      { basket: through(w.basket), orders: through([w.orders[2], w.orders[0], w.orders[1]]), inFlight: [], ...input },
      { now: () => now, db: w.store.api, resolvePrice: w.resolvePrice, ...deps },
    )
  }
  w.poll = (now, { inFlight = [] } = {}) => w.call(now, { inFlight })
  w.at = (tick, offset = 0) => w.tl.tickTime(tick) + offset
  w.rows = () => w.store.state.ticks.slice().sort((a, b) => a.tick - b.tick)
  w.row = (tick) => w.store.state.ticks.find((row) => row.tick === tick)
  /** The order row records the execution: this is the only thing that advances `done`. */
  w.execute = (pick) => {
    w.orders.find((order) => order.id === pick.orderId).dca_executed += 1
  }
  w.done = () => w.orders.map((order) => order.dca_executed)
  return w
}

function paramsOf(basket) {
  return {
    cycles: basket.cycles,
    mode: basket.mode,
    threshold: basket.threshold_bps / 10_000,
    stableLeg: basket.stable_leg,
    band: basket.band_bps === null ? null : basket.band_bps / 10_000,
  }
}

/** The selection module alone, on a state written out by hand: legs = [[done, last, entry] × 3]. */
function decide(basket, tick, legs, cooldown, prices, bandAdd) {
  return decideTick({
    params: paramsOf(basket),
    tick,
    legs: legs.map(([done, last, entry], i) => ({ n: basket[`leg${i}_n`], done, last, entry })),
    cooldown,
    prices,
    bandAdd,
  })
}

/** A stored journal row is the module's decision, value for value (deepEqual is strict: Object.is on numbers). */
function assertRowIsDecision(row, out, at) {
  assert.ok(row, `${at}: no journal row`)
  assert.deepEqual(row.picks, out.picks, `${at}: picks`)
  assert.deepEqual(row.per_leg, out.perLeg, `${at}: perLeg`)
  assert.deepEqual(row.next_state, out.next, `${at}: next`)
  assert.equal(row.idle_reason, out.idleReason, `${at}: idle reason`)
}

function assertFailClosed(result, reason, at = reason) {
  assert.equal(result.reason, reason, `${at}: reason (detail: ${result.detail})`)
  assert.equal(result.failClosed, true, `${at}: failClosed`)
  assert.ok(FAIL_CLOSED_REASONS.includes(reason), `${at}: ${reason} is a fail-closed reason`)
  assert.deepEqual(result.picks, [], `${at}: nothing executes`)
  assert.equal(typeof result.detail, "string", `${at}: a detail`)
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

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// ------------------------------------------------------------------------------------------------ engine vectors
const RUN_FAMILIES = ["calm", "fall", "no-price", "band", "min-fill", "ties", "mixed", "no-reference"]
const NO_REFERENCE = [null, null, null]
const [V, E, P, B, RSN] = [0, 3, 6, 9, 10] // first column of each group of `expected.perLeg`
const POLL_OFFSETS = [3, HALF - 1, HALF, DAY - 1] // seconds after the tick time

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/basket-dca/${name}.json`, import.meta.url), "utf8"))
}

const VECTORS = RUN_FAMILIES.flatMap((family) => fixture(family).vectors.map((v) => ({ family, ...v })))

/** The selection module alone, as basket-scheduler.test.mjs replays it: every pick executes unless `refused`, and a
 *  `missed` tick is a tick with no prices. */
function moduleAlone(input, { reference = input.reference, missed = new Set(), refused = () => false } = {}) {
  const n = chooseN(input.weights, input.capitalUsd, input.cycles, input.minFillUsd)
  let legs = n.map((ni, i) => ({ n: ni, done: 0, last: reference[i], entry: null }))
  let cooldown = null
  const steps = []
  for (let t = 0; t < input.cycles + GRACE_TICKS; t += 1) {
    const out = decideTick({
      params: { cycles: input.cycles, mode: input.mode, threshold: input.threshold, stableLeg: input.stableLeg, band: input.band },
      tick: t,
      legs,
      cooldown,
      prices: missed.has(t) ? NO_REFERENCE : input.prices[t],
      bandAdd: input.bandAdd === null ? null : input.bandAdd[t],
    })
    steps.push(out)
    const executed = [0, 0, 0]
    for (const p of out.picks) if (!refused(t, p.leg)) executed[p.leg] += 1
    legs = out.next.legs.map((leg, i) => ({ ...leg, done: leg.done + executed[i] }))
    cooldown = out.next.cooldown
  }
  return { n, steps, done: legs.map((leg) => leg.done) }
}

/**
 * The same vector through the coordinator: a basket row, three order rows, the vector's prices behind resolvePrice,
 * and polls at the reference and four times inside every tick. Each pick the coordinator hands out is executed on the
 * spot (the order row's dca_executed), unless `refused(tick, leg)`; a `missed` tick is never polled.
 */
async function throughCoordinator(v, firstBuy, { missed = new Set(), refused = () => false } = {}) {
  const { input } = v
  const bps = (x) => Math.round(x * 10_000)
  const w = makeWorld({
    firstBuy,
    cycles: input.cycles,
    n: chooseN(input.weights, input.capitalUsd, input.cycles, input.minFillUsd),
    weights: input.weights,
    mode: input.mode,
    thresholdBps: bps(input.threshold),
    stableLeg: input.stableLeg,
    bandBps: input.band === null ? null : bps(input.band),
  })
  // The basket stores basis points; the module must get the vector's own doubles back.
  assert.deepEqual(paramsOf(w.basket), { cycles: input.cycles, mode: input.mode, threshold: input.threshold, stableLeg: input.stableLeg, band: input.band })
  const reference = firstBuy === FIRST_BUY.REFERENCE ? input.reference : NO_REFERENCE
  w.answer = (leg, tick) => {
    const price = tick === null ? reference[leg] : input.prices[tick][leg]
    if (price === null) return leg === 1 ? null : { price: null }
    const answer = { price, source: tick === null ? "reference" : "vector" }
    if (leg === input.stableLeg) answer.bandAdd = tick === null ? 0 : input.bandAdd[tick]
    return answer
  }
  const polls = firstBuy === FIRST_BUY.REFERENCE ? [[null, T0 + 7]] : []
  for (let t = 0; t <= w.tl.lastTick; t += 1) {
    if (!missed.has(t)) for (const offset of POLL_OFFSETS) polls.push([t, w.at(t, offset)])
  }
  polls.push([null, w.tl.end])
  const executed = []
  for (const [t, now] of polls) {
    const result = await w.poll(now)
    assert.equal(result.failClosed, false, `${v.id} @${now}: ${result.reason} (${result.detail})`)
    assert.equal(result.reason === null, result.picks.length > 0, `${v.id} @${now}: a reason exactly when nothing is executable`)
    for (const pick of result.picks) {
      assert.equal(pick.tick, t, `${v.id}: a pick of tick ${pick.tick} offered during tick ${t}`)
      assert.ok(now >= w.tl.slotTime(t, pick.slot), `${v.id} tick ${t}: slot ${pick.slot} offered before its time`)
      assert.equal(pick.orderId, `order-${pick.leg}`, `${v.id}: the pick names the leg's own order`)
      if (refused(t, pick.leg)) continue
      w.execute(pick)
      executed.push(`${t}:${pick.leg}:${pick.slot}:${pick.kind}`)
    }
  }
  return { w, executed }
}

/** The journal the coordinator wrote against the module alone: decided ticks row for row, the rest accounted for. */
function assertSameAsModule(v, { w, executed }, alone, { missed = new Set(), refused = () => false } = {}) {
  const rows = new Map(w.rows().filter((row) => row.tick >= 0).map((row) => [row.tick, row]))
  const decided = []
  for (let t = 0; t <= w.tl.lastTick; t += 1) {
    const out = alone.steps[t]
    const row = rows.get(t)
    if (missed.has(t)) {
      assert.equal(row, undefined, `${v.id}: missed tick ${t} has a row`)
      continue
    }
    if (row === undefined) {
      // The only other tick without a row: the basket was already completed, and the module says so too.
      assert.equal(out.idleReason, IDLE_REASONS.COMPLETE, `${v.id}: tick ${t} has no row and the module says ${out.idleReason}`)
      continue
    }
    assertRowIsDecision(row, out, `${v.id} tick ${t}`)
    for (const p of out.picks) if (!refused(t, p.leg)) decided.push(`${t}:${p.leg}:${p.slot}:${p.kind}`)
  }
  assert.deepEqual(executed.slice().sort(), decided.sort(), `${v.id}: every decided pick came out as executable exactly once`)
  assert.deepEqual(w.done(), alone.done, `${v.id}: done per leg`)
  const complete = alone.done.every((d, i) => d === alone.n[i])
  assert.deepEqual(w.store.state.statusWrites, [complete ? BASKET_STATUS.COMPLETED : BASKET_STATUS.EXPIRED], `${v.id}: final status`)
  assert.equal(w.basket.status, complete ? BASKET_STATUS.COMPLETED : BASKET_STATUS.EXPIRED)
}

/** The journal against the engine's own numbers (the fixture's `expected`). */
function assertSameAsEngine(v, { w }) {
  const rows = w.rows().filter((row) => row.tick >= 0)
  assert.deepEqual(LEGS.map((i) => w.basket[`leg${i}_n`]), v.expected.n, `${v.id}: n`)
  assert.deepEqual(rows.flatMap((row) => row.picks.map((p) => [row.tick, p.leg, p.kind])), v.expected.fills, `${v.id}: fills [tick, leg, kind]`)
  assert.deepEqual(w.done(), v.expected.done, `${v.id}: done`)
  const withRow = new Set(rows.map((row) => row.tick))
  assert.deepEqual(
    rows.filter((row) => row.picks.length === 0).map((row) => [row.tick, row.idle_reason]),
    v.expected.idle.filter(([t]) => withRow.has(t)),
    `${v.id}: idle reasons`,
  )
  for (const [t, reason] of v.expected.idle.filter(([tick]) => !withRow.has(tick))) {
    assert.equal(reason, IDLE_REASONS.COMPLETE, `${v.id}: tick ${t} was not decided, the engine says ${reason}`)
  }
  for (const row of rows) {
    const engine = v.expected.perLeg[row.tick]
    LEGS.forEach((i) => {
      const at = `${v.id} tick ${row.tick} leg ${i}`
      assert.ok(Object.is(row.per_leg[i].variation, engine[V + i]), `${at}: variation ${row.per_leg[i].variation}, the engine's ${engine[V + i]}`)
      assert.equal(row.next_state.legs[i].entry, engine[E + i], `${at}: entry`)
      assert.equal(row.per_leg[i].protected, engine[P + i], `${at}: protected`)
      assert.equal(row.per_leg[i].inBand, i === v.input.stableLeg ? engine[B] : null, `${at}: inBand`)
      assert.equal(row.per_leg[i].reason, engine[RSN + i], `${at}: reason`)
      assert.ok(Object.is(row[`leg${i}_price`], v.input.prices[row.tick][i]), `${at}: the decision price, as a double`)
    })
  }
}

describe(`engine vectors through the coordinator (${VECTORS.length}), a fresh call per poll`, () => {
  test("there are vectors to replay, with and without a reference, with two chunks of one leg in a tick", () => {
    assert.ok(VECTORS.length >= 90, `only ${VECTORS.length} vectors`)
    assert.ok(VECTORS.filter((v) => v.input.reference.every((p) => p === null)).length >= 12)
    assert.ok(VECTORS.filter((v) => v.input.reference.some((p) => p !== null)).length >= 60)
    const twice = VECTORS.filter((v) => {
      const seen = new Set()
      return v.expected.fills.some(([t, leg]) => seen.has(`${t}:${leg}`) || !seen.add(`${t}:${leg}`))
    })
    assert.ok(twice.length >= 10, `only ${twice.length} vectors use a second slot`)
  })

  for (const v of VECTORS) {
    test(`'reference' mode: ${v.id} gives the module's picks, and the engine's`, async () => {
      const run = await throughCoordinator(v, FIRST_BUY.REFERENCE)
      assertSameAsModule(v, run, moduleAlone(v.input))
      assertSameAsEngine(v, run)
      // The reference row: the vector's reference, price for price, and no decision in it.
      const reference = run.w.row(REFERENCE_TICK)
      assert.deepEqual(LEGS.map((i) => reference[`leg${i}_price`]), v.input.reference)
      assert.deepEqual([reference.per_leg, reference.picks, reference.next_state, reference.idle_reason], [null, null, null, null])
    })

    test(`'now' mode: ${v.id} gives the module's picks with no reference`, async () => {
      const run = await throughCoordinator(v, FIRST_BUY.NOW)
      assertSameAsModule(v, run, moduleAlone(v.input, { reference: NO_REFERENCE }))
      assert.equal(run.w.row(REFERENCE_TICK), undefined, "'now' mode never writes a reference row")
      // With no reference in the vector either, that is the engine's own run.
      if (v.input.reference.every((p) => p === null)) assertSameAsEngine(v, run)
    })
  }

  for (const v of VECTORS) {
    test(`missed ticks: ${v.id} with ticks never polled is the module with no prices at those ticks`, async () => {
      const rnd = mulberry32(hashString(`missed/${v.id}`))
      const missed = new Set()
      for (let t = 0; t < v.input.cycles + GRACE_TICKS; t += 1) if (rnd() < 0.3) missed.add(t)
      const run = await throughCoordinator(v, FIRST_BUY.REFERENCE, { missed })
      assertSameAsModule(v, run, moduleAlone(v.input, { missed }), { missed })
    })

    test(`unexecuted picks: ${v.id} with legs that do not execute at some ticks stays with the module (done from the orders)`, async () => {
      const rnd = mulberry32(hashString(`refused/${v.id}`))
      const table = new Set()
      for (let t = 0; t < v.input.cycles + GRACE_TICKS; t += 1) for (const leg of LEGS) if (rnd() < 0.25) table.add(`${t}:${leg}`)
      const refused = (t, leg) => table.has(`${t}:${leg}`)
      const run = await throughCoordinator(v, FIRST_BUY.REFERENCE, { refused })
      assertSameAsModule(v, run, moduleAlone(v.input, { refused }), { refused })
    })
  }
})

// ------------------------------------------------------------------------------------------------ Coordinator rules
describe("rule: modes — the reference row and its T / 2 deadline", () => {
  test("reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothing is bought", async () => {
    const w = makeWorld({ prices: { ref: [3232.1, 95000.5, 1.25] } })
    const first = await w.poll(T0 + 5)
    assert.equal(first.reason, R.REFERENCE_RECORDED)
    assert.equal(first.failClosed, false)
    assert.deepEqual(first.picks, [])
    assert.equal(first.tick, null)
    assert.equal(first.wrote.length, 1)
    assert.equal(first.wrote[0].table, "basket_ticks")
    const row = w.row(REFERENCE_TICK)
    assert.deepEqual(first.wrote[0].row, row)
    assert.equal(row.basket_id, w.basket.id)
    assert.equal(row.tick, -1)
    assert.equal(row.decided_at, new Date((T0 + 5) * 1000).toISOString())
    assert.deepEqual(LEGS.map((i) => row[`leg${i}_price`]), [3232.1, 95000.5, 1.25])
    assert.deepEqual(LEGS.map((i) => row[`leg${i}_price_source`]), ["test-source-0", "test-source-1", "test-source-2"])
    assert.deepEqual([row.band_add, row.per_leg, row.picks, row.next_state, row.idle_reason], [null, null, null, null, null])
    assert.equal(w.rows().length, 1)
    assert.deepEqual(w.done(), [0, 0, 0])
  })

  test("reference row: it is written once; a later sight reads it and resolves no price", async () => {
    const w = makeWorld()
    await w.poll(T0 + 5)
    assert.equal(w.calls.length, 3)
    w.prices.ref = [1, 2, 3] // the market moved; the reference does not
    for (const now of [T0 + 6, T0 + HALF - 1, T0 + HALF, T0 + DAY - 1]) {
      const again = await w.poll(now)
      assert.equal(again.reason, R.BEFORE_FIRST_TICK, `@${now - T0}`)
      assert.deepEqual(again.wrote, [])
    }
    assert.equal(w.calls.length, 3)
    assert.equal(w.rows().length, 1)
    assert.deepEqual(LEGS.map((i) => w.row(REFERENCE_TICK)[`leg${i}_price`]), FLAT)
  })

  test("reference deadline: written at t0, one second before t0 + T / 2 and a moment before t0; never at t0 + T / 2 or later", async () => {
    for (const [offset, written] of [[-2, true], [0, true], [HALF - 1, true], [HALF, false], [HALF + 1, false], [DAY - 1, false]]) {
      const w = makeWorld()
      const result = await w.poll(T0 + offset)
      assert.equal(result.reason, written ? R.REFERENCE_RECORDED : R.BEFORE_FIRST_TICK, `first sight at t0 + ${offset}`)
      assert.equal(w.rows().length, written ? 1 : 0, `first sight at t0 + ${offset}: rows`)
      assert.equal(w.calls.length, written ? 3 : 0, `first sight at t0 + ${offset}: prices resolved`)
    }
  })

  test("reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys first", async () => {
    const prices = { ref: [100, 100, 100], 0: [101, 95, 99] }
    const late = makeWorld({ prices })
    assert.equal((await late.poll(T0 + HALF)).reason, R.BEFORE_FIRST_TICK)
    const first = await late.poll(late.at(0, 1))
    assert.equal(late.row(REFERENCE_TICK), undefined)
    assert.deepEqual(late.row(0).per_leg.map((leg) => leg.variation), [null, null, null], "no previous price at all")
    assertRowIsDecision(late.row(0), decide(late.basket, 0, [[0, null, null], [0, null, null], [0, null, null]], null, [101, 95, 99]), "late")
    assert.deepEqual(first.picks, [{ orderId: "order-0", leg: 0, tick: 0, slot: 1, kind: "select" }])
    // Seen in time, the same prices buy the leg that did worst since the reference.
    const inTime = makeWorld({ prices })
    await inTime.poll(T0 + HALF - 1)
    const compared = await inTime.poll(inTime.at(0, 1))
    assert.deepEqual(inTime.row(0).per_leg.map((leg) => leg.variation), [101 / 100 - 1, 95 / 100 - 1, 99 / 100 - 1])
    assert.deepEqual(compared.picks, [{ orderId: "order-1", leg: 1, tick: 0, slot: 1, kind: "select" }])
    // And the late basket never gets a reference afterwards.
    await late.poll(late.at(1, 1))
    assert.equal(late.row(REFERENCE_TICK), undefined)
  })

  test("reference row: a leg with no price at first sight has no reference, and gets its last at its first tick with a price", async () => {
    const w = makeWorld({ prices: { ref: [100, null, 100], 0: [101, 95, 99], 1: [101, 90, 99] } })
    await w.poll(T0 + 1)
    assert.deepEqual(LEGS.map((i) => w.row(REFERENCE_TICK)[`leg${i}_price`]), [100, null, 100])
    assert.deepEqual(LEGS.map((i) => w.row(REFERENCE_TICK)[`leg${i}_price_source`]), ["test-source-0", null, "test-source-2"])
    const first = await w.poll(w.at(0, 1))
    assert.deepEqual(w.row(0).per_leg.map((leg) => leg.variation), [101 / 100 - 1, null, 99 / 100 - 1])
    assert.equal(first.picks[0].leg, 2, "leg 1 ranks as 0 without a previous price; leg 2 fell")
    w.execute(first.picks[0])
    await w.poll(w.at(1, 1))
    assert.equal(w.row(1).per_leg[1].variation, 90 / 95 - 1, "tick 0 gave leg 1 its last")
  })

  test("a reference row whose three prices are missing is still the reference: written once, never filled in later", async () => {
    const w = makeWorld({ prices: { ref: [null, null, null] } })
    assert.equal((await w.poll(T0 + 1)).reason, R.REFERENCE_RECORDED)
    w.prices.ref = FLAT
    assert.equal((await w.poll(T0 + 60)).reason, R.BEFORE_FIRST_TICK)
    assert.deepEqual(LEGS.map((i) => w.row(REFERENCE_TICK)[`leg${i}_price`]), [null, null, null])
    assert.equal(w.rows().length, 1)
  })

  test("'now' mode: no reference row, tick 0 at t0, and leg 0 (the token the user chose) buys first whatever the prices", async () => {
    const w = makeWorld({ firstBuy: FIRST_BUY.NOW, prices: { 0: [500, 1, 1], 1: [500, 0.9, 1] } })
    const early = await w.poll(T0 - 1)
    assert.equal(early.reason, R.BEFORE_FIRST_TICK)
    assert.equal(w.calls.length, 0, "no reference is taken in 'now' mode")
    const first = await w.poll(T0)
    assert.equal(first.tick, 0)
    assert.deepEqual(first.picks, [{ orderId: "order-0", leg: 0, tick: 0, slot: 1, kind: "select" }])
    assert.deepEqual(w.row(0).per_leg.map((leg) => leg.variation), [null, null, null])
    assert.equal(w.row(REFERENCE_TICK), undefined)
    w.execute(first.picks[0])
    // From the second cycle on the rule decides: tick 0's prices are tick 1's previous prices.
    const second = await w.poll(T0 + DAY)
    assert.equal(second.tick, 1)
    assert.deepEqual(w.row(1).per_leg.map((leg) => leg.variation), [0, 0.9 / 1 - 1, 0])
    assert.equal(second.picks[0].leg, 1, "the one that fell since tick 0")
  })

  test("'now' mode with leg 0 unpriced: no special case, the first chunk goes to the next leg and the journal says why", async () => {
    const w = makeWorld({ firstBuy: FIRST_BUY.NOW, prices: { 0: [null, 200, 300] } })
    const first = await w.poll(T0 + 1)
    assert.deepEqual(first.picks, [{ orderId: "order-1", leg: 1, tick: 0, slot: 1, kind: "select" }])
    assert.equal(w.row(0).per_leg[0].reason, LEG_REASONS.NO_PRICE)
    assert.equal(w.row(0).leg0_price, null)
    assert.equal(w.row(0).leg0_price_source, null)
    assertRowIsDecision(w.row(0), decide(w.basket, 0, [[0, null, null], [0, null, null], [0, null, null]], null, [null, 200, 300]), "tick 0")
  })

  test("'now' mode with leg 0 the stable leg and out of its band: the first chunk goes to the next leg (reason band)", async () => {
    const w = makeWorld({ firstBuy: FIRST_BUY.NOW, stableLeg: 0, bandBps: 100, bandAdd: 0.003, prices: { 0: [0.97, 200, 300] } })
    const first = await w.poll(T0 + 1)
    assert.equal(first.picks[0].leg, 1)
    assert.equal(w.row(0).per_leg[0].reason, LEG_REASONS.BAND)
    assert.equal(w.row(0).per_leg[0].inBand, false)
  })
})

describe("rule: both modes' tick times", () => {
  test("'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2", () => {
    const reference = basketTimeline(makeBasket({ cycles: 6 }))
    assert.equal(reference.firstTick, T0 + DAY)
    assert.equal(reference.lastTick, 8)
    assert.equal(reference.tickTime(8), T0 + 9 * DAY)
    assert.equal(reference.end, T0 + 10 * DAY, "(N + 4) × T: the reference cycle, N cycles, 3 grace cycles, one more for the last second slot")
    assert.equal(reference.referenceDeadline, T0 + HALF)
    assert.equal(reference.slotTime(3, 1), T0 + 4 * DAY)
    assert.equal(reference.slotTime(3, 2), T0 + 4 * DAY + HALF)
    const now = basketTimeline(makeBasket({ cycles: 6, firstBuy: FIRST_BUY.NOW }))
    assert.equal(now.firstTick, T0)
    assert.equal(now.lastTick, 8)
    assert.equal(now.end, T0 + 9 * DAY, "(N + 3) × T")
    assert.equal(now.referenceDeadline, null)
    assert.equal(now.slotTime(0, 2), T0 + HALF)
    for (const tl of [reference, now]) {
      assert.equal(tl.tickAt(tl.firstTick - 1), null)
      for (let t = 0; t <= tl.lastTick; t += 1) {
        assert.equal(tl.tickAt(tl.tickTime(t)), t)
        assert.equal(tl.tickAt(tl.tickTime(t) + DAY - 1), t)
      }
    }
    // Other cadences: every 3 days and weekly.
    assert.equal(basketTimeline(makeBasket({ cadence: 3 * DAY })).tickTime(1), T0 + 6 * DAY)
    assert.equal(basketTimeline(makeBasket({ cadence: 7 * DAY, firstBuy: FIRST_BUY.NOW })).slotTime(1, 2), T0 + 7 * DAY + 3.5 * DAY)
    for (const bad of [{ cadence: 86_401 }, { cadence: 0 }, { t0: T0 * 1000 }, { cycles: 0 }, { firstBuy: "later" }]) {
      assert.throws(() => basketTimeline(makeBasket(bad)), RangeError, JSON.stringify(bad))
    }
    assert.throws(() => basketTimeline(null), TypeError)
  })

  for (const firstBuy of [FIRST_BUY.REFERENCE, FIRST_BUY.NOW]) {
    test(`'${firstBuy}': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`, async () => {
      const w = makeWorld({ firstBuy })
      if (firstBuy === FIRST_BUY.REFERENCE) await w.poll(T0 + 1)
      assert.equal((await w.poll(w.tl.firstTick - 1)).reason, R.BEFORE_FIRST_TICK)
      assert.equal(w.rows().filter((row) => row.tick >= 0).length, 0)
      for (let t = 0; t <= w.tl.lastTick; t += 1) {
        const atStart = await w.poll(w.tl.firstTick + t * DAY)
        assert.equal(atStart.tick, t)
        assert.equal(w.row(t).decided_at, new Date((w.tl.firstTick + t * DAY) * 1000).toISOString())
        const atEnd = await w.poll(w.tl.firstTick + (t + 1) * DAY - 1)
        assert.equal(atEnd.tick, t, "one second before the next tick is still this tick")
        assert.equal(w.row(t + 1), undefined)
      }
      assert.deepEqual(w.rows().filter((row) => row.tick >= 0).map((row) => row.tick), [0, 1, 2, 3, 4, 5, 6, 7, 8])
    })
  }
})

describe("rule: state is rebuilt from rows at every decision", () => {
  test("last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown, done = the order rows", async () => {
    const prices = {
      ref: [100, 200, null],
      0: [null, 190, 310],
      1: [105, null, 320],
      // tick 2 is missed
      3: [null, 195, null],
      4: [110, 180, 330],
    }
    const w = makeWorld({ prices })
    await w.poll(T0 + 1)
    for (const t of [0, 1, 3]) for (const pick of (await w.poll(w.at(t, 1))).picks) w.execute(pick)
    // Tick 3: its previous tick has no row, so no cooldown; the prices come from three different rows.
    const done3 = w.row(3).next_state.legs.map((leg) => leg.done)
    assertRowIsDecision(w.row(3), decide(w.basket, 3, [[done3[0], 105, 105], [done3[1], 190, 190], [done3[2], 320, 310]], null, prices[3]), "tick 3")
    const done4 = w.done()
    await w.poll(w.at(4, 1))
    const expected = decide(
      w.basket,
      4,
      [[done4[0], 105, 105], [done4[1], 195, 190], [done4[2], 320, 310]],
      w.row(3).next_state.cooldown,
      prices[4],
    )
    assertRowIsDecision(w.row(4), expected, "tick 4")
    assert.deepEqual(w.row(4).per_leg.map((leg) => leg.variation), [110 / 105 - 1, 180 / 195 - 1, 330 / 320 - 1])
    assert.deepEqual(w.row(4).next_state.legs.map((leg) => leg.entry), [105, 190, 310])
  })

  test("entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected", async () => {
    const w = makeWorld({ mode: "rigid", prices: { ref: [100, 100, 100], 0: [70, 100, 100], 1: [60, 100, 100] } })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    assert.deepEqual(w.row(0).per_leg[0], { variation: 70 / 100 - 1, protected: false, inBand: null, reason: "picked" })
    assert.equal(w.row(0).next_state.legs[0].entry, 70, "the entry is tick 0's price, not the reference 100")
    assert.equal(first.picks[0].leg, 0)
    w.execute(first.picks[0])
    await w.poll(w.at(1, 1))
    // 60 is above 70 × 0.75 = 52.5 (not protected); against a wrong entry of 100 it would be under 75 (protected).
    assert.equal(w.row(1).per_leg[0].protected, false)
    assert.equal(w.row(1).next_state.legs[0].entry, 70)
  })

  test("the basket's basis points reach the module as bps ÷ 10 000, the double of the decimal: a price exactly on entry × (1 − 0.57) is protected", async () => {
    // 5700 × 0.0001 is 0.5700000000000001, one step above 0.57: with it the same price would not be protected.
    assert.notEqual(5700 * 0.0001, 5700 / 10_000)
    assert.equal(5700 / 10_000, 0.57)
    const edge = 100 * (1 - 0.57)
    const w = makeWorld({ mode: "rigid", thresholdBps: 5700, prices: { ref: [100, 100, 100], 0: [100, 100, 100], 1: [edge, 100, 100] } })
    await w.poll(T0 + 1)
    for (const pick of (await w.poll(w.at(0, 1))).picks) w.execute(pick)
    await w.poll(w.at(1, 1))
    assert.equal(w.row(1).next_state.legs[0].entry, 100)
    assert.deepEqual(w.row(1).per_leg[0], { variation: edge / 100 - 1, protected: true, inBand: null, reason: LEG_REASONS.RULE9 })
    assertRowIsDecision(w.row(1), decideTick({ params: { ...paramsOf(w.basket), threshold: 0.57 }, tick: 1, legs: w.row(0).next_state.legs.map((leg, i) => ({ ...leg, done: w.done()[i] })), cooldown: w.row(0).next_state.cooldown, prices: [edge, 100, 100] }), "tick 1")
  })

  test("the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band", async () => {
    const justAbove = 600 * 0.0001 // 0.060000000000000005, the double after 0.06
    assert.ok(justAbove > 0.06 && 600 / 10_000 === 0.06)
    const w = makeWorld({ stableLeg: 2, bandBps: 600, bandAdd: justAbove, prices: { ref: [100, 100, 1], 0: [100, 100, 1] } })
    await w.poll(T0 + 1)
    await w.poll(w.at(0, 1))
    assert.equal(w.row(0).band_add, justAbove)
    assert.equal(w.row(0).per_leg[2].inBand, false)
    assert.equal(w.row(0).per_leg[2].reason, LEG_REASONS.BAND)
  })

  test("the journal rows may come back in any order: the state is the same", async () => {
    const prices = { ref: [100, 100, 100], 0: [90, 100, 100], 1: [95, 97, 100], 2: [99, 96, 101], 3: [98, 99, 97] }
    const w = makeWorld({ prices })
    await w.poll(T0 + 1)
    for (const t of [0, 1, 2]) for (const pick of (await w.poll(w.at(t, 1))).picks) w.execute(pick)
    const done = w.done()
    // Rows as the fake hands them out (newest first), then in three other orders.
    for (const order of [[3, 2, 1, 0], [0, 1, 2, 3], [2, 0, 3, 1], [1, 3, 0, 2]]) {
      const copy = makeWorld({ prices, done })
      const rows = w.rows()
      const readTicks = async () => through(order.map((k) => rows[k]))
      const result = await copy.call(w.at(3, 1), {}, { db: { ...copy.store.api, readTicks } })
      assert.equal(result.failClosed, false, `${order}: ${result.detail}`)
      const expected = decide(w.basket, 3, [[done[0], 99, 90], [done[1], 96, 100], [done[2], 101, 100]], w.row(2).next_state.cooldown, prices[3])
      assertRowIsDecision(copy.row(3), expected, `rows in order ${order}`)
    }
  })

  test("done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    assert.deepEqual(first.picks.map((p) => p.leg), [0])
    // It does not execute. Tick 1 sees done 0 on every leg, so two chunks are due.
    const second = await w.poll(w.at(1, 1))
    assert.deepEqual(w.row(1).next_state.legs.map((leg) => leg.done), [0, 0, 0])
    assertRowIsDecision(w.row(1), decide(w.basket, 1, [[0, 100, 100], [0, 200, 200], [0, 300, 300]], 0, FLAT), "tick 1")
    assert.deepEqual(second.picks.map((p) => [p.leg, p.kind]), [[1, "select"], [0, "catchup"]], "leg 0 is on cooldown, and still owed")
    // And the other way: whatever the journal picked, a done the order rows report is the done that counts.
    w.orders[2].dca_executed = 2
    await w.poll(w.at(2, 1))
    assert.deepEqual(w.row(2).next_state.legs.map((leg) => leg.done), [0, 0, 2])
    assert.equal(w.row(2).per_leg[2].reason, LEG_REASONS.COMPLETE)
  })
})

describe("rule: decide once", () => {
  test("two calls for the same tick: the second reads the row and never decides again, even when the prices have changed", async () => {
    const w = makeWorld({ prices: { ref: [100, 100, 100], 0: [101, 95, 99] } })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    const stored = through(w.row(0))
    const calls = w.calls.length
    w.prices[0] = [50, 200, 99] // a new decision would now buy leg 0
    const second = await w.poll(w.at(0, 30))
    assert.deepEqual(second.picks, first.picks)
    assert.deepEqual(second.picks, [{ orderId: "order-1", leg: 1, tick: 0, slot: 1, kind: "select" }])
    assert.deepEqual(second.wrote, [])
    assert.equal(w.calls.length, calls, "no price is resolved for a tick that has a row")
    assert.deepEqual(w.row(0), stored, "the row is not rewritten")
    assert.equal(w.rows().filter((row) => row.tick === 0).length, 1)
    assert.equal(w.store.state.log.filter((entry) => entry === "insertTick 0").length, 1)
  })

  test("restart between the row write and the execution: the stored picks come back, nothing is decided again", async () => {
    const w = makeWorld({ prices: { 1: [100, null, null] } })
    await w.poll(T0 + 1)
    // Tick 0 is missed, so tick 1 owes two chunks and only leg 0 has a price: both slots of leg 0.
    const beforeCrash = await w.poll(w.at(1, 1))
    assert.equal(beforeCrash.wrote.length, 1)
    assert.deepEqual(beforeCrash.picks, [{ orderId: "order-0", leg: 0, tick: 1, slot: 1, kind: "select" }])
    // The keeper dies here: the row is written, nothing was sent. A new process, new prices.
    const calls = w.calls.length
    w.prices[1] = [100, 200, 300]
    const afterRestart = await w.poll(w.at(1, 90))
    assert.deepEqual(afterRestart.picks, beforeCrash.picks)
    assert.deepEqual(afterRestart.wrote, [])
    assert.equal(w.calls.length, calls)
    // The second slot executes the stored decision too, a restart later.
    w.execute(afterRestart.picks[0])
    const secondSlot = await w.poll(w.at(1, HALF + 1))
    assert.deepEqual(secondSlot.picks, [{ orderId: "order-0", leg: 0, tick: 1, slot: 2, kind: "catchup" }])
    assert.equal(w.calls.length, calls, "the second slot never decides")
  })

  test("two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row", async () => {
    const w = makeWorld({ prices: { ref: [100, 100, 100], 0: [101, 95, 99] } })
    await w.poll(T0 + 1)
    // Between this keeper's read and its write, another one stores ITS decision for tick 0 (it saw leg 2 fall).
    const theirs = decide(w.basket, 0, [[0, 100, null], [0, 100, null], [0, 100, null]], null, [101, 99, 90])
    w.store.state.beforeInsert = (row) => {
      w.store.state.ticks.push({ ...through(row), id: "their-row", leg1_price: 99, leg2_price: 90, per_leg: theirs.perLeg, picks: theirs.picks, next_state: theirs.next, idle_reason: theirs.idleReason })
    }
    const loser = await w.poll(w.at(0, 1))
    assertFailClosed(loser, R.JOURNAL_WRITE_FAILED)
    assert.deepEqual(loser.wrote, [])
    assert.equal(w.rows().filter((row) => row.tick === 0).length, 1)
    const next = await w.poll(w.at(0, 16))
    assert.deepEqual(next.picks, [{ orderId: "order-2", leg: 2, tick: 0, slot: 1, kind: "select" }], "the winner's decision, not this keeper's (leg 1)")
  })
})

describe("rule: the row is written before any pick is returned", () => {
  test("journal write failure: nothing executes and nothing is reported as written; the next poll decides", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    w.store.state.failInsert = new Error("connect ECONNREFUSED https://db.example/rest/v1/basket_ticks?apikey=SERVICE-ROLE-KEY")
    const failed = await w.poll(w.at(0, 1))
    assertFailClosed(failed, R.JOURNAL_WRITE_FAILED)
    assert.deepEqual(failed.wrote, [])
    assert.equal(w.row(0), undefined)
    assert.ok(!/SERVICE|apikey|https?:/.test(failed.detail), `the detail carries no error text: ${failed.detail}`)
    w.store.state.failInsert = null
    const retried = await w.poll(w.at(0, 16))
    assert.equal(retried.failClosed, false)
    assert.deepEqual(retried.picks.map((p) => p.orderId), ["order-0"])
    assert.equal(retried.wrote.length, 1)
  })

  test("the row is in the database before the call returns, and the picks are read from the row AS STORED", async () => {
    const w = makeWorld({ prices: { ref: [100, 100, 100], 0: [101, 95, 99] } })
    await w.poll(T0 + 1)
    w.store.state.log.length = 0
    // The database answers the insert with a row whose decision is another one (leg 2): that is what must execute.
    const other = decide(w.basket, 0, [[0, 100, null], [0, 100, null], [0, 100, null]], null, [101, 99, 90])
    w.store.state.storedAs = (stored) => ({ ...stored, per_leg: other.perLeg, picks: other.picks, next_state: other.next, idle_reason: other.idleReason })
    const result = await w.poll(w.at(0, 1))
    assert.deepEqual(w.store.state.log, ["readTicks", "insertTick 0"])
    assert.deepEqual(result.picks.map((p) => p.orderId), ["order-2"], "the stored row decides, not the value computed in memory (leg 1)")
    assert.deepEqual(result.wrote[0].row.picks, other.picks)
  })

  test("an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row", async () => {
    for (const [name, storedAs] of [
      ["nothing", () => undefined],
      ["a boolean", () => true],
      ["the wrong tick", (stored) => ({ ...stored, tick: 5 })],
      ["another basket's row", (stored) => ({ ...stored, basket_id: "someone-else" })],
      ["a row with no picks", (stored) => ({ ...stored, picks: null })],
    ]) {
      const w = makeWorld()
      await w.poll(T0 + 1)
      w.store.state.storedAs = storedAs
      const result = await w.poll(w.at(0, 1))
      assertFailClosed(result, R.JOURNAL_WRITE_FAILED, name)
      assert.deepEqual(result.wrote, [], name)
    }
  })
})

describe("rule: slot timing", () => {
  /** Tick 0 is missed, tick 1 owes two chunks and only leg 0 has a price: leg 0 takes both slots of tick 1. */
  async function twoSlots() {
    const w = makeWorld({ prices: { 1: [100, null, null] } })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(1, 1))
    assert.deepEqual(w.row(1).picks, [{ leg: 0, kind: "select", slot: 1 }, { leg: 0, kind: "catchup", slot: 2 }])
    return { w, first }
  }

  test("slot 1 from the tick time; slot 2 before its time is not executable, at its time it is", async () => {
    const { w, first } = await twoSlots()
    assert.deepEqual(first.picks, [{ orderId: "order-0", leg: 0, tick: 1, slot: 1, kind: "select" }], "slot 1 only, at the tick time")
    w.execute(first.picks[0])
    const before = await w.poll(w.at(1, HALF - 1))
    assert.deepEqual(before.picks, [])
    assert.equal(before.reason, R.SLOT_NOT_REACHED)
    assert.equal(before.failClosed, false)
    const after = await w.poll(w.at(1, HALF))
    assert.deepEqual(after.picks, [{ orderId: "order-0", leg: 0, tick: 1, slot: 2, kind: "catchup" }])
    w.execute(after.picks[0])
    const done = await w.poll(w.at(1, HALF + 30))
    assert.deepEqual(done.picks, [])
    assert.equal(done.reason, R.PICKS_EXECUTED)
    assert.deepEqual(w.done(), [2, 0, 0])
  })

  test("a leg's second slot is never offered while its first has not executed, whatever the time", async () => {
    const { w, first } = await twoSlots()
    for (const offset of [HALF, HALF + 60, DAY - 1]) {
      assert.deepEqual((await w.poll(w.at(1, offset))).picks, first.picks, `+${offset} s: still slot 1, and only slot 1`)
    }
  })

  test("an executed pick is not offered again", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    assert.equal(first.picks.length, 1)
    w.execute(first.picks[0])
    for (const offset of [2, HALF, DAY - 1]) {
      const again = await w.poll(w.at(0, offset))
      assert.deepEqual(again.picks, [], `+${offset} s`)
      assert.equal(again.reason, R.PICKS_EXECUTED)
    }
    assert.deepEqual(w.done(), [1, 0, 0])
  })

  test("a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    const lastSecond = await w.poll(w.at(1, -1))
    assert.deepEqual(lastSecond.picks, first.picks, "one second before the next tick it is still executable")
    const next = await w.poll(w.at(1, 0))
    assert.equal(next.tick, 1)
    assert.ok(next.picks.length > 0 && next.picks.every((p) => p.tick === 1), "only picks of the current tick")
    assert.deepEqual(next.picks.map((p) => [p.orderId, p.slot, p.kind]), [["order-1", 1, "select"], ["order-0", 1, "catchup"]])
    assert.deepEqual(w.row(0).picks, [{ leg: 0, kind: "select", slot: 1 }], "tick 0's row is untouched")
  })

  test("a tick that picked nothing says why, from the journal", async () => {
    const w = makeWorld({ prices: { 0: [null, null, null] } })
    await w.poll(T0 + 1)
    const idle = await w.poll(w.at(0, 1))
    assert.deepEqual(idle.picks, [])
    assert.equal(idle.reason, R.TICK_IDLE)
    assert.equal(idle.failClosed, false)
    assert.equal(w.row(0).idle_reason, IDLE_REASONS.NO_PRICE)
    assert.match(idle.detail, /no_price/)
  })
})

describe("rule: a missed tick is never decided late", () => {
  test("a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged", async () => {
    // Leg 0 does worst at tick 0 and again at tick 2. Tick 1 is missed.
    const prices = { ref: [100, 100, 100], 0: [90, 100, 100], 1: [10, 10, 10], 2: [80, 100, 100] }
    const w = makeWorld({ prices })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    assert.equal(first.picks[0].leg, 0)
    w.execute(first.picks[0])
    assert.equal(w.row(0).next_state.cooldown, 0)
    // The keeper is down for the whole of tick 1.
    const third = await w.poll(w.at(2, 1))
    assert.equal(w.row(1), undefined, "tick 1 was not decided late")
    assert.deepEqual(w.rows().map((row) => row.tick), [-1, 0, 2])
    // With tick 0's cooldown carried over, rule 5 would send leg 0 to the back; a missed tick clears it.
    const expected = decide(w.basket, 2, [[1, 90, 90], [0, 100, 100], [0, 100, 100]], null, prices[2])
    assertRowIsDecision(w.row(2), expected, "tick 2")
    assert.equal(third.picks[0].leg, 0)
    assert.equal(w.row(2).per_leg[0].variation, 80 / 90 - 1, "against tick 0's price: tick 1's prices were never seen")
    assert.notDeepEqual(decide(w.basket, 2, [[1, 90, 90], [0, 100, 100], [0, 100, 100]], 0, prices[2]).picks, expected.picks, "the cooldown matters here")
    // It is the module's own tick with no prices.
    const noPrices = decide(w.basket, 1, [[1, 90, 90], [0, 100, 100], [0, 100, 100]], 0, [null, null, null])
    assert.equal(noPrices.next.cooldown, null)
    assert.deepEqual(noPrices.next.legs.map((leg) => [leg.last, leg.entry]), [[90, 90], [100, 100], [100, 100]])
    // Later polls never go back to it either.
    for (const t of [3, 4, 5]) await w.poll(w.at(t, 1))
    assert.equal(w.row(1), undefined)
  })

  test("every tick missed but the last: only the current tick is ever decided", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const last = await w.poll(w.at(w.tl.lastTick, 5))
    assert.equal(last.tick, 8)
    assert.deepEqual(w.rows().map((row) => row.tick), [-1, 8])
    assert.equal(w.store.state.log.filter((entry) => entry.startsWith("insertTick")).length, 2)
    assertRowIsDecision(w.row(8), decide(w.basket, 8, [[0, 100, null], [0, 200, null], [0, 300, null]], null, FLAT), "tick 8")
  })
})

describe("rule: no decision while a transaction is in flight", () => {
  test("in-flight block: tick t + 1 is not decided while a pick of tick t has a transaction in flight; once it lands, it is", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    const calls = w.calls.length
    // The transaction of tick 0's pick was sent late and is still in flight when tick 1 comes.
    const blocked = await w.poll(w.at(1, 1), { inFlight: [first.picks[0]] })
    assert.deepEqual(blocked.picks, [])
    assert.equal(blocked.reason, R.IN_FLIGHT)
    assert.equal(blocked.failClosed, false)
    assert.deepEqual(blocked.wrote, [])
    assert.equal(w.row(1), undefined)
    assert.equal(w.calls.length, calls, "no price is resolved either")
    // Its outcome reaches the order row; the next poll decides tick 1 with the new done.
    w.execute(first.picks[0])
    const decided = await w.poll(w.at(1, 60))
    assert.equal(decided.wrote.length, 1)
    assert.deepEqual(w.row(1).next_state.legs.map((leg) => leg.done), [1, 0, 0])
    assert.deepEqual(decided.picks.map((p) => p.orderId), ["order-1"])
  })

  test("an order row that is locked ('executing') counts as in flight, with or without the caller's list", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    await w.poll(w.at(0, 1))
    w.orders[2].status = "executing"
    const blocked = await w.poll(w.at(1, 1))
    assert.equal(blocked.reason, R.IN_FLIGHT)
    assert.equal(w.row(1), undefined)
    w.orders[2].status = "active"
    assert.equal((await w.poll(w.at(1, 61))).wrote.length, 1)
  })

  test("in flight for a whole tick: that tick is missed, not decided late", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    for (const offset of [1, HALF, DAY - 1]) {
      assert.equal((await w.poll(w.at(1, offset), { inFlight: [{ orderId: first.picks[0].orderId }] })).reason, R.IN_FLIGHT)
    }
    w.execute(first.picks[0])
    await w.poll(w.at(2, 1))
    assert.deepEqual(w.rows().map((row) => row.tick), [-1, 0, 2])
    assertRowIsDecision(w.row(2), decide(w.basket, 2, [[1, 100, 100], [0, 200, 200], [0, 300, 300]], null, FLAT), "tick 2")
  })

  test("inside a tick, a leg in flight is not offered again; the other legs are", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    await w.poll(w.at(0, 1)) // not executed: tick 1 owes two chunks, legs 1 and 0
    const both = await w.poll(w.at(1, 1))
    assert.deepEqual(both.picks.map((p) => p.orderId), ["order-1", "order-0"])
    const one = await w.poll(w.at(1, 2), { inFlight: [both.picks[0]] })
    assert.deepEqual(one.picks.map((p) => p.orderId), ["order-0"])
    const none = await w.poll(w.at(1, 3), { inFlight: both.picks })
    assert.deepEqual(none.picks, [])
    assert.equal(none.reason, R.IN_FLIGHT)
  })

  test("the in-flight list is required and must name legs of this basket: otherwise nothing executes", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const rowsBefore = w.rows().length
    for (const [name, inFlight] of [
      ["missing", undefined],
      ["null", null],
      ["not an array", "order-0"],
      ["an entry with no order id", [{}]],
      ["a bare string", ["order-0"]],
      ["an order of another basket", [{ orderId: "order-of-someone-else" }]],
    ]) {
      assertFailClosed(await w.call(w.at(0, 1), { inFlight }), R.IN_FLIGHT_UNREADABLE, name)
    }
    assert.equal(w.rows().length, rowsBefore, "nothing was decided")
  })
})

describe("rule: what the journal stores", () => {
  test("per leg the decision price as a double and its source, and the module's perLeg, picks and next exactly as returned", async () => {
    const ref = [0.1 + 0.2, 95000.123456789, 1.2345678901234567]
    const tick0 = [1 / 3, 93158.097992, 5e-7]
    const w = makeWorld({ prices: { ref, 0: tick0 } })
    await w.poll(T0 + 1)
    await w.poll(w.at(0, 1))
    const row = w.row(0)
    LEGS.forEach((i) => {
      assert.ok(Object.is(w.row(REFERENCE_TICK)[`leg${i}_price`], ref[i]), `reference leg ${i}: ${ref[i]} came back as the same double`)
      assert.ok(Object.is(row[`leg${i}_price`], tick0[i]), `tick 0 leg ${i}: ${tick0[i]} came back as the same double`)
      assert.ok(Object.is(row.per_leg[i].variation, tick0[i] / ref[i] - 1), `leg ${i}: the variation, unrounded`)
      assert.equal(row[`leg${i}_price_source`], `test-source-${i}`)
    })
    assertRowIsDecision(row, decide(w.basket, 0, [[0, ref[0], null], [0, ref[1], null], [0, ref[2], null]], null, tick0), "tick 0")
    assert.deepEqual(Object.keys(row.per_leg[0]).sort(), ["inBand", "protected", "reason", "variation"])
    assert.equal(row.band_add, null, "no stable leg, no bandAdd")
    assert.equal(row.decided_at, new Date(w.at(0, 1) * 1000).toISOString())
    assert.equal(row.basket_id, w.basket.id)
  })

  test("a null variation is stored as null (no previous price), never as 0; 'paused' is reason rule9", async () => {
    const w = makeWorld({ firstBuy: FIRST_BUY.NOW, mode: "rigid", prices: { 0: [100, 100, 100], 1: [70, 100, 100] } })
    const first = await w.poll(T0 + 1)
    assert.deepEqual(w.row(0).per_leg.map((leg) => leg.variation), [null, null, null])
    w.execute(first.picks[0])
    await w.poll(w.at(1, 1))
    assert.deepEqual(w.row(1).per_leg[0], { variation: 70 / 100 - 1, protected: true, inBand: null, reason: LEG_REASONS.RULE9 })
    assert.equal(w.row(1).per_leg[1].variation, 0, "a real 0 stays 0")
  })
})

describe("rule: the stable leg's price and bandAdd come as a pair (SPEC §4a)", () => {
  const stable = { stableLeg: 2, bandBps: 100, prices: { ref: [100, 100, 1], 0: [100, 100, 0.992] } }

  test("its own feed with the feed's deviation threshold: 0.992 at band 1% is out of band with bandAdd 0.003, in band with the quorum's 0", async () => {
    const feed = makeWorld({ ...stable, bandAdd: 0.003 })
    await feed.poll(T0 + 1)
    await feed.poll(feed.at(0, 1))
    assert.equal(feed.row(0).leg2_price, 0.992)
    assert.equal(feed.row(0).band_add, 0.003)
    assert.deepEqual(feed.row(0).per_leg[2], { variation: 0.992 / 1 - 1, protected: false, inBand: false, reason: LEG_REASONS.BAND })
    assertRowIsDecision(feed.row(0), decide(feed.basket, 0, [[0, 100, null], [0, 100, null], [0, 1, null]], null, [100, 100, 0.992], 0.003), "feed")

    const quorum = makeWorld({ ...stable, bandAdd: 0 })
    await quorum.poll(T0 + 1)
    const first = await quorum.poll(quorum.at(0, 1))
    assert.equal(quorum.row(0).band_add, 0)
    assert.equal(quorum.row(0).per_leg[2].inBand, true)
    assert.equal(first.picks[0].leg, 2, "in band, and the one that fell")
  })

  test("the resolver is told which leg is the stable one, and only that leg's bandAdd is used", async () => {
    const w = makeWorld({
      ...stable,
      answer: (leg, tick) => ({ price: tick === null ? [100, 100, 1][leg] : [100, 100, 0.992][leg], source: "test", bandAdd: leg === 2 ? 0.003 : 0.5 }),
    })
    await w.poll(T0 + 1)
    assert.deepEqual(w.calls, LEG_TOKENS.map((token, i) => [token, { stable: i === 2 }]))
    assert.equal(w.row(REFERENCE_TICK).band_add, 0.003)
    await w.poll(w.at(0, 1))
    assert.equal(w.row(0).band_add, 0.003, "the 0.5 of the other legs is not a band_add")
  })

  test("a stable price without its bandAdd is no pair: nothing is decided and nothing is written", async () => {
    for (const bandAdd of [undefined, null, "0.003", Number.NaN, -0.001, Number.POSITIVE_INFINITY]) {
      const w = makeWorld({ ...stable, answer: (leg) => ({ price: [100, 100, 0.992][leg], source: "test", ...(leg === 2 ? { bandAdd } : {}) }) })
      const reference = await w.poll(T0 + 1)
      assertFailClosed(reference, R.PRICE_ERROR, `reference, bandAdd ${String(bandAdd)}`)
      const tick = await w.poll(w.at(0, 1))
      assertFailClosed(tick, R.PRICE_ERROR, `tick, bandAdd ${String(bandAdd)}`)
      assert.match(tick.detail, /bandAdd/)
      assert.equal(w.rows().length, 0)
    }
  })

  test("a stable leg with no price has no pair: band_add is null, the leg is out of the tick (no_price)", async () => {
    const w = makeWorld({ ...stable, bandAdd: 0.003, prices: { ref: [100, 100, 1], 0: [100, 100, null] } })
    await w.poll(T0 + 1)
    assert.equal(w.row(REFERENCE_TICK).band_add, 0.003)
    const first = await w.poll(w.at(0, 1))
    assert.equal(first.failClosed, false)
    assert.equal(w.row(0).leg2_price, null)
    assert.equal(w.row(0).band_add, null)
    assert.equal(w.row(0).per_leg[2].reason, LEG_REASONS.NO_PRICE)
    assert.equal(w.row(0).per_leg[2].inBand, null)
  })
})

describe("rule: fail closed", () => {
  /** Nothing was read, resolved or written. */
  function assertUntouched(w, at) {
    assert.deepEqual(w.store.state.log, [], `${at}: the database was not touched`)
    assert.equal(w.calls.length, 0, `${at}: no price was resolved`)
  }

  test("a missing basket row: nothing executes", async () => {
    for (const basket of [null, undefined]) {
      const w = makeWorld()
      const result = await w.call(w.at(0, 1), { basket })
      assertFailClosed(result, R.BASKET_MISSING)
      assert.equal(result.basketId, null)
      assertUntouched(w, String(basket))
    }
  })

  test("an unreadable basket row: nothing executes, whatever is wrong with it", async () => {
    const without = (key) => (row) => {
      delete row[key]
    }
    const set = (key, value) => (row) => {
      row[key] = value
    }
    const cases = [
      ["a string instead of a row", () => "basket"],
      ["an array instead of a row", () => []],
      ["no id", without("id")],
      ["an id that is a number", set("id", 7)],
      ["a wallet that is not an address", set("wallet", "0x1234")],
      ["no wallet", without("wallet")],
      ["chain_id as text", set("chain_id", "8453")],
      ["no token_in", without("token_in")],
      ["an odd cadence", set("cadence_s", 86_401)],
      ["a zero cadence", set("cadence_s", 0)],
      ["cadence as text", set("cadence_s", "86400")],
      ["no cadence", without("cadence_s")],
      ["zero cycles", set("cycles", 0)],
      ["a fractional cycle count", set("cycles", 6.5)],
      ["more cycles than the module takes", set("cycles", 10_001)],
      ["t0 in milliseconds", set("t0", T0 * 1000)],
      ["no t0", without("t0")],
      ["an unknown first_buy", set("first_buy", "later")],
      ["no first_buy", without("first_buy")],
      ["an unknown mode", set("mode", "medium")],
      ["a threshold of 0", set("threshold_bps", 0)],
      ["a threshold of 100%", set("threshold_bps", 10_000)],
      ["no stable_leg column", without("stable_leg")],
      ["a fourth leg as the stable one", set("stable_leg", 3)],
      ["a stable leg with no band", set("stable_leg", 1)],
      ["a band with no stable leg", set("band_bps", 100)],
      ["no status", without("status")],
      ["a leg token that is not an address", set("leg1_token_out", "USDT")],
      ["a leg with n = 0", set("leg2_n", 0)],
      ["a leg with no n", without("leg0_n")],
      ["a leg order hash that is not a hash", set("leg0_order_hash", "0xabc")],
      ["two legs with the same token", set("leg1_token_out", LEG_TOKENS[0])],
      ["a leg that buys the token sold", set("leg2_token_out", TOKEN_IN)],
      ["two legs with the same order hash", set("leg2_order_hash", LEG_HASHES[0])],
    ]
    for (const [name, corrupt] of cases) {
      const w = makeWorld()
      const row = through(w.basket)
      const replaced = corrupt(row)
      const result = await w.call(w.at(0, 1), { basket: replaced === undefined ? row : replaced })
      assertFailClosed(result, R.BASKET_UNREADABLE, name)
      assert.deepEqual(result.wrote, [], name)
      assertUntouched(w, name)
    }
  })

  test("a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket", async () => {
    const other = `0x${"9".repeat(40)}`
    const onLeg = (leg, change) => (orders) => {
      change(orders[leg])
    }
    const cases = [
      // The four the rule names, on the row and on the signed struct the executor sends.
      ["token: leg 0 buys another token", onLeg(0, (o) => { o.token_out = other })],
      ["token: leg 1 buys leg 2's token", onLeg(1, (o) => { o.token_out = LEG_TOKENS[2] })],
      ["token: the signed order buys another token", onLeg(2, (o) => { o.order_data.tokenOut = other })],
      ["token: leg 2 sells another token", onLeg(2, (o) => { o.token_in = other })],
      ["token: the signed order sells another token", onLeg(0, (o) => { o.order_data.tokenIn = other })],
      ["n: leg 0 has one chunk more", onLeg(0, (o) => { o.dca_total += 1 })],
      ["n: the signed order has one chunk more", onLeg(1, (o) => { o.order_data.dcaTotal = "3" })],
      ["n: the signed order has no dcaTotal", onLeg(1, (o) => { delete o.order_data.dcaTotal })],
      ["owner: leg 1 belongs to another wallet", onLeg(1, (o) => { o.wallet = other })],
      ["owner: the signed order belongs to another wallet", onLeg(2, (o) => { o.order_data.owner = other })],
      ["chain: leg 2 is on another chain", onLeg(2, (o) => { o.chain_id = 42161 })],
      // What makes the three rows the basket's three legs at all.
      ["leg 0 belongs to another basket", onLeg(0, (o) => { o.basket_id = "another-basket" })],
      ["leg 0 belongs to no basket", onLeg(0, (o) => { o.basket_id = null })],
      ["leg 1 is not a DCA order", onLeg(1, (o) => { o.order_type = "limit" })],
      ["leg 2 has another order hash", onLeg(2, (o) => { o.order_hash = `0x${"ff".repeat(32)}` })],
      ["leg 0 has no signed order", onLeg(0, (o) => { o.order_data = null })],
      ["leg 1 has executed more than n", onLeg(1, (o) => { o.dca_executed = 3 })],
      ["leg 1 has a negative executed count", onLeg(1, (o) => { o.dca_executed = -1 })],
      ["leg 2 has executed as text", onLeg(2, (o) => { o.dca_executed = "1" })],
      ["leg 2 has no id", onLeg(2, (o) => { delete o.id })],
      ["leg 2 has no status", onLeg(2, (o) => { delete o.status })],
      ["two rows", (orders) => orders.slice(0, 2)],
      ["a fourth row", (orders) => [...orders, { ...orders[0], id: "order-3", order_hash: `0x${"0d".repeat(32)}` }]],
      ["the same row twice", (orders) => [orders[0], orders[0], orders[1]]],
      ["two rows with the same id", onLeg(1, (o) => { o.id = "order-0" })],
      ["no rows", () => []],
      ["not an array", () => null],
      ["a row that is not an object", (orders) => [orders[0], orders[1], "order-2"]],
    ]
    for (const [name, corrupt] of cases) {
      const w = makeWorld()
      const orders = through(w.orders)
      const replaced = corrupt(orders)
      const result = await w.call(w.at(0, 1), { orders: replaced === undefined ? orders : replaced })
      assertFailClosed(result, R.ORDERS_MISMATCH, name)
      assert.equal(result.basketId, w.basket.id, name)
      assert.deepEqual(result.wrote, [], name)
      assertUntouched(w, name)
    }
    // The contrary: the same rows untouched, in any order, with addresses in any case, are the basket's legs.
    const w = makeWorld()
    const fine = await w.call(w.at(0, 1), { orders: through([w.orders[1], w.orders[2], w.orders[0]]).map((o) => ({ ...o, wallet: o.wallet.toUpperCase().replace("0X", "0x") })) })
    assert.equal(fine.failClosed, false)
    assert.deepEqual(fine.picks.map((p) => p.orderId), ["order-0"])
  })

  test("decideTick throwing: nothing is written and nothing executes; the next poll may decide", async () => {
    // A reference of 1e-300 and a price of 1e300: the variation is not a finite number and the module refuses it.
    const w = makeWorld({ prices: { ref: [1e-300, 100, 100], 0: [1e300, 100, 100] } })
    await w.poll(T0 + 1)
    assert.throws(() => decide(w.basket, 0, [[0, 1e-300, null], [0, 100, null], [0, 100, null]], null, [1e300, 100, 100]), RangeError)
    const refused = await w.poll(w.at(0, 1))
    assertFailClosed(refused, R.DECIDE_ERROR)
    assert.match(refused.detail, /not finite/)
    assert.deepEqual(refused.wrote, [])
    assert.equal(w.row(0), undefined)
    assert.equal(refused.tick, 0)
    // The same tick, a poll later, with a price the module accepts.
    w.prices[0] = [99, 100, 100]
    const decided = await w.poll(w.at(0, 16))
    assert.equal(decided.failClosed, false)
    assert.deepEqual(decided.picks.map((p) => p.orderId), ["order-1"], "1e-300 → 99 is a rise; legs 1 and 2 tie at 0 and leg 1 comes first")
  })

  test("a price resolver that throws, or answers with anything but a price or null: nothing is decided, and its message stays out of the detail", async () => {
    const secret = "fetch failed https://base-mainnet.example/v2/SECRET-RPC-KEY"
    const thrown = makeWorld({ answer: () => { throw new Error(secret) } })
    for (const now of [T0 + 1, thrown.at(0, 1)]) {
      const result = await thrown.poll(now)
      assertFailClosed(result, R.PRICE_ERROR)
      assert.ok(!/SECRET|https?:|example/.test(result.detail), result.detail)
    }
    assert.equal(thrown.rows().length, 0)
    const junk = [
      ["undefined", undefined],
      ["a bare number", 100],
      ["a string", "100"],
      ["no price field", { source: "test" }],
      ["a price as text", { price: "100", source: "test" }],
      ["a negative price", { price: -1, source: "test" }],
      ["zero", { price: 0, source: "test" }],
      ["NaN", { price: Number.NaN, source: "test" }],
      ["Infinity", { price: Number.POSITIVE_INFINITY, source: "test" }],
      ["a price with no source", { price: 100 }],
      ["an empty source", { price: 100, source: "" }],
      ["a source that is a URL", { price: 100, source: "https://rpc.example/v2/KEY" }],
      ["a source 65 characters long", { price: 100, source: "a".repeat(65) }],
    ]
    for (const [name, answer] of junk) {
      const w = makeWorld({ answer: (leg) => (leg === 1 ? answer : { price: 100, source: "test" }) })
      assertFailClosed(await w.poll(T0 + 1), R.PRICE_ERROR, `reference: ${name}`)
      assertFailClosed(await w.poll(w.at(0, 1)), R.PRICE_ERROR, `tick: ${name}`)
      assert.equal(w.rows().length, 0, name)
    }
  })

  test("an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode", async () => {
    const failed = makeWorld()
    failed.store.state.failRead = new Error("503 https://db.example/rest/v1/basket_ticks?apikey=SERVICE-ROLE-KEY")
    const unread = await failed.poll(failed.at(0, 1))
    assertFailClosed(unread, R.JOURNAL_UNREADABLE)
    assert.ok(!/SERVICE|apikey|https?:/.test(unread.detail), unread.detail)
    assert.equal(failed.calls.length, 0)

    const notArray = makeWorld()
    assertFailClosed(await notArray.call(notArray.at(0, 1), {}, { db: { ...notArray.store.api, readTicks: async () => ({ rows: [] }) } }), R.JOURNAL_UNREADABLE, "not an array")

    /** A good journal (reference + tick 0), then one row of it changed. */
    async function withRows(change, opts) {
      const w = makeWorld(opts)
      if (w.basket.first_buy === FIRST_BUY.REFERENCE) await w.poll(T0 + 1)
      await w.poll(w.at(0, 1))
      const calls = w.calls.length
      change(w.store.state.ticks, w)
      const result = await w.poll(w.at(1, 1))
      assert.equal(w.calls.length, calls, "no price is resolved over an unreadable journal")
      assert.equal(w.row(1), undefined, "and tick 1 is not decided")
      return result
    }
    const tick0 = (rows) => rows.find((row) => row.tick === 0)
    const cases = [
      // A query that returns more than this basket's rows: the coordinator checks each row itself.
      ["a row that is not an object", (rows, w) => { rows.push("row"); w.store.state.leak = true }],
      ["a row of another basket", (rows, w) => { tick0(rows).basket_id = "another-basket"; w.store.state.leak = true }],
      ["a tick below -1", (rows) => { tick0(rows).tick = -2 }],
      ["a tick beyond the last grace tick", (rows) => { tick0(rows).tick = 9 }],
      ["a fractional tick", (rows) => { tick0(rows).tick = 0.5 }],
      ["a price as text (a NUMERIC column would do that)", (rows) => { tick0(rows).leg0_price = "100" }],
      ["a negative price", (rows) => { tick0(rows).leg1_price = -5 }],
      ["a missing price column", (rows) => { delete tick0(rows).leg2_price }],
      ["picks that are not an array", (rows) => { tick0(rows).picks = { leg: 0 } }],
      ["a pick with no leg", (rows) => { tick0(rows).picks = [{ kind: "select", slot: 1 }] }],
      ["a pick with an unknown kind", (rows) => { tick0(rows).picks[0].kind = "bonus" }],
      ["a first pick in slot 2", (rows) => { tick0(rows).picks[0].slot = 2 }],
      ["three chunks of one leg", (rows) => { tick0(rows).picks = [1, 2, 3].map((slot) => ({ leg: 0, kind: "catchup", slot })) }],
      ["no next_state", (rows) => { tick0(rows).next_state = null }],
      ["a next_state with two legs", (rows) => { tick0(rows).next_state.legs.pop() }],
      ["a cooldown that is not a leg", (rows) => { tick0(rows).next_state.cooldown = 3 }],
      ["a cooldown that is not the first pick", (rows) => { tick0(rows).next_state.cooldown = 2 }],
      ["a done at the decision above n", (rows) => { tick0(rows).next_state.legs[0].done = 5 }],
      ["picks with an idle reason", (rows) => { tick0(rows).idle_reason = "calendar" }],
      ["no picks and no idle reason", (rows) => { tick0(rows).picks = []; tick0(rows).next_state.cooldown = null }],
      ["two rows for one tick", (rows) => { rows.push({ ...through(tick0(rows)), id: "copy" }) }],
      ["a reference row that carries picks", (rows) => { rows.find((row) => row.tick === -1).picks = [] }],
    ]
    for (const [name, change] of cases) assertFailClosed(await withRows(change), R.JOURNAL_UNREADABLE, name)
    const nowMode = await withRows((rows) => {
      rows.push({ ...through(tick0(rows)), id: "ref", tick: -1, per_leg: null, picks: null, next_state: null, idle_reason: null })
    }, { firstBuy: FIRST_BUY.NOW })
    assertFailClosed(nowMode, R.JOURNAL_UNREADABLE, "a reference row in 'now' mode")
  })

  test("order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or any other", async () => {
    for (const leg of LEGS) {
      // Every leg has one chunk done when tick 3 is decided (one more is due, and one leg is picked).
      const w = makeWorld({ done: [1, 1, 1] })
      await w.poll(T0 + 1)
      const first = await w.poll(w.at(3, 1))
      assert.equal(first.picks.length, 1)
      assert.deepEqual(w.row(3).next_state.legs.map((l) => l.done), [1, 1, 1])
      w.orders[leg].dca_executed = 0 // an executed count never goes down
      const result = await w.poll(w.at(3, 2))
      assertFailClosed(result, R.ORDERS_MISMATCH, `leg ${leg}`)
      assert.match(result.detail, new RegExp(`leg ${leg}: dca_executed is lower`))
      assert.deepEqual(result.wrote, [])
    }
  })

  test("a clock that is not unix seconds (milliseconds would expire every basket), or that is behind the journal", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const before = through(w.store.state)
    for (const [name, now] of [
      ["milliseconds", () => (T0 + DAY) * 1000],
      ["NaN", () => Number.NaN],
      ["zero", () => 0],
      ["a string", () => String(T0)],
      ["a Date", () => new Date((T0 + DAY) * 1000)],
      ["a clock that throws", () => { throw new Error("no clock") }],
    ]) {
      assertFailClosed(await w.call(0, {}, { now }), R.CLOCK_INVALID, name)
    }
    assert.deepEqual(through(w.store.state), before, "nothing was read or written, and no status was touched")
    assert.equal(w.basket.status, BASKET_STATUS.ACTIVE)
    // Tick 1 has a row, and the clock now says tick 0: it is behind the keeper that wrote it. Decide nothing.
    await w.poll(w.at(0, 1))
    await w.poll(w.at(1, 1))
    const calls = w.calls.length
    const behind = await w.poll(w.at(1, -1))
    assertFailClosed(behind, R.CLOCK_BEHIND_JOURNAL)
    assert.equal(w.calls.length, calls)
    const beforeFirst = await w.poll(T0 + 60)
    assertFailClosed(beforeFirst, R.CLOCK_BEHIND_JOURNAL, "before the first tick, with ticks in the journal")
  })

  test("it never throws and never returns a pick, whatever it is given", async () => {
    const w = makeWorld()
    const good = { now: () => w.at(0, 1), db: w.store.api, resolvePrice: w.resolvePrice }
    const input = { basket: through(w.basket), orders: through(w.orders), inFlight: [] }
    const boom = () => {
      throw new TypeError("boom")
    }
    const attempts = [
      [undefined, undefined],
      [null, null],
      [input, undefined],
      [input, {}],
      [input, { ...good, now: 5 }],
      [input, { ...good, resolvePrice: null }],
      [input, { ...good, db: null }],
      [input, { ...good, db: { readTicks: good.db.readTicks } }],
      [input, { ...good, db: { ...good.db, readTicks: boom } }],
      [input, { ...good, db: { ...good.db, insertTick: boom } }],
      [input, { ...good, resolvePrice: boom }],
      ["basket", good],
      [{}, good],
      [{ basket: input.basket }, good],
      [{ ...input, orders: [1, 2, 3] }, good],
    ]
    for (const [i, [anInput, deps]] of attempts.entries()) {
      const result = await coordinateBasket(anInput, deps)
      assert.deepEqual(result.picks, [], `attempt ${i}`)
      assert.equal(result.failClosed, true, `attempt ${i}: ${result.reason}`)
      assert.equal(typeof result.reason, "string", `attempt ${i}`)
      assert.ok(!/boom/.test(result.detail), `attempt ${i}: ${result.detail}`)
    }
    assert.equal(w.rows().length, 0)
  })

  test("an error nobody foresaw is still fail closed (internal_error), never a rejection: rows and answers that throw when read", async () => {
    const w = makeWorld()
    const trap = (target, key) =>
      Object.defineProperty({ ...target }, key, {
        enumerable: true,
        get() {
          throw new TypeError("boom https://rpc.example/v2/SECRET-KEY")
        },
      })
    const deps = { now: () => w.at(0, 1), db: w.store.api, resolvePrice: w.resolvePrice }
    const input = { basket: through(w.basket), orders: through(w.orders), inFlight: [] }
    const attempts = [
      ["a basket row whose id throws", { ...input, basket: trap(input.basket, "id") }, deps],
      ["an order row whose status throws", { ...input, orders: [trap(input.orders[0], "status"), input.orders[1], input.orders[2]] }, deps],
      ["a price answer whose price throws", input, { ...deps, resolvePrice: async () => trap({ source: "test" }, "price") }],
      ["a journal row whose tick throws", input, { ...deps, db: { ...deps.db, readTicks: async () => [trap({ basket_id: w.basket.id }, "tick")] } }],
      ["a stored row whose picks throw", input, { ...deps, db: { ...deps.db, insertTick: async (row) => trap(row, "picks") } }],
    ]
    for (const [name, anInput, someDeps] of attempts) {
      const result = await coordinateBasket(anInput, someDeps)
      assertFailClosed(result, R.INTERNAL_ERROR, name)
      assert.equal(result.detail, "unexpected TypeError", name)
      assert.deepEqual(result.wrote, [], name)
    }
  })

  test("every reason is named once, and the fail-closed ones are exactly the ones that mean something is wrong", () => {
    const all = Object.values(R)
    assert.equal(new Set(all).size, all.length)
    assert.deepEqual(
      all.filter((reason) => !FAIL_CLOSED_REASONS.includes(reason)).sort(),
      ["basket_not_active", "before_first_tick", "completed", "expired", "in_flight", "picks_executed", "reference_recorded", "slot_not_reached", "tick_idle"],
    )
    assert.ok(FAIL_CLOSED_REASONS.every((reason) => all.includes(reason)))
  })
})

describe("rule: status", () => {
  test("completed when every leg is complete: the status is written, and nothing is read, resolved or decided", async () => {
    const w = makeWorld({ done: [2, 2, 2] })
    const result = await w.poll(w.at(3, 1))
    assert.equal(result.reason, R.COMPLETED)
    assert.equal(result.failClosed, false)
    assert.deepEqual(result.picks, [])
    assert.deepEqual(result.wrote, [{ table: "baskets", row: { id: w.basket.id, status: "completed" } }])
    assert.deepEqual(w.store.state.log, ["setBasketStatus completed"])
    assert.equal(w.basket.status, BASKET_STATUS.COMPLETED)
    assert.equal(w.calls.length, 0)
    // One leg short is not complete.
    const short = makeWorld({ done: [2, 2, 1] })
    assert.notEqual((await short.poll(short.at(3, 1))).reason, R.COMPLETED)
    assert.deepEqual(short.store.state.statusWrites, [])
  })

  test("expired after the last grace tick's window, one T after its time: a second earlier the last grace tick still executes", async () => {
    const w = makeWorld()
    await w.poll(T0 + 1)
    const lastSecond = await w.poll(w.tl.end - 1)
    assert.equal(lastSecond.tick, 8)
    assert.ok(lastSecond.picks.length > 0, "the last grace tick is decided and executable until its window ends")
    assert.deepEqual(w.store.state.statusWrites, [])
    const calls = w.calls.length
    const expired = await w.poll(w.tl.end)
    assert.equal(expired.reason, R.EXPIRED)
    assert.equal(expired.failClosed, false)
    assert.deepEqual(expired.picks, [])
    assert.deepEqual(expired.wrote, [{ table: "baskets", row: { id: w.basket.id, status: "expired" } }])
    assert.equal(w.basket.status, BASKET_STATUS.EXPIRED)
    assert.equal(w.calls.length, calls)
    assert.equal(w.row(9), undefined, "there is no tick after the last grace tick")
    assert.equal(w.tl.end, T0 + 10 * DAY)
  })

  test("the last grace tick's second slot is executable at + T / 2, before the basket expires", async () => {
    const w = makeWorld({ prices: { 8: [100, null, null] } })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(8, 1))
    assert.deepEqual(first.picks, [{ orderId: "order-0", leg: 0, tick: 8, slot: 1, kind: "select" }])
    w.execute(first.picks[0])
    const second = await w.poll(w.at(8, HALF))
    assert.deepEqual(second.picks, [{ orderId: "order-0", leg: 0, tick: 8, slot: 2, kind: "catchup" }])
    assert.ok(w.at(8, HALF) < w.tl.end)
  })

  test("a basket that finished is completed even when it is looked at after its end; an unfinished one expires", async () => {
    const finished = makeWorld({ done: [2, 2, 2] })
    assert.equal((await finished.poll(finished.tl.end + 5 * DAY)).reason, R.COMPLETED)
    const unfinished = makeWorld({ done: [2, 2, 1] })
    assert.equal((await unfinished.poll(unfinished.tl.end + 5 * DAY)).reason, R.EXPIRED)
    assert.deepEqual(unfinished.store.state.log, ["setBasketStatus expired"], "no journal read, no decision after the end")
  })

  test("expiry waits for a transaction in flight: its outcome may complete the basket", async () => {
    const w = makeWorld({ done: [2, 2, 1] })
    const waiting = await w.poll(w.tl.end + 1, { inFlight: [{ orderId: "order-2" }] })
    assert.equal(waiting.reason, R.IN_FLIGHT)
    assert.deepEqual(w.store.state.statusWrites, [])
    w.orders[2].dca_executed = 2
    assert.equal((await w.poll(w.tl.end + 30)).reason, R.COMPLETED)
  })

  test("a basket that is not active executes nothing and is not touched", async () => {
    for (const status of [BASKET_STATUS.CANCELLED, BASKET_STATUS.COMPLETED, BASKET_STATUS.EXPIRED, "paused-by-something-new"]) {
      const w = makeWorld({ status })
      const result = await w.poll(w.at(0, 1))
      assert.equal(result.reason, R.BASKET_NOT_ACTIVE, status)
      assert.equal(result.failClosed, false, status)
      assert.deepEqual(result.picks, [], status)
      assert.deepEqual(w.store.state.log, [], status)
      assert.equal(w.calls.length, 0, status)
      assert.ok(!result.detail.includes("something-new"), "an unknown status string is not echoed")
    }
  })

  test("a status write that fails or is not confirmed is reported, and tried again at the next poll", async () => {
    const w = makeWorld({ done: [2, 2, 2] })
    w.store.state.failStatus = new Error("timeout https://db.example/rest/v1/baskets?apikey=SERVICE-ROLE-KEY")
    const failed = await w.poll(w.at(0, 1))
    assertFailClosed(failed, R.STATUS_WRITE_FAILED)
    assert.deepEqual(failed.wrote, [])
    assert.ok(!/SERVICE|apikey|https?:/.test(failed.detail), failed.detail)
    w.store.state.failStatus = null
    const unconfirmed = await w.call(w.at(0, 2), {}, { db: { ...w.store.api, setBasketStatus: async () => undefined } })
    assertFailClosed(unconfirmed, R.STATUS_WRITE_FAILED, "not confirmed")
    assert.equal((await w.poll(w.at(0, 16))).reason, R.COMPLETED)
  })
})

// ------------------------------------------------------------------------------------------------ the module itself
describe("the module has no clock, network or state of its own", () => {
  const source = readFileSync(new URL("./basket-coordinator.js", import.meta.url), "utf8")
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")

  test("its only import is the selection module; no clock, timer, network, environment or randomness", () => {
    assert.deepEqual([...code.matchAll(/^import .* from "(.*)"$/gm)].map((m) => m[1]), ["./basket-scheduler.js"])
    for (const [name, pattern] of [
      ["Date.now", /\bDate\.now\b/],
      ["new Date() with no argument", /\bnew Date\(\s*\)/],
      ["performance", /\bperformance\b/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /\bprocess\./],
      ["timers", /\bset(Timeout|Interval|Immediate)\b/],
      ["Math.random", /\bMath\.random\b/],
      ["globalThis", /\bglobalThis\b/],
      ["require or dynamic import", /\brequire\s*\(|\bimport\s*\(/],
      ["console", /\bconsole\./],
    ]) {
      assert.ok(!pattern.test(code), `basket-coordinator.js uses ${name}`)
    }
    assert.equal((code.match(/\bnew Date\(/g) ?? []).length, 1, "one Date: the ISO text of the injected now")
  })

  test("no module-level variable can change: every top-level binding is a const, a function or a class", () => {
    const topLevel = code.split("\n").filter((line) => /^[a-z]/.test(line))
    assert.ok(topLevel.length > 20)
    for (const line of topLevel) {
      assert.match(line, /^(import |export (const|function|async function) |const |function |async function |class )/, line)
    }
    assert.ok(!/^(export )?(let|var) /m.test(code))
  })

  test("the same poll twice over the same rows gives the same answer (a row read back is never decided again)", async () => {
    const w = makeWorld({ prices: { ref: [100, 100, 100], 0: [101, 95, 99] } })
    await w.poll(T0 + 1)
    const first = await w.poll(w.at(0, 1))
    const again = await w.poll(w.at(0, 1))
    assert.deepEqual(again.picks, first.picks)
    assert.deepEqual({ ...again, wrote: [] }, { ...first, wrote: [] })
  })

  test("executor.js does not import the coordinator: the keeper behaves as before", () => {
    const executor = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
    assert.ok(!executor.includes("basket-coordinator"), "executor.js mentions basket-coordinator")
    assert.ok(!executor.includes("basket_id"), "executor.js reads basket_id")
  })
})

// ------------------------------------------------------------------------------------------------ the migration
describe("migration 20261116120000_baskets_split_dca.sql (text only: it is never run here)", () => {
  const url = new URL("../../../supabase/migrations/20261116120000_baskets_split_dca.sql", import.meta.url)
  const sql = existsSync(url) ? readFileSync(url, "utf8") : ""
  /** The statements, with every `--` comment and blank line removed. */
  const statements = (text) =>
    text
      .split("\n")
      .map((line) => line.replace(/\s*--.*$/, "").trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n")
  const ddl = statements(sql)
  /** The column lines of one CREATE TABLE: name → the rest of the line. */
  function columnsOf(table) {
    const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
    assert.ok(start >= 0, `no CREATE TABLE IF NOT EXISTS ${table}`)
    const body = ddl.slice(start, ddl.indexOf("\n);", start)).split("\n").slice(1)
    const columns = new Map()
    for (const line of body) {
      const m = line.match(/^ {2}([a-z][a-z0-9_]*)\s+([A-Z].*?),?$/)
      if (m) columns.set(m[1], m[2])
    }
    return columns
  }

  test("it exists, and creates baskets, basket_ticks and orders.basket_id", () => {
    assert.ok(existsSync(url), "supabase/migrations/20261116120000_baskets_split_dca.sql")
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS baskets \(/)
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS basket_ticks \(/)
    assert.match(ddl, /^ALTER TABLE orders ADD COLUMN IF NOT EXISTS basket_id UUID REFERENCES baskets\(id\) ON DELETE RESTRICT;$/m)
  })

  test("additive, nullable, forward-only: the only change to an existing table is one nullable column with no default", () => {
    const alters = ddl.split("\n").filter((line) => /^ALTER TABLE/.test(line))
    assert.deepEqual(alters, [
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS basket_id UUID REFERENCES baskets(id) ON DELETE RESTRICT;",
      "ALTER TABLE baskets ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE basket_ticks ENABLE ROW LEVEL SECURITY;",
    ])
    assert.ok(!/NOT NULL|DEFAULT/.test(alters[0]), "orders.basket_id is NULL for every existing order")
    for (const forbidden of [/\bDROP TABLE\b/, /\bDROP COLUMN\b/, /\bALTER COLUMN\b/, /\bDELETE FROM\b/, /\bTRUNCATE\b/, /^UPDATE /m, /\bRENAME\b/, /^INSERT /m]) {
      assert.ok(!forbidden.test(ddl), `the migration has ${forbidden}`)
    }
    // The only DROPs are the two policies it recreates, so that it can be run twice.
    assert.deepEqual(ddl.match(/^DROP .*$/gm), [
      'DROP POLICY IF EXISTS "Users can view own baskets" ON baskets;',
      'DROP POLICY IF EXISTS "Users can view ticks of own baskets" ON basket_ticks;',
    ])
    assert.match(sql, /-- ROLLBACK/)
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_basket_id/, "the OPS note names the CONCURRENTLY form")
  })

  test("decision prices and band_add are DOUBLE PRECISION; no NUMERIC, DECIMAL or REAL column anywhere", () => {
    const ticks = columnsOf("basket_ticks")
    for (const column of ["leg0_price", "leg1_price", "leg2_price", "band_add"]) assert.equal(ticks.get(column), "DOUBLE PRECISION", column)
    assert.ok(!/\b(NUMERIC|DECIMAL|REAL|MONEY)\b/i.test(ddl))
  })

  test("the journal is unique on (basket_id, tick), tick -1 is allowed, and a row is either the reference or a whole decision", () => {
    assert.match(ddl, /CONSTRAINT basket_ticks_basket_tick_unique UNIQUE \(basket_id, tick\)/)
    assert.match(ddl, /CONSTRAINT basket_ticks_tick_valid CHECK \(tick >= -1\)/)
    assert.match(ddl, /\(tick = -1 AND per_leg IS NULL AND picks IS NULL AND next_state IS NULL AND idle_reason IS NULL\)\s+OR \(tick >= 0 AND per_leg IS NOT NULL AND picks IS NOT NULL AND next_state IS NOT NULL\)/)
    assert.equal(columnsOf("basket_ticks").get("basket_id"), "UUID NOT NULL REFERENCES baskets(id) ON DELETE RESTRICT")
  })

  test("its value lists are the code's: first_buy, the basket statuses, the module's idle reasons", () => {
    const list = (constraint) => {
      const m = ddl.match(new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\s*(?:[a-z_]+ IS NULL OR )?[a-z_]+ IN \\(([^)]*)\\)`))
      assert.ok(m, constraint)
      return m[1].split(",").map((item) => item.trim().replace(/^'|'$/g, ""))
    }
    assert.deepEqual(list("baskets_first_buy_valid").sort(), Object.values(FIRST_BUY).sort())
    assert.deepEqual(list("baskets_status_valid").sort(), Object.values(BASKET_STATUS).sort())
    assert.deepEqual(list("basket_ticks_idle_reason_valid").sort(), Object.values(IDLE_REASONS).sort())
    assert.match(ddl, /first_buy\s+TEXT NOT NULL DEFAULT 'reference'/)
  })

  test("every column the coordinator writes or reads exists: the journal row it stores, and the basket and order fields it checks", async () => {
    const w = makeWorld({ stableLeg: 2, bandBps: 100 })
    const reference = await w.call(T0 + 1)
    const tick = await w.call(w.at(0, 1))
    const ticks = columnsOf("basket_ticks")
    for (const written of [reference.wrote[0].row, tick.wrote[0].row]) {
      for (const column of Object.keys(written)) assert.ok(ticks.has(column), `basket_ticks.${column}`)
    }
    assert.deepEqual([...ticks.keys()].sort(), Object.keys(tick.wrote[0].row).sort(), "and no column the coordinator leaves unwritten")
    const baskets = columnsOf("baskets")
    assert.deepEqual([...baskets.keys()].sort(), Object.keys(makeBasket()).sort(), "the baskets columns are the row the tests build")
    // The leg order is in the column names.
    for (const i of LEGS) for (const field of ["token_out", "weight_num", "weight_den", "n", "order_hash"]) assert.ok(baskets.has(`leg${i}_${field}`), `leg${i}_${field}`)
    assert.equal(baskets.get("t0"), "BIGINT NOT NULL")
    assert.equal(baskets.get("stable_leg"), "SMALLINT")
  })

  test("no visitor data: no column about the browser, the address of the request or the session", () => {
    for (const table of ["baskets", "basket_ticks"]) {
      for (const column of columnsOf(table).keys()) {
        assert.ok(!/(^|_)(ip|ua|user_agent|agent|session|cookie|email|referr?er|device|fingerprint|geo|country|locale)(_|$)/.test(column), `${table}.${column}`)
      }
    }
  })

  test("RLS as for orders: enabled on both tables, and a user may only READ their own rows (no insert, update or delete policy)", () => {
    assert.match(ddl, /^ALTER TABLE baskets ENABLE ROW LEVEL SECURITY;$/m)
    assert.match(ddl, /^ALTER TABLE basket_ticks ENABLE ROW LEVEL SECURITY;$/m)
    const policies = [...ddl.matchAll(/CREATE POLICY "([^"]+)"\s+ON ([a-z_]+) FOR ([A-Z]+)/g)].map((m) => [m[1], m[2], m[3]])
    assert.deepEqual(policies, [
      ["Users can view own baskets", "baskets", "SELECT"],
      ["Users can view ticks of own baskets", "basket_ticks", "SELECT"],
    ])
    // The same wallet claim as the orders policy, character for character.
    const claim = "wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')"
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
    assert.ok(schema.slice(0, schema.indexOf("Split DCA")).includes(claim), "the orders policy uses this claim")
    assert.equal(ddl.split(claim).length - 1, 2)
  })

  test("contracts/order-engine/schema.sql mirrors it, statement for statement", () => {
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
    const from = (text) => text.slice(text.indexOf("CREATE TABLE IF NOT EXISTS baskets ("))
    const migrationBody = statements(sql.slice(0, sql.indexOf("-- ROLLBACK")))
    assert.equal(from(statements(schema)), from(migrationBody))
    assert.ok(from(migrationBody).length > 4000)
  })
})
