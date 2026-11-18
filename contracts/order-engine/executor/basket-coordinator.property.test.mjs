// Seeded property test of basket-coordinator.js, added after the audit of 2026-11-16 (blocked 0C/3H; SPEC-BASKET-DCA §4,
// "Added after the audit"). Random baskets, a clock that moves forward while the injected calls are pending, leg
// orders whose state changes between polls, polls from keepers of other chains, and journal writes that fail or
// lose their answer. Every poll is a fresh coordinateBasket call on fresh copies of the rows, as after a restart.
//
// Four invariants, checked on every poll of every run:
//   I1  never a pick for a leg that cannot execute (an order not 'active' or 'executing', its signed expiry come, or
//       nothing left to buy), and no pick at all while any leg with chunks left cannot execute (S-2);
//   I2  never a row or a pick for a tick past its deadline: a row is written only before its time + T / 2 (the
//       reference row before t0 + T / 2), with decided_at = the clock it was written at; a pick is returned only while
//       its tick is the current one, from its slot time on, and only with its row in the journal (S-1);
//   I3  nothing at all for a basket of another chain: no read, no write, no price, no pick (S-3);
//   I4  at most one row per (basket, tick), on a store that does NOT enforce the unique key, so the property is the
//       coordinator's own (decide once).
//
// The oracle is written from the spec, not from the module: the executable statuses and the deadlines are spelled
// out here, so a coordinator that changed its own constants would not change the check.
//
// To run other seeds, change SEEDS in a scratch copy. No network, no real clock. Node 20 and 22.

import { test, describe, before } from "node:test"
import assert from "node:assert/strict"

import { GRACE_TICKS, chooseN } from "./basket-scheduler.js"
import { COORDINATOR_REASONS as R, FIRST_BUY, REFERENCE_TICK, basketTimeline, coordinateBasket } from "./basket-coordinator.js"

/** Seeds 1 … 300: one random basket and one random life per seed. */
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1)

// ------------------------------------------------------------------------------------------------ the spec, spelled out
const EXECUTABLE = ["active", "executing"] // SPEC §4: a leg with chunks left must be one of these
const DAY = 86_400
const CHAIN = 8453
const SPLITS = [
  [[1, 4], [1, 4], [1, 2]],
  [[2, 5], [2, 5], [1, 5]],
  [[1, 3], [1, 3], [1, 3]],
  [[3, 10], [3, 10], [2, 5]],
]
const CADENCES = [DAY, 3 * DAY, 7 * DAY]
const OTHER_STATUSES = ["cancelled", "expired", "failed", "executed", "paused-by-something-new"]
const OTHER_CHAINS = [1, 10, 42161]
const LEGS = [0, 1, 2]

/** Ticks and deadlines from SPEC §4, independently of basketTimeline. */
function specTimes(basket) {
  const T = basket.cadence_s
  const first = basket.first_buy === FIRST_BUY.REFERENCE ? basket.t0 + T : basket.t0
  const lastTick = basket.cycles + GRACE_TICKS - 1
  const tickTime = (t) => first + t * T
  return {
    T,
    lastTick,
    tickTime,
    end: tickTime(lastTick + 1),
    tickAt: (now) => (now < first ? null : Math.floor((now - first) / T)),
    deadline: (t) => (t === REFERENCE_TICK ? basket.t0 + T / 2 : tickTime(t) + T / 2),
    slotTime: (t, slot) => tickTime(t) + (slot - 1) * (T / 2),
  }
}

// ------------------------------------------------------------------------------------------------ the world
const through = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))
const iso = (seconds) => new Date(seconds * 1000).toISOString()

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

function makeScenario(seed) {
  const rnd = mulberry32(seed)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const cadence = pick(CADENCES)
  const cycles = int(6, 12)
  const weights = pick(SPLITS)
  const n = chooseN(weights, int(60, 5_000), cycles, pick([3, 16]))
  const stableLeg = rnd() < 0.3 ? int(0, 2) : null
  const t0 = 1_800_000_000 + int(0, 10_000_000)
  const basket = {
    id: `basket-${seed}`,
    wallet: `0x${"b".repeat(40)}`,
    chain_id: CHAIN,
    token_in: `0x${"a".repeat(40)}`,
    capital: "1000000000",
    cadence_s: cadence,
    cycles,
    t0,
    first_buy: rnd() < 0.5 ? FIRST_BUY.REFERENCE : FIRST_BUY.NOW,
    mode: rnd() < 0.7 ? "soft" : "rigid",
    threshold_bps: pick([1000, 2500, 4000]),
    stable_leg: stableLeg,
    band_bps: stableLeg === null ? null : pick([100, 300]),
    band_ack_at: null,
    status: "active",
  }
  for (const i of LEGS) {
    basket[`leg${i}_token_out`] = `0x${String(i + 1).repeat(40)}`
    basket[`leg${i}_weight_num`] = weights[i][0]
    basket[`leg${i}_weight_den`] = weights[i][1]
    basket[`leg${i}_n`] = n[i]
    basket[`leg${i}_order_hash`] = `0x${`0${i + 10}`.slice(-2).repeat(32)}`
  }
  const times = specTimes(basket)
  const signedExpiry = t0 + (cycles + (basket.first_buy === FIRST_BUY.NOW ? 3 : 4)) * cadence + 3_600
  const orders = LEGS.map((i) => ({
    id: `order-${seed}-${i}`,
    basket_id: basket.id,
    order_type: "dca",
    status: "active",
    chain_id: CHAIN,
    wallet: basket.wallet,
    token_in: basket.token_in,
    token_out: basket[`leg${i}_token_out`],
    dca_total: n[i],
    dca_executed: 0,
    order_hash: basket[`leg${i}_order_hash`],
    order_data: {
      owner: basket.wallet,
      tokenIn: basket.token_in,
      tokenOut: basket[`leg${i}_token_out`],
      dcaTotal: String(n[i]),
      // Now and then a signed expiry inside the basket's life, so that it comes while the basket runs.
      expiry: String(rnd() < 0.12 ? int(t0, times.end) : signedExpiry),
    },
  }))
  // A random walk per leg, one price per tick (index 0 = before the first tick); a stable leg stays near 1.
  const prices = []
  const level = LEGS.map((i) => (i === stableLeg ? 1 : 10 + rnd() * 1000))
  for (let k = 0; k <= times.lastTick + 2; k += 1) {
    prices.push(
      LEGS.map((i) => {
        level[i] = i === stableLeg ? 1 + (rnd() - 0.5) * 0.04 : level[i] * (1 + (rnd() - 0.5) * 0.3)
        return rnd() < 0.08 ? null : level[i]
      }),
    )
  }
  // Polls: a few in every tick, many of them near the instants that matter (the tick time, + T / 2, the next tick).
  const T = cadence
  const offsets = [0, 1, 5, 60, T / 2 - 60, T / 2 - 1, T / 2, T / 2 + 1, T - 60, T - 1]
  const schedule = []
  for (const s of [-180, -60, -1, 0, 7, T / 2 - 1, T / 2]) if (rnd() < 0.4) schedule.push(t0 + s)
  for (let t = 0; t <= times.lastTick + 1; t += 1) {
    const count = int(1, 5)
    for (let k = 0; k < count; k += 1) schedule.push(times.tickTime(t) + (rnd() < 0.8 ? pick(offsets) : Math.floor(rnd() * T)))
  }
  schedule.sort((a, b) => a - b)
  return { rnd, pick, int, basket, orders, times, prices, schedule }
}

/** One life of one basket: every poll, its result and what the four invariants found. */
async function live(seed) {
  const s = makeScenario(seed)
  const { rnd, pick, basket, orders, times } = s
  const store = [] // basket_ticks rows; the unique key is deliberately NOT enforced (I4)
  const violations = { I1: [], I2: [], I3: [], I4: [] }
  const reasons = {}
  let clock = s.schedule[0]
  let polls = 0
  let straddles = 0 // polls in which the clock passed a deadline while an injected call was pending
  let lastPicks = []

  for (const scheduled of s.schedule) {
    if (basket.status !== "active") break
    clock = Math.max(clock, scheduled)
    // Between polls: the outside world changes the leg orders.
    for (const i of LEGS) {
      const r = rnd()
      if (r < 0.03) orders[i].status = pick(OTHER_STATUSES)
      else if (r < 0.06) orders[i].status = "executing"
      else if (r < 0.4) orders[i].status = "active"
    }
    const foreign = rnd() < 0.08 ? pick(OTHER_CHAINS) : null
    const inFlight = rnd() < 0.1 ? lastPicks.map((p) => ({ orderId: p.orderId })) : []

    // The injected calls. Each may answer later than it was asked: the clock jumps forward while it is pending.
    const at = { calls: [], inserts: [] }
    const deadlines = []
    const pending = () => {
      if (rnd() < 0.3) {
        const before = clock
        clock += pick([1, 2, 30, 600, Math.floor(times.T / 4), times.T / 2, times.T]) * (rnd() < 0.5 ? 1 : rnd())
        clock = Math.ceil(clock)
        deadlines.push([before, clock])
      }
    }
    const db = {
      async readTicks(basketId) {
        at.calls.push("readTicks")
        const rows = through(store.filter((row) => row.basket_id === basketId)).reverse()
        pending()
        return rows
      },
      async insertTick(row) {
        at.calls.push("insertTick")
        at.inserts.push({ row: through(row), clock })
        const outcome = rnd()
        if (outcome < 0.08) {
          pending()
          throw new Error("write failed")
        }
        const stored = { id: `row-${store.length}`, ...through(row) }
        store.push(stored)
        pending()
        if (outcome < 0.16) throw new Error("the answer was lost; the row is stored")
        return through(stored)
      },
      async setBasketStatus(basketId, status) {
        at.calls.push("setBasketStatus")
        pending()
        if (basketId !== basket.id || basket.status !== "active") return false
        basket.status = status
        return true
      },
    }
    const resolvePrice = async (token, hint) => {
      at.calls.push("resolvePrice")
      const leg = LEGS.find((i) => basket[`leg${i}_token_out`] === token)
      const tick = times.tickAt(clock)
      const price = s.prices[tick === null ? 0 : Math.min(tick + 1, s.prices.length - 1)][leg]
      pending()
      if (price === null) return { price: null }
      return hint.stable ? { price, source: "prop", bandAdd: rnd() < 0.5 ? 0 : 0.003 } : { price, source: "prop" }
    }

    const input = { basket: through(basket), orders: through(orders), inFlight }
    const result = await coordinateBasket(input, { now: () => clock, db, resolvePrice, chainId: foreign ?? CHAIN })
    polls += 1
    reasons[result.reason ?? "picks"] = (reasons[result.reason ?? "picks"] ?? 0) + 1
    const after = clock // the coordinator's last reading: the clock moves only while an injected call is pending
    const where = `seed ${seed}, poll ${polls} (t0 + ${after - basket.t0} s, ${result.reason ?? "picks"})`
    if (deadlines.some(([from, to]) => crossesDeadline(times, from, to))) straddles += 1

    // I3: another chain's basket: nothing at all.
    if (foreign !== null) {
      if (at.calls.length > 0) violations.I3.push(`${where}: ${at.calls.join(", ")} for a basket of another chain`)
      if (result.picks.length > 0) violations.I3.push(`${where}: a pick for a basket of another chain`)
      if (result.reason !== R.CHAIN_MISMATCH) violations.I3.push(`${where}: answered ${result.reason}`)
    }

    // I1: no pick for a leg that cannot execute, and none at all while any leg with chunks left cannot.
    const cannot = (i) =>
      orders[i].dca_executed < orders[i].dca_total &&
      (!EXECUTABLE.includes(orders[i].status) || after >= Number(orders[i].order_data.expiry))
    if (result.picks.length > 0 && LEGS.some(cannot)) violations.I1.push(`${where}: picks while leg ${LEGS.find(cannot)} cannot execute`)
    for (const p of result.picks) {
      const order = orders.find((o) => o.id === p.orderId)
      if (!order) violations.I1.push(`${where}: a pick for an order that is not a leg`)
      else if (!EXECUTABLE.includes(order.status)) violations.I1.push(`${where}: a pick for a '${order.status}' leg`)
      else if (after >= Number(order.order_data.expiry)) violations.I1.push(`${where}: a pick for a leg whose signed expiry has come`)
      else if (order.dca_executed >= order.dca_total) violations.I1.push(`${where}: a pick for a complete leg`)
    }

    // I2: rows only before their deadline, decided_at = the clock they were written at; picks only for the current
    // tick, from their slot time on, with their row in the journal.
    for (const { row, clock: written } of at.inserts) {
      if (written >= times.deadline(row.tick)) violations.I2.push(`${where}: tick ${row.tick} written ${written - times.deadline(row.tick)} s past its deadline`)
      if (row.tick !== REFERENCE_TICK && times.tickAt(written) !== row.tick) violations.I2.push(`${where}: tick ${row.tick} written during tick ${times.tickAt(written)}`)
      if (row.decided_at !== iso(written)) violations.I2.push(`${where}: tick ${row.tick} decided_at ${row.decided_at}, written at ${iso(written)}`)
    }
    for (const p of result.picks) {
      if (times.tickAt(after) !== p.tick || after >= times.end) violations.I2.push(`${where}: a pick of tick ${p.tick} returned during tick ${times.tickAt(after)}`)
      if (after < times.slotTime(p.tick, p.slot)) violations.I2.push(`${where}: slot ${p.slot} of tick ${p.tick} before its time`)
      if (!store.some((row) => row.tick === p.tick)) violations.I2.push(`${where}: a pick of tick ${p.tick} with no row`)
    }

    // I4: decide once, with no unique key to lean on.
    const perTick = new Map()
    for (const row of store) perTick.set(row.tick, (perTick.get(row.tick) ?? 0) + 1)
    for (const [tick, count] of perTick) if (count > 1) violations.I4.push(`${where}: ${count} rows for tick ${tick}`)

    // Never a rejection, and a reason exactly when there is no pick.
    if ((result.reason === null) !== (result.picks.length > 0)) violations.I2.push(`${where}: reason ${result.reason} with ${result.picks.length} picks`)

    // The outside world executes most of what it is handed.
    for (const p of result.picks) {
      const order = orders.find((o) => o.id === p.orderId)
      if (order && rnd() < 0.75 && order.dca_executed < order.dca_total) order.dca_executed += 1
    }
    lastPicks = result.picks
  }
  return { violations, reasons, polls, straddles }
}

/** Whether moving the clock from `from` to `to` passed the decision deadline of the tick `from` was in. */
function crossesDeadline(times, from, to) {
  const tick = times.tickAt(from)
  const deadline = times.deadline(tick === null ? REFERENCE_TICK : tick)
  return from < deadline && to >= deadline
}

describe(`property: ${SEEDS.length} seeded baskets (seeds ${SEEDS[0]} … ${SEEDS[SEEDS.length - 1]}), clocks that move inside the awaits`, () => {
  const total = { I1: [], I2: [], I3: [], I4: [], reasons: {}, polls: 0, straddles: 0 }

  before(async () => {
    for (const seed of SEEDS) {
      const run = await live(seed)
      for (const key of ["I1", "I2", "I3", "I4"]) total[key].push(...run.violations[key])
      for (const [reason, count] of Object.entries(run.reasons)) total.reasons[reason] = (total.reasons[reason] ?? 0) + count
      total.polls += run.polls
      total.straddles += run.straddles
    }
  })

  test("the runs reach every path the invariants are about (the property is not vacuous)", (t) => {
    const seen = (reason) => total.reasons[reason] ?? 0
    t.diagnostic(`polls ${total.polls}; a deadline passed during an injected call in ${total.straddles}; by reason ${JSON.stringify(total.reasons)}`)
    assert.ok(total.polls >= 10_000, `${total.polls} polls`)
    assert.ok(seen("picks") >= 1_000, `${seen("picks")} polls returned picks`)
    assert.ok(total.straddles >= 400, `${total.straddles} polls had a deadline pass during an injected call`)
    for (const reason of [R.TICK_MISSED, R.TICK_ENDED, R.LEG_NOT_EXECUTABLE, R.CHAIN_MISMATCH, R.REFERENCE_RECORDED, R.JOURNAL_WRITE_FAILED, R.IN_FLIGHT, R.SLOT_NOT_REACHED, R.BEFORE_FIRST_TICK]) {
      assert.ok(seen(reason) >= 10, `${reason}: ${seen(reason)} polls (${JSON.stringify(total.reasons)})`)
    }
    assert.ok(seen(R.COMPLETED) + seen(R.EXPIRED) >= SEEDS.length / 2, "most baskets reach their end")
  })

  test("I1: never a pick for a leg that cannot execute, and none at all while a leg with chunks left cannot (S-2)", () => {
    assert.deepEqual(total.I1.slice(0, 5), [], `${total.I1.length} violations`)
  })

  test("I2: never a row or a pick for a tick past its deadline; decided_at is the clock the row was written at (S-1)", () => {
    assert.deepEqual(total.I2.slice(0, 5), [], `${total.I2.length} violations`)
  })

  test("I3: nothing at all for a basket of another chain: no read, no write, no price, no pick (S-3)", () => {
    assert.deepEqual(total.I3.slice(0, 5), [], `${total.I3.length} violations`)
  })

  test("I4: at most one row per (basket, tick), on a store with no unique key (decide once)", () => {
    assert.deepEqual(total.I4.slice(0, 5), [], `${total.I4.length} violations`)
  })
})

test("the timeline the oracle spells out is the coordinator's", () => {
  for (const seed of SEEDS.slice(0, 40)) {
    const { basket, times } = makeScenario(seed)
    const tl = basketTimeline(basket)
    assert.equal(tl.end, times.end, `seed ${seed}`)
    assert.equal(tl.referenceDeadline ?? basket.t0 + basket.cadence_s / 2, times.deadline(REFERENCE_TICK))
    for (let t = 0; t <= times.lastTick; t += 1) {
      assert.equal(tl.decisionDeadline(t), times.deadline(t))
      assert.equal(tl.slotTime(t, 2), times.slotTime(t, 2))
    }
  }
})
