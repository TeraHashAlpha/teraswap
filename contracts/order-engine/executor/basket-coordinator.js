// basket-coordinator.js — Split DCA ("basket"): from one basket, its three order rows and the decision journal to
// "the picks that may execute NOW". SPEC-BASKET-DCA §4 "Coordinator rules" (binding) and "Rules for the wiring", §4a,
// §5, §6; ADR-027. Nothing imports it yet: executor.js is unchanged and the keeper behaves as before. The keeper
// wiring is a later goal (SPEC §10 item 3).
//
// Every I/O is injected: `now` (unix seconds), `db` (journal rows and the basket status) and `resolvePrice`. The
// module has no network, no clock and no state of its own: each call rebuilds everything from rows, exactly as the
// first call after a restart does. The selection itself is basket-scheduler.js `decideTick`; this module never
// recomputes what that returns, it stores it and reads it back.
//
// The Coordinator rules, and where each one lives:
//   Modes            basketTimeline: 'reference' ticks at t0 + (t + 1) × T, 'now' ticks at t0 + t × T, t = 0 … N + 2;
//                    the second slot at + T / 2. recordReference: at first sight before t0 + T / 2 the three prices
//                    are written as journal tick -1 (prices only, nothing bought); seen later, no reference row is
//                    ever written and the first tick runs with `last` null. 'now' mode never has a reference row.
//   State from rows  rebuildState: last = the latest row with a price for that leg (the reference row included),
//                    entry = the first TICK row with a price (never the reference row), cooldown = the stored
//                    next-cooldown of the previous tick's row (none if that tick has no row), done = the order rows.
//   Decide once      a (basket, tick) row that exists is read and never decided again: no price is resolved for it.
//   Write first      a decision is stored before any pick is returned, and the picks returned are read from the row
//                    AS STORED (what db.insertTick gave back); if the write fails, nothing executes.
//   Slots            a pick is executable from its slot time (slot 1 = the tick time, slot 2 = + T / 2) until the
//                    next tick's time. Per leg only its next outstanding slot is offered; a pick is outstanding while
//                    the order row has not executed it (done now against the done stored at the decision).
//   Missed tick      a tick is decided only from its time until its time + T / 2 (owner, 2026-11-16: the same half
//                    cycle the reference row gets). A tick that reaches + T / 2 with no row never gets one, whatever
//                    kept it from being decided (keeper down, no price read, a transaction in flight, a failed write).
//                    Only the CURRENT tick is ever decided. The next tick then finds no row for it: cooldown none,
//                    last and entry unchanged, which is a tick with no prices.
//   In flight        no decision while a transaction of this basket is in flight, and a leg in flight is not offered.
//   Journal          per leg the decision price as a double, its source, the stable leg's bandAdd, and the module's
//                    perLeg, picks and next exactly as returned.
//   Stable pair      the stable leg's price and bandAdd come together from resolvePrice (SPEC §4a) or not at all.
//   Fail closed      a missing or unreadable basket row, a leg order that does not match the basket, an unreadable
//                    journal, a price that cannot be read, an error thrown by the selection module, a failed write:
//                    nothing executes for this basket in this poll, and the result says why. It never falls back to
//                    the ordinary DCA path: the result of this function is the only thing that lets a leg execute.
//   Status           'completed' when every leg is complete; 'expired' once the last grace tick's window has ended.
//
// What this module does NOT decide: whether a returned pick's order can execute (router, floor, freeze flag, retry
// ladder, the contract's own dcaInterval): every existing gate of a DCA order still applies to a leg (SPEC §6).
//
// coordinateBasket never throws and never rejects: whatever goes wrong becomes { picks: [], reason, failClosed }.
// `detail` is built here from constants, indexes and field names only (never from an error message, which may
// carry an RPC URL), so it can go to a log line as it is.

import { GRACE_TICKS, decideTick } from "./basket-scheduler.js"

const LEG_INDEXES = [0, 1, 2]

/** The journal tick index of the reference row (prices recorded at first sight, no decision). */
export const REFERENCE_TICK = -1

/** `baskets.first_buy`. */
export const FIRST_BUY = Object.freeze({ REFERENCE: "reference", NOW: "now" })

/** `baskets.status`. The coordinator writes COMPLETED and EXPIRED; CANCELLED is the API's. */
export const BASKET_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
})

/** `result.reason`: why no pick is executable. Always set when `picks` is empty, null otherwise. */
export const COORDINATOR_REASONS = Object.freeze({
  // Fail closed: nothing executes for this basket in this poll.
  BASKET_MISSING: "basket_missing",
  BASKET_UNREADABLE: "basket_unreadable",
  ORDERS_MISMATCH: "orders_mismatch",
  IN_FLIGHT_UNREADABLE: "in_flight_unreadable",
  CLOCK_INVALID: "clock_invalid",
  JOURNAL_UNREADABLE: "journal_unreadable",
  CLOCK_BEHIND_JOURNAL: "clock_behind_journal",
  PRICE_ERROR: "price_error",
  DECIDE_ERROR: "decide_error",
  JOURNAL_WRITE_FAILED: "journal_write_failed",
  STATUS_WRITE_FAILED: "status_write_failed",
  INTERNAL_ERROR: "internal_error",
  // The basket is fine and there is nothing to execute right now.
  BASKET_NOT_ACTIVE: "basket_not_active",
  COMPLETED: "completed",
  EXPIRED: "expired",
  BEFORE_FIRST_TICK: "before_first_tick",
  REFERENCE_RECORDED: "reference_recorded",
  IN_FLIGHT: "in_flight",
  TICK_MISSED: "tick_missed",
  TICK_IDLE: "tick_idle",
  SLOT_NOT_REACHED: "slot_not_reached",
  PICKS_EXECUTED: "picks_executed",
})
const R = COORDINATOR_REASONS

/** The reasons that mean "something is wrong", as opposed to "nothing to do now". */
export const FAIL_CLOSED_REASONS = Object.freeze([
  R.BASKET_MISSING,
  R.BASKET_UNREADABLE,
  R.ORDERS_MISMATCH,
  R.IN_FLIGHT_UNREADABLE,
  R.CLOCK_INVALID,
  R.JOURNAL_UNREADABLE,
  R.CLOCK_BEHIND_JOURNAL,
  R.PRICE_ERROR,
  R.DECIDE_ERROR,
  R.JOURNAL_WRITE_FAILED,
  R.STATUS_WRITE_FAILED,
  R.INTERNAL_ERROR,
])

/** Unix SECONDS never get this large; a clock in milliseconds does (2001 in ms is already 1e12). */
const MAX_UNIX_SECONDS = 99_999_999_999
/** basket-scheduler.js refuses more cycles than this. */
const MAX_CYCLES = 10_000
const MAX_CADENCE_S = 100_000_000
const MAX_ID_LENGTH = 64

const ADDRESS = /^0x[0-9a-f]{40}$/
const ORDER_HASH = /^0x[0-9a-f]{64}$/
/** A price source label: short and from a closed alphabet with no "/", so a URL can never reach the journal. */
const SOURCE_LABEL = /^[a-z0-9][a-z0-9:+_.-]{0,63}$/
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const SCHEDULER_PREFIX = "basket-scheduler: "

// ------------------------------------------------------------------------------------------------ small helpers
/** Thrown inside this module only, to leave with a reason; coordinateBasket turns it into its result. */
class Refusal extends Error {
  constructor(reason, detail) {
    super(detail)
    this.reason = reason
    this.detail = detail
  }
}

function refuse(reason, detail) {
  throw new Refusal(reason, detail)
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x)
const isInt = (x, min, max) => typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max
const isPrice = (x) => typeof x === "number" && Number.isFinite(x) && x > 0
const isId = (x) => typeof x === "string" && x.length > 0 && x.length <= MAX_ID_LENGTH

/** A string that matches `pattern` once lowercased, lowercased; anything else is null. */
function lowered(x, pattern) {
  if (typeof x !== "string") return null
  const s = x.toLowerCase()
  return pattern.test(s) ? s : null
}

/** A non-negative integer given as a number, a decimal string or a bigint (order_data keeps uint256 as text). */
function uintOf(x) {
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : null
  if (typeof x === "bigint") return x >= 0n && x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : null
  if (typeof x === "string" && /^[0-9]{1,15}$/.test(x)) return Number(x)
  return null
}

/** The name of an error and nothing else: its message may hold an RPC URL or a key. */
function errorName(err) {
  return err !== null && typeof err === "object" && typeof err.name === "string" && ERROR_NAME.test(err.name)
    ? err.name
    : "Error"
}

// ------------------------------------------------------------------------------------------------ the timeline
/**
 * The times of one basket, from its row. All in unix seconds.
 *
 *   'reference'  tick t at t0 + (t + 1) × T: the reference is taken at t0 and the first purchase is one cycle later
 *   'now'        tick t at t0 + t × T: the first purchase is at creation
 *
 * t = 0 … N + 2 (N nominal ticks and GRACE_TICKS grace ticks). The second slot of a tick is at + T / 2. A tick is
 * current from its time until the next tick's time; the last grace tick's window ends at `end`, one T after its time.
 * A tick can be DECIDED only in the first half of that window: strictly before its time + T / 2 (`decisionDeadline`,
 * owner decision 2026-11-16), the moment its second slot opens. Its picks stay executable until the next tick's time.
 *
 * @param {{ t0: number, cadence_s: number, cycles: number, first_buy: "reference"|"now" }} basket
 * @returns {{ firstTick: number, lastTick: number, end: number, referenceDeadline: number|null,
 *   tickTime: (tick: number) => number, slotTime: (tick: number, slot: 1|2) => number,
 *   decisionDeadline: (tick: number) => number,
 *   tickAt: (now: number) => number|null }} `tickAt` is the current tick, null before the first tick; it does not
 *   stop at `end`. referenceDeadline is t0 + T / 2 in 'reference' mode, null in 'now' mode
 */
export function basketTimeline(basket) {
  if (!isObject(basket)) throw new TypeError("basket-coordinator: basketTimeline needs a basket row")
  const { t0, cadence_s: T, cycles: N, first_buy: firstBuy } = basket
  if (!isInt(t0, 1, MAX_UNIX_SECONDS)) throw new RangeError("basket-coordinator: t0 must be unix seconds")
  if (!isInt(T, 2, MAX_CADENCE_S) || T % 2 !== 0) throw new RangeError("basket-coordinator: cadence_s must be an even number of seconds")
  if (!isInt(N, 1, MAX_CYCLES)) throw new RangeError("basket-coordinator: cycles out of range")
  if (firstBuy !== FIRST_BUY.REFERENCE && firstBuy !== FIRST_BUY.NOW) throw new RangeError("basket-coordinator: first_buy must be 'reference' or 'now'")
  const firstTick = firstBuy === FIRST_BUY.REFERENCE ? t0 + T : t0
  const lastTick = N + GRACE_TICKS - 1
  const tickTime = (tick) => firstTick + tick * T
  return {
    firstTick,
    lastTick,
    end: tickTime(lastTick + 1),
    referenceDeadline: firstBuy === FIRST_BUY.REFERENCE ? t0 + T / 2 : null,
    tickTime,
    slotTime: (tick, slot) => tickTime(tick) + (slot - 1) * (T / 2),
    decisionDeadline: (tick) => tickTime(tick) + T / 2,
    tickAt: (now) => (now < firstTick ? null : Math.floor((now - firstTick) / T)),
  }
}

// ------------------------------------------------------------------------------------------------ reading rows
/**
 * The injected clock, in unix SECONDS. A value in milliseconds would put every basket past its end and expire it,
 * so anything that is not a plausible number of seconds is refused.
 */
function readClock(now) {
  let value
  try {
    value = now()
  } catch (err) {
    refuse(R.CLOCK_INVALID, `deps.now() failed (${errorName(err)})`)
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_UNIX_SECONDS) {
    refuse(R.CLOCK_INVALID, "deps.now() must return unix seconds")
  }
  return value
}

/** The basket row, checked field by field. Anything missing or out of range is "unreadable": decide nothing. */
function readBasket(row) {
  if (row === null || row === undefined) refuse(R.BASKET_MISSING, "no basket row")
  const bad = (what) => refuse(R.BASKET_UNREADABLE, `basket row: ${what}`)
  if (!isObject(row)) bad("not an object")
  if (!isId(row.id)) bad("id")
  const wallet = lowered(row.wallet, ADDRESS) ?? bad("wallet")
  if (!isInt(row.chain_id, 1, Number.MAX_SAFE_INTEGER)) bad("chain_id")
  const tokenIn = lowered(row.token_in, ADDRESS) ?? bad("token_in")
  if (!isInt(row.cadence_s, 2, MAX_CADENCE_S) || row.cadence_s % 2 !== 0) bad("cadence_s")
  if (!isInt(row.cycles, 1, MAX_CYCLES)) bad("cycles")
  if (!isInt(row.t0, 1, MAX_UNIX_SECONDS)) bad("t0")
  if (row.first_buy !== FIRST_BUY.REFERENCE && row.first_buy !== FIRST_BUY.NOW) bad("first_buy")
  if (row.mode !== "soft" && row.mode !== "rigid") bad("mode")
  // Above 0: at threshold 0 rule 9 pauses every leg at its first price.
  if (!isInt(row.threshold_bps, 1, 9999)) bad("threshold_bps")
  // An explicit null when there is no stable leg: a missing column must not silently switch the band off.
  if (row.stable_leg !== null && !isInt(row.stable_leg, 0, 2)) bad("stable_leg")
  if (row.stable_leg === null ? row.band_bps !== null : !isInt(row.band_bps, 1, 9999)) bad("band_bps")
  if (typeof row.status !== "string" || row.status.length === 0) bad("status")
  const legs = LEG_INDEXES.map((i) => {
    const tokenOut = lowered(row[`leg${i}_token_out`], ADDRESS) ?? bad(`leg${i}_token_out`)
    const n = row[`leg${i}_n`]
    if (!isInt(n, 1, MAX_CYCLES)) bad(`leg${i}_n`)
    const orderHash = lowered(row[`leg${i}_order_hash`], ORDER_HASH) ?? bad(`leg${i}_order_hash`)
    return { tokenOut, n, orderHash }
  })
  if (new Set(legs.map((leg) => leg.tokenOut)).size !== 3) bad("two legs with the same token")
  if (legs.some((leg) => leg.tokenOut === tokenIn)) bad("a leg buys the token sold")
  if (new Set(legs.map((leg) => leg.orderHash)).size !== 3) bad("two legs with the same order hash")
  return {
    id: row.id,
    wallet,
    chainId: row.chain_id,
    tokenIn,
    cadence: row.cadence_s,
    cycles: row.cycles,
    t0: row.t0,
    firstBuy: row.first_buy,
    mode: row.mode,
    // bps ÷ 10 000 is the double of the decimal (2500 → 0.25, 171 → 0.0171): the division is correctly rounded.
    threshold: row.threshold_bps / 10_000,
    stableLeg: row.stable_leg,
    band: row.band_bps === null ? null : row.band_bps / 10_000,
    status: row.status,
    legs,
    timeline: basketTimeline(row),
  }
}

/**
 * The three order rows, placed by leg through the order hash the basket holds, and matched against the basket:
 * the basket id, the type, the chain, the owner, the token sold, the leg's token and n. Both the row's columns and
 * the signed struct in `order_data` are checked, because the executor builds the transaction from `order_data`.
 * @returns {Array<{ id: string, done: number, status: string }>} by leg index
 */
function readOrders(basket, rows) {
  const bad = (what) => refuse(R.ORDERS_MISMATCH, what)
  if (!Array.isArray(rows) || rows.length !== 3) bad("expected exactly three order rows")
  const byHash = new Map()
  for (const row of rows) {
    if (!isObject(row)) bad("an order row is not an object")
    const hash = lowered(row.order_hash, ORDER_HASH) ?? bad("an order row has no usable order_hash")
    if (byHash.has(hash)) bad("two order rows with the same order_hash")
    byHash.set(hash, row)
  }
  const orders = basket.legs.map((leg, i) => {
    const row = byHash.get(leg.orderHash) ?? bad(`leg ${i}: no order row with the basket's order_hash`)
    const no = (field) => bad(`leg ${i}: ${field} does not match the basket`)
    if (!isId(row.id)) no("id")
    if (row.basket_id !== basket.id) no("basket_id")
    if (row.order_type !== "dca") no("order_type")
    if (row.chain_id !== basket.chainId) no("chain_id")
    if (lowered(row.wallet, ADDRESS) !== basket.wallet) no("wallet")
    if (lowered(row.token_in, ADDRESS) !== basket.tokenIn) no("token_in")
    if (lowered(row.token_out, ADDRESS) !== leg.tokenOut) no("token_out")
    if (row.dca_total !== leg.n) no("dca_total")
    if (!isInt(row.dca_executed, 0, leg.n)) no("dca_executed")
    if (typeof row.status !== "string" || row.status.length === 0) no("status")
    const signed = row.order_data
    if (!isObject(signed)) no("order_data")
    if (lowered(signed.owner, ADDRESS) !== basket.wallet) no("order_data.owner")
    if (lowered(signed.tokenIn, ADDRESS) !== basket.tokenIn) no("order_data.tokenIn")
    if (lowered(signed.tokenOut, ADDRESS) !== leg.tokenOut) no("order_data.tokenOut")
    if (uintOf(signed.dcaTotal) !== leg.n) no("order_data.dcaTotal")
    return { id: row.id, done: row.dca_executed, status: row.status }
  })
  if (new Set(orders.map((order) => order.id)).size !== 3) bad("two order rows with the same id")
  return orders
}

/**
 * Which legs have a transaction in flight: the caller's list (required, possibly empty: a missing list is not "none")
 * and any leg whose order row is locked ('executing').
 * @returns {Set<number>} leg indexes
 */
function readInFlight(inFlight, orders) {
  const bad = (what) => refuse(R.IN_FLIGHT_UNREADABLE, what)
  if (!Array.isArray(inFlight)) bad("inFlight must be an array (empty when nothing is in flight)")
  const legs = new Set()
  for (const entry of inFlight) {
    if (!isObject(entry) || !isId(entry.orderId)) bad("an inFlight entry has no orderId")
    const leg = orders.findIndex((order) => order.id === entry.orderId)
    if (leg < 0) bad("an inFlight entry names an order that is not a leg of this basket")
    legs.add(leg)
  }
  orders.forEach((order, leg) => {
    if (order.status === "executing") legs.add(leg)
  })
  return legs
}

/** One journal row as the database returned it. `reason` is what to refuse with when it does not hold together. */
function readTickRow(raw, basket, reason) {
  const bad = (what) => refuse(reason, `journal row: ${what}`)
  if (!isObject(raw)) bad("not an object")
  if (raw.basket_id !== basket.id) bad("basket_id is another basket's")
  const tick = raw.tick
  if (!isInt(tick, REFERENCE_TICK, basket.timeline.lastTick)) bad("tick out of range")
  const at = `tick ${tick}`
  const prices = LEG_INDEXES.map((i) => {
    const price = raw[`leg${i}_price`]
    if (price !== null && !isPrice(price)) bad(`${at}: leg${i}_price is not a positive finite number or null`)
    return price
  })
  if (tick === REFERENCE_TICK) {
    if (basket.firstBuy !== FIRST_BUY.REFERENCE) bad("a reference row in 'now' mode")
    if (raw.picks !== null || raw.next_state !== null) bad("the reference row carries a decision")
    return { tick, prices, picks: [], cooldown: null, doneAtDecision: null, idleReason: null }
  }
  if (!Array.isArray(raw.picks)) bad(`${at}: picks is not an array`)
  const slots = [0, 0, 0]
  const picks = raw.picks.map((pick) => {
    if (!isObject(pick) || !isInt(pick.leg, 0, 2)) bad(`${at}: a pick has no leg`)
    if (pick.kind !== "select" && pick.kind !== "catchup") bad(`${at}: a pick has no kind`)
    slots[pick.leg] += 1
    // slot = the leg's first or second chunk of the tick, in decision order.
    if (pick.slot !== slots[pick.leg] || pick.slot > 2) bad(`${at}: a pick's slot is not the leg's 1st or 2nd`)
    return { leg: pick.leg, kind: pick.kind, slot: pick.slot }
  })
  const next = raw.next_state
  if (!isObject(next) || !Array.isArray(next.legs) || next.legs.length !== 3) bad(`${at}: next_state has no three legs`)
  if (next.cooldown !== null && !isInt(next.cooldown, 0, 2)) bad(`${at}: next_state.cooldown`)
  const doneAtDecision = LEG_INDEXES.map((i) => {
    const leg = next.legs[i]
    if (!isObject(leg) || !isInt(leg.done, 0, basket.legs[i].n)) bad(`${at}: next_state.legs[${i}].done`)
    return leg.done
  })
  // The module's own invariants: the cooldown is the first picked leg, and an idle reason exactly when nothing was.
  if (next.cooldown !== (picks.length > 0 ? picks[0].leg : null)) bad(`${at}: next_state.cooldown is not the first pick`)
  const idleReason = raw.idle_reason
  if (picks.length > 0 ? idleReason !== null : typeof idleReason !== "string" || idleReason.length === 0) {
    bad(`${at}: idle_reason does not agree with picks`)
  }
  return { tick, prices, picks, cooldown: next.cooldown, doneAtDecision, idleReason }
}

/** Every journal row of the basket, by tick. A failed read, a malformed row or a tick twice: decide nothing. */
async function readJournal(basket, db) {
  let raw
  try {
    raw = await db.readTicks(basket.id)
  } catch (err) {
    refuse(R.JOURNAL_UNREADABLE, `db.readTicks failed (${errorName(err)})`)
  }
  if (!Array.isArray(raw)) refuse(R.JOURNAL_UNREADABLE, "db.readTicks did not return an array")
  const rows = new Map()
  for (const item of raw) {
    const row = readTickRow(item, basket, R.JOURNAL_UNREADABLE)
    if (rows.has(row.tick)) refuse(R.JOURNAL_UNREADABLE, `journal: two rows for tick ${row.tick}`)
    rows.set(row.tick, row)
  }
  return rows
}

// ------------------------------------------------------------------------------------------------ prices
/**
 * The decision price of each leg, with its source, and the stable leg's bandAdd. A leg with no usable price is
 * { price: null }; that is a normal answer ("no price", the leg is out of this tick). A resolver that throws, or
 * returns anything else, is not: nothing is decided in this poll.
 */
async function resolvePrices(basket, resolvePrice) {
  const bad = (what) => refuse(R.PRICE_ERROR, what)
  let answers
  try {
    answers = await Promise.all(
      basket.legs.map(async (leg, i) => resolvePrice(leg.tokenOut, { stable: i === basket.stableLeg })),
    )
  } catch (err) {
    bad(`resolvePrice failed (${errorName(err)})`)
  }
  const prices = []
  const sources = []
  let bandAdd = null
  answers.forEach((answer, i) => {
    if (answer === null || (isObject(answer) && answer.price === null)) {
      prices[i] = null
      sources[i] = null
      return
    }
    if (!isObject(answer) || !isPrice(answer.price)) bad(`leg ${i}: resolvePrice returned no positive finite price and no null`)
    if (typeof answer.source !== "string" || !SOURCE_LABEL.test(answer.source)) bad(`leg ${i}: the price has no usable source label`)
    if (i === basket.stableLeg) {
      // SPEC §4a: the stable leg's price and bandAdd are one answer. A price alone cannot be checked against the band.
      if (typeof answer.bandAdd !== "number" || !Number.isFinite(answer.bandAdd) || answer.bandAdd < 0) {
        bad(`leg ${i}: the stable leg's price came without its bandAdd`)
      }
      bandAdd = answer.bandAdd
    }
    prices[i] = answer.price
    sources[i] = answer.source
  })
  return { prices, sources, bandAdd }
}

function journalRow(basket, tick, now, { prices, sources, bandAdd }, decision) {
  return {
    basket_id: basket.id,
    tick,
    decided_at: new Date(now * 1000).toISOString(),
    leg0_price: prices[0],
    leg0_price_source: sources[0],
    leg1_price: prices[1],
    leg1_price_source: sources[1],
    leg2_price: prices[2],
    leg2_price_source: sources[2],
    band_add: bandAdd,
    per_leg: decision === null ? null : decision.perLeg,
    picks: decision === null ? null : decision.picks,
    next_state: decision === null ? null : decision.next,
    idle_reason: decision === null ? null : decision.idleReason,
  }
}

/** Store one journal row and return it as the database holds it. A write that is not confirmed is a failure. */
async function writeTick(basket, row, db) {
  let stored
  try {
    stored = await db.insertTick(row)
  } catch (err) {
    refuse(R.JOURNAL_WRITE_FAILED, `db.insertTick failed for tick ${row.tick} (${errorName(err)})`)
  }
  const parsed = readTickRow(stored, basket, R.JOURNAL_WRITE_FAILED)
  if (parsed.tick !== row.tick) refuse(R.JOURNAL_WRITE_FAILED, `db.insertTick returned tick ${parsed.tick} for tick ${row.tick}`)
  return { stored, parsed }
}

// ------------------------------------------------------------------------------------------------ the decision
/**
 * The selection module's state at `tick`, from the journal rows before it and the order rows:
 *   last      the latest row with a price for that leg, the reference row included
 *   entry     the first TICK row with a price for that leg; the reference row never counts
 *   cooldown  the stored next-cooldown of tick - 1; none when that tick has no row (it was missed) or is the reference
 *   done      the order row's executed count
 */
function rebuildState(basket, rows, orders, tick) {
  const before = [...rows.values()].filter((row) => row.tick < tick).sort((a, b) => a.tick - b.tick)
  const legs = LEG_INDEXES.map((i) => {
    let last = null
    let entry = null
    for (const row of before) {
      const price = row.prices[i]
      if (price === null) continue
      last = price
      if (entry === null && row.tick !== REFERENCE_TICK) entry = price
    }
    return { n: basket.legs[i].n, done: orders[i].done, last, entry }
  })
  const previous = tick > 0 ? rows.get(tick - 1) : undefined
  return { legs, cooldown: previous === undefined ? null : previous.cooldown }
}

/** Decide `tick` (it has no row), store the decision and return the row as stored. */
async function decideAndStore(basket, rows, orders, tick, now, deps, wrote) {
  const state = rebuildState(basket, rows, orders, tick)
  const resolved = await resolvePrices(basket, deps.resolvePrice)
  let decision
  try {
    decision = decideTick({
      params: { cycles: basket.cycles, mode: basket.mode, threshold: basket.threshold, stableLeg: basket.stableLeg, band: basket.band },
      tick,
      legs: state.legs,
      cooldown: state.cooldown,
      prices: resolved.prices,
      // The module wants a number whenever there is a stable leg; with no stable price there is nothing to add.
      bandAdd: basket.stableLeg === null ? undefined : (resolved.bandAdd ?? 0),
    })
  } catch (err) {
    // The module's own messages are built from field names and numbers; anything else gives only its name.
    const message = err instanceof Error && typeof err.message === "string" && err.message.startsWith(SCHEDULER_PREFIX)
      ? err.message.slice(SCHEDULER_PREFIX.length)
      : errorName(err)
    refuse(R.DECIDE_ERROR, `the selection module refused tick ${tick}: ${message}`)
  }
  const { stored, parsed } = await writeTick(basket, journalRow(basket, tick, now, resolved, decision), deps.db)
  wrote.push({ table: "basket_ticks", row: stored })
  return parsed
}

/**
 * The picks of the current tick's row that may execute now. Per leg, the chunks executed since the decision (the
 * order row's done against the done stored in the row) have used up its first slots; the next one is offered once
 * its slot time has come, unless the leg has a transaction in flight.
 */
function executablePicks(basket, row, orders, inFlight, now) {
  // An executed count never goes down. If an order row shows fewer chunks than the journal saw when it decided this
  // tick, the order rows cannot be trusted to say which picks have executed: offer nothing.
  for (const i of LEG_INDEXES) {
    if (orders[i].done < row.doneAtDecision[i]) {
      refuse(R.ORDERS_MISMATCH, `leg ${i}: dca_executed is lower than when tick ${row.tick} was decided`)
    }
  }
  const picks = []
  const offered = new Set()
  let waitingForFlight = false
  let waitingForSlot = false
  for (const pick of row.picks) {
    const executedSince = orders[pick.leg].done - row.doneAtDecision[pick.leg]
    if (pick.slot <= executedSince || offered.has(pick.leg)) continue
    offered.add(pick.leg) // only the leg's next outstanding slot, whatever happens to it below
    if (inFlight.has(pick.leg)) {
      waitingForFlight = true
    } else if (now < basket.timeline.slotTime(row.tick, pick.slot)) {
      waitingForSlot = true
    } else {
      picks.push({ orderId: orders[pick.leg].id, leg: pick.leg, tick: row.tick, slot: pick.slot, kind: pick.kind })
    }
  }
  if (picks.length > 0) return { picks, reason: null, detail: null }
  if (row.picks.length === 0) return { picks, reason: R.TICK_IDLE, detail: `tick ${row.tick} picked nothing: ${row.idleReason}` }
  if (waitingForFlight) return { picks, reason: R.IN_FLIGHT, detail: `tick ${row.tick}: a picked leg has a transaction in flight` }
  if (waitingForSlot) return { picks, reason: R.SLOT_NOT_REACHED, detail: `tick ${row.tick}: the second slot is at + T / 2` }
  return { picks, reason: R.PICKS_EXECUTED, detail: `tick ${row.tick}: every pick has executed` }
}

async function writeStatus(basket, status, db, wrote) {
  let confirmed
  try {
    confirmed = await db.setBasketStatus(basket.id, status)
  } catch (err) {
    refuse(R.STATUS_WRITE_FAILED, `db.setBasketStatus(${status}) failed (${errorName(err)})`)
  }
  if (confirmed !== true) refuse(R.STATUS_WRITE_FAILED, `db.setBasketStatus(${status}) was not confirmed`)
  wrote.push({ table: "baskets", row: { id: basket.id, status } })
}

/**
 * One poll of one basket.
 *
 * @param {object} input
 * @param {object|null} input.basket the `baskets` row (null when it could not be found)
 * @param {object[]} input.orders its three `orders` rows, in any order, WHATEVER their status: a completed leg's row
 *   is needed too, because `done` is read from it. Fetch them by the basket's three order hashes, not by basket_id
 * @param {Array<{ orderId: string }>} input.inFlight the picks (or just their order ids) whose transaction was sent
 *   and whose outcome is not yet in the order row. Required; [] when there is none. A leg whose order row is
 *   'executing' counts as in flight as well
 * @param {object} deps
 * @param {() => number} deps.now unix SECONDS
 * @param {object} deps.db
 * @param {(basketId: string) => Promise<object[]>} deps.db.readTicks EVERY `basket_ticks` row of the basket; rejects
 *   when the read failed (an empty array means "no row yet")
 * @param {(row: object) => Promise<object>} deps.db.insertTick stores one row and resolves with the row AS STORED,
 *   only once the database has confirmed it; rejects otherwise, a duplicate (basket_id, tick) included
 * @param {(basketId: string, status: "completed"|"expired") => Promise<boolean>} deps.db.setBasketStatus resolves
 *   `true` once stored (it should only move an 'active' basket); anything else is a failure
 * @param {(token: string, hint: { stable: boolean }) => Promise<null | { price: number|null, source?: string, bandAdd?: number }>} deps.resolvePrice
 *   the decision price of one leg token (lowercase address). null or { price: null } = no usable price. Otherwise a
 *   positive finite price and a short source label. For the stable leg (`hint.stable`) the price comes PAIRED with
 *   bandAdd (SPEC §4a): its own USD feed while within its maxStaleness, with bandAdd = the feed's deviation
 *   threshold; otherwise the quorum price, with bandAdd = 0
 * @returns {Promise<{
 *   basketId: string|null,
 *   tick: number|null,
 *   picks: Array<{ orderId: string, leg: number, tick: number, slot: 1|2, kind: "select"|"catchup" }>,
 *   wrote: Array<{ table: "basket_ticks"|"baskets", row: object }>,
 *   reason: string|null,
 *   detail: string|null,
 *   failClosed: boolean,
 * }>} picks = what may execute now, in decision order; wrote = the rows this call stored; reason (one of
 *   COORDINATOR_REASONS) whenever picks is empty; failClosed = that reason is one of FAIL_CLOSED_REASONS
 */
export async function coordinateBasket(input, deps) {
  const wrote = []
  let basketId = null
  let tick = null
  const result = (picks, reason, detail) => ({
    basketId,
    tick,
    picks,
    wrote,
    reason,
    detail,
    failClosed: FAIL_CLOSED_REASONS.includes(reason),
  })
  try {
    if (!isObject(input)) refuse(R.INTERNAL_ERROR, "coordinateBasket needs { basket, orders, inFlight }")
    if (!isObject(deps) || typeof deps.now !== "function" || typeof deps.resolvePrice !== "function") {
      refuse(R.INTERNAL_ERROR, "coordinateBasket needs deps.now and deps.resolvePrice")
    }
    const { db } = deps
    if (!isObject(db) || typeof db.readTicks !== "function" || typeof db.insertTick !== "function" || typeof db.setBasketStatus !== "function") {
      refuse(R.INTERNAL_ERROR, "coordinateBasket needs deps.db.readTicks, insertTick and setBasketStatus")
    }

    const basket = readBasket(input.basket)
    basketId = basket.id
    if (basket.status !== BASKET_STATUS.ACTIVE) {
      // Only a status this module knows is echoed; any other string from the row stays out of the log line.
      const known = Object.values(BASKET_STATUS).includes(basket.status)
      return result([], R.BASKET_NOT_ACTIVE, `the basket is ${known ? basket.status : "in a status this keeper does not know"}`)
    }
    const orders = readOrders(basket, input.orders)
    const inFlight = readInFlight(input.inFlight, orders)
    const now = readClock(deps.now)
    const { timeline } = basket

    // Status. Complete comes first: a basket that finished is completed even when it is looked at after its end.
    if (LEG_INDEXES.every((i) => orders[i].done >= basket.legs[i].n)) {
      await writeStatus(basket, BASKET_STATUS.COMPLETED, db, wrote)
      return result([], R.COMPLETED, "every leg is complete")
    }
    if (now >= timeline.end) {
      // A transaction still in flight may complete the basket: wait for its outcome before closing.
      if (inFlight.size > 0) return result([], R.IN_FLIGHT, "past the last grace tick, waiting for a transaction in flight")
      await writeStatus(basket, BASKET_STATUS.EXPIRED, db, wrote)
      return result([], R.EXPIRED, "the last grace tick's window has ended")
    }

    const rows = await readJournal(basket, db)
    tick = timeline.tickAt(now)
    // A row for a tick that has not come yet: this clock is behind the one that wrote it. Decide nothing.
    const newest = Math.max(REFERENCE_TICK, ...rows.keys())
    if (newest > (tick ?? REFERENCE_TICK)) {
      refuse(R.CLOCK_BEHIND_JOURNAL, `the journal has tick ${newest}, the clock says ${tick === null ? "before the first tick" : `tick ${tick}`}`)
    }

    if (tick === null) {
      // Before the first tick. 'reference' mode: at first sight, and only before t0 + T / 2, record the prices.
      const { referenceDeadline } = timeline
      if (referenceDeadline === null || rows.has(REFERENCE_TICK) || now >= referenceDeadline) {
        return result([], R.BEFORE_FIRST_TICK, "the first tick has not come")
      }
      const resolved = await resolvePrices(basket, deps.resolvePrice)
      const { stored } = await writeTick(basket, journalRow(basket, REFERENCE_TICK, now, resolved, null), db)
      wrote.push({ table: "basket_ticks", row: stored })
      return result([], R.REFERENCE_RECORDED, "the reference prices are recorded; the first purchase is one cycle after t0")
    }

    // The current tick. Its row is read if it exists and never decided again. With no row it is decided now, but
    // only before its time + T / 2: later it is a missed tick and never gets a row (never decided late). Only the
    // current tick is ever decided, so a tick of an earlier cycle stays as it is too.
    let row = rows.get(tick)
    if (row === undefined) {
      if (now >= timeline.decisionDeadline(tick)) {
        return result([], R.TICK_MISSED, `tick ${tick} was not decided before its time + T / 2: it is missed, the next tick catches up`)
      }
      if (inFlight.size > 0) return result([], R.IN_FLIGHT, `no decision for tick ${tick} while a transaction is in flight`)
      row = await decideAndStore(basket, rows, orders, tick, now, deps, wrote)
    }
    const { picks, reason, detail } = executablePicks(basket, row, orders, inFlight, now)
    return result(picks, reason, detail)
  } catch (err) {
    if (err instanceof Refusal) return result([], err.reason, err.detail)
    return result([], R.INTERNAL_ERROR, `unexpected ${errorName(err)}`)
  }
}
