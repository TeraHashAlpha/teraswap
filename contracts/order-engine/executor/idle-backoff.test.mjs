// [PERF-KEEPER-IDLE-BACKOFF] Acceptance tests for the keeper's orders-driven idle backoff.
//
// Measured (Alchemy, August 2026): on a day with ZERO active orders the keeper still issued
// 5,760 eth_getBalance + 5,760 eth_getLogs + 2,880 eth_blockNumber + 2,880 eth_call — every 30s
// cycle did its full RPC work while fetchActiveOrders() returned 0 rows. Two levers live in
// idle-backoff.js (pure, exercised here through a model of the keeper loop that mirrors ONE block
// of executor.js each — the executor.js WIRING is pinned by source anchors below, the same
// technique as retry-cap-restart.test.mjs, since executor.js auto-runs main() on import):
//
//   Task 2 — cadence: a cycle that finds 0 orders puts the keeper in IDLE; the next RPC cycle (and
//            the event-watcher poll) runs after IDLE_POLL_INTERVAL_MS. The first cycle that finds
//            ≥1 order returns both to POLL_INTERVAL_MS. The Supabase probe (unlockStaleOrders +
//            fetchActiveOrders, exactly the DB calls every cycle makes today) stays at
//            POLL_INTERVAL_MS while idle, so a NEW order promotes the keeper within one poll —
//            RPC backs off, the DB read does not.
//   Task 3 — one balance read per idle cycle: beginCycleObservability reads the wallet balance at
//            cycle start and endCycleObservability read it AGAIN at cycle end even with 0 orders.
//            Nothing was sent in an idle cycle, so the NEXT cycle's start read IS this cycle's end
//            read: the idle cycle carries its context forward and the next start read closes its
//            window with the SAME math (max(0, start − end − ownGas), ownGas = 0). An active cycle
//            keeps its two reads, byte-for-byte. Detection of an idle-window outflow moves from
//            the end of that cycle (≈1–2s after its start read) to the next start read — at worst
//            IDLE_POLL_INTERVAL_MS (300s) later — and now also covers the gap BETWEEN cycles that
//            the two-read scheme never compared.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  createIdleCadence,
  unexplainedOutflowWei,
  createIdleBalanceCarry,
} from "./idle-backoff.js"

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

describe("constants", () => {
  test("POLL_INTERVAL_MS is the keeper's 30s; IDLE_POLL_INTERVAL_MS is 300s (the owner may lower it)", () => {
    assert.equal(POLL_INTERVAL_MS, 30_000)
    assert.equal(IDLE_POLL_INTERVAL_MS, 300_000)
    assert.ok(IDLE_POLL_INTERVAL_MS > POLL_INTERVAL_MS, "idle must back OFF, never poll faster than active")
  })
})

// ─── Task 2: cadence ──────────────────────────────────────────────────────────────────────────

/**
 * executor.js's main loop, reduced to the tick it runs every POLL_INTERVAL_MS (cited inline):
 *   cadence.tick() === "probe"  ⇒ DB-only probe; 0 rows ⇒ return (no RPC this tick)
 *   otherwise                    ⇒ executeCycle (the RPC cycle) then cadence.record(activeOrders)
 * `ordersAt(t)` is what Supabase holds at time t. Returns the times of the RPC cycles.
 */
function runLoop({ cadence, ordersAt, untilMs }) {
  const rpcCyclesAt = []
  const probesAt = []
  for (let t = 0; t <= untilMs; t += POLL_INTERVAL_MS) {
    if (cadence.tick() === "probe") {
      probesAt.push(t)
      if (ordersAt(t) === 0) continue
    }
    rpcCyclesAt.push(t)
    cadence.record(ordersAt(t))
  }
  return { rpcCyclesAt, probesAt }
}

const deltas = (times) => times.slice(1).map((t, i) => t - times[i])

describe("createIdleCadence — 0 orders ⇒ next RPC cycle at the idle interval; ≥1 order ⇒ 30s; both transitions", () => {
  test("boots ACTIVE: the first tick is a full RPC cycle, never a probe", () => {
    const cadence = createIdleCadence()
    assert.equal(cadence.isIdle(), false)
    assert.equal(cadence.tick(), "rpc")
  })

  test("with ≥1 active order every cycle the cadence is exactly today's: an RPC cycle every 30s, no probes", () => {
    const { rpcCyclesAt, probesAt } = runLoop({ cadence: createIdleCadence(), ordersAt: () => 1, untilMs: 600_000 })
    assert.equal(rpcCyclesAt.length, 21, "0s, 30s, …, 600s")
    assert.deepEqual(new Set(deltas(rpcCyclesAt)), new Set([POLL_INTERVAL_MS]))
    assert.deepEqual(probesAt, [])
  })

  test("0 orders ⇒ the next RPC cycle runs after IDLE_POLL_INTERVAL_MS; the DB probe keeps polling every 30s", () => {
    const { rpcCyclesAt, probesAt } = runLoop({ cadence: createIdleCadence(), ordersAt: () => 0, untilMs: 900_000 })
    assert.deepEqual(rpcCyclesAt, [0, 300_000, 600_000, 900_000])
    assert.deepEqual(new Set(deltas(rpcCyclesAt)), new Set([IDLE_POLL_INTERVAL_MS]))
    // Every other 30s tick was a DB-only probe.
    const everyTick = []
    for (let t = POLL_INTERVAL_MS; t <= 900_000; t += POLL_INTERVAL_MS) everyTick.push(t)
    assert.deepEqual(probesAt, everyTick.filter((t) => !rpcCyclesAt.includes(t)))
  })

  test("transition active → idle → active: 30s, then 300s, then a new order promotes at the next 30s probe, then 30s again", () => {
    // Orders: present until 100s; none until 700s (appears at 700s); none again from 1_000s.
    const ordersAt = (t) => (t <= 100_000 ? 1 : t < 700_000 ? 0 : t < 1_000_000 ? 1 : 0)
    const { rpcCyclesAt } = runLoop({ cadence: createIdleCadence(), ordersAt, untilMs: 1_500_000 })
    assert.deepEqual(rpcCyclesAt, [
      0, 30_000, 60_000, 90_000, // active: every 30s
      120_000, // finds 0 ⇒ idle
      420_000, // idle: +300s, still 0
      720_000, // the 30s probe at 720s finds the order that appeared at 700s ⇒ full cycle NOW (≤ 30s after creation)
      750_000, 780_000, 810_000, 840_000, 870_000, 900_000, 930_000, 960_000, 990_000, // active again: every 30s
      1_020_000, // finds 0 ⇒ idle
      1_320_000, // +300s
    ])
  })

  test("a new order is noticed within ONE poll interval of appearing, wherever in the idle window it lands", () => {
    for (const appearsAt of [305_000, 450_000, 599_000]) {
      const ordersAt = (t) => (t === 0 ? 0 : t >= appearsAt ? 1 : 0)
      const { rpcCyclesAt } = runLoop({ cadence: createIdleCadence(), ordersAt, untilMs: appearsAt + 60_000 })
      const promoted = rpcCyclesAt.find((t) => t >= appearsAt)
      assert.ok(promoted - appearsAt < POLL_INTERVAL_MS, `order at ${appearsAt} promoted at ${promoted}`)
    }
  })

  test("idle interval is expressed in whole 30s ticks (ceil): a non-multiple never polls FASTER than asked", () => {
    const cadence = createIdleCadence({ pollIntervalMs: 30_000, idlePollIntervalMs: 100_000 })
    cadence.record(0)
    const due = []
    for (let tick = 1; tick <= 12; tick += 1) {
      if (cadence.tick() === "rpc") {
        due.push(tick)
        cadence.record(0)
      }
    }
    assert.deepEqual(due, [4, 8, 12], "due every 4 ticks = 120s ≥ 100s, never at 3 ticks = 90s")
  })
})

// ─── Task 3: one balance read per idle cycle ──────────────────────────────────────────────────

const ETH = 10n ** 18n

describe("unexplainedOutflowWei — today's math, verbatim", () => {
  test("max(0, start − end − ownGas); a non-bigint ownGas counts as 0", () => {
    assert.equal(unexplainedOutflowWei(10n * ETH, 9n * ETH, 0n), 1n * ETH)
    assert.equal(unexplainedOutflowWei(10n * ETH, 9n * ETH, ETH / 2n), ETH / 2n, "own gas is subtracted")
    assert.equal(unexplainedOutflowWei(10n * ETH, 9n * ETH, 2n * ETH), 0n, "clamped at 0 — never negative")
    assert.equal(unexplainedOutflowWei(9n * ETH, 10n * ETH, 0n), 0n, "an inflow is 0, not negative")
    assert.equal(unexplainedOutflowWei(10n * ETH, 9n * ETH, undefined), 1n * ETH)
    assert.equal(unexplainedOutflowWei(10n * ETH, 9n * ETH, 5), 1n * ETH, "a Number is not a bigint ⇒ 0")
  })
})

/**
 * A wallet-balance timeline the fake RPC samples. Each cycle i has:
 *   ownGas         — what the keeper itself spent inside the cycle (0 when idle: nothing is sent)
 *   dropInside     — an UNEXPLAINED outflow between the cycle's start read and its end read
 *   dropBetween    — an unexplained outflow between this cycle's end read and the next start read
 * Reads happen at instants; the balance is a step function of those events.
 */
function timeline(cycles, startWei = 100n * ETH) {
  let balance = startWei
  const atStart = []
  const atEnd = []
  for (const c of cycles) {
    atStart.push(balance)
    balance -= (c.ownGas ?? 0n) + (c.dropInside ?? 0n)
    atEnd.push(balance)
    balance -= c.dropBetween ?? 0n
  }
  return { atStart, atEnd, final: balance }
}

/** The fake eth_getBalance: returns the balance at the instant of the read; counts reads per cycle. */
function fakeRpc({ failReadsAt = new Set() } = {}) {
  let reads = 0
  let cycleReads = 0
  let value = 0n
  return {
    set(v) {
      value = v
    },
    startCycle() {
      cycleReads = 0
    },
    cycleReads: () => cycleReads,
    totalReads: () => reads,
    async getBalance() {
      reads += 1
      cycleReads += 1
      if (failReadsAt.has(reads)) throw new Error("rpc down")
      return value
    },
  }
}

/**
 * TODAY (pre-change executor.js): begin = one getBalance; end = one getBalance + the check, every
 * cycle, idle or not. The oracle the new model is compared against.
 */
function todayModel(rpc) {
  const windows = []
  return {
    windows,
    async begin() {
      const ctx = { cycleStartBalanceWei: null }
      try {
        ctx.cycleStartBalanceWei = await rpc.getBalance()
      } catch {}
      return ctx
    },
    async end(ctx, ownGas) {
      if (!ctx || ctx.cycleStartBalanceWei === null) return
      try {
        const endWei = await rpc.getBalance()
        windows.push({ start: ctx.cycleStartBalanceWei, end: endWei, outflowWei: unexplainedOutflowWei(ctx.cycleStartBalanceWei, endWei, ownGas) })
      } catch {}
    },
  }
}

/**
 * AFTER: executor.js's beginCycleObservability / endCycleObservability reduced to the balance reads
 * and the outflow check — each block mirrors ONE block of executor.js (pinned by the source anchors
 * below):
 *   begin()  ONE getBalance; if an idle window is carried, close it with THIS read (ownGas = 0)
 *   end()    idle ⇒ hold the context, NO read; active ⇒ ONE getBalance + the check (today's path)
 */
function afterModel(rpc) {
  const carry = createIdleBalanceCarry()
  const windows = []
  const check = (ctx, endWei, ownGas) =>
    windows.push({ start: ctx.cycleStartBalanceWei, end: endWei, outflowWei: unexplainedOutflowWei(ctx.cycleStartBalanceWei, endWei, ownGas) })
  return {
    windows,
    carry,
    async begin() {
      const ctx = { cycleStartBalanceWei: null }
      try {
        ctx.cycleStartBalanceWei = await rpc.getBalance()
        const carried = carry.take()
        if (carried !== null) check(carried, ctx.cycleStartBalanceWei, 0n)
      } catch {}
      return ctx
    },
    async end(ctx, ownGas, { idle = false } = {}) {
      if (!ctx || ctx.cycleStartBalanceWei === null) return
      if (idle) {
        carry.hold(ctx)
        return
      }
      try {
        const endWei = await rpc.getBalance()
        check(ctx, endWei, ownGas)
      } catch {}
    },
  }
}

/** Drive a model through the cycles against the timeline; returns per-cycle read counts. */
async function run(model, rpc, cycles, tl) {
  const readsPerCycle = []
  for (let i = 0; i < cycles.length; i += 1) {
    rpc.startCycle()
    rpc.set(tl.atStart[i])
    const ctx = await model.begin()
    rpc.set(tl.atEnd[i])
    await model.end(ctx, cycles[i].ownGas ?? 0n, { idle: cycles[i].idle === true })
    readsPerCycle.push(rpc.cycleReads())
  }
  return readsPerCycle
}

describe("idle balance carry — one getBalance per idle cycle, two per active cycle, same outflow math", () => {
  // The premise: an idle cycle sends nothing, so nothing moves between its end read and the next
  // start read (dropBetween = 0). Under it the carried window is wei-for-wei today's window.
  const SEQUENCE = [
    { idle: false, ownGas: ETH / 100n, dropInside: 0n },
    { idle: true, dropInside: 0n },
    { idle: true, dropInside: 3n * ETH }, // an unexplained 3 ETH leaves during an idle cycle
    { idle: true, dropInside: 0n },
    { idle: false, ownGas: ETH / 50n, dropInside: ETH / 10n }, // 0.1 ETH unexplained during an active cycle
    { idle: true, dropInside: ETH / 1000n },
    { idle: false, ownGas: 0n, dropInside: 0n },
  ]

  test("with ≥1 active order EVERY cycle the reads and windows are byte-for-byte today's (two reads, same values)", async () => {
    const cycles = SEQUENCE.map((c) => ({ ...c, idle: false }))
    const tl = timeline(cycles)
    const rpcToday = fakeRpc()
    const rpcAfter = fakeRpc()
    const today = todayModel(rpcToday)
    const after = afterModel(rpcAfter)
    const readsToday = await run(today, rpcToday, cycles, tl)
    const readsAfter = await run(after, rpcAfter, cycles, tl)
    assert.deepEqual(readsAfter, readsToday)
    assert.deepEqual(new Set(readsAfter), new Set([2]), "two getBalance per active cycle")
    assert.deepEqual(after.windows, today.windows, "identical (start, end, outflow) per cycle")
    assert.equal(after.carry.take(), null, "nothing is ever carried while active")
  })

  test("idle cycle = ONE getBalance, active cycle = TWO", async () => {
    const tl = timeline(SEQUENCE)
    const rpc = fakeRpc()
    const reads = await run(afterModel(rpc), rpc, SEQUENCE, tl)
    assert.deepEqual(reads, SEQUENCE.map((c) => (c.idle ? 1 : 2)))
    assert.equal(rpc.totalReads(), 2 * 3 + 1 * 4, "6 active reads + 4 idle reads = 10, versus 14 today")
  })

  test("outflow over consecutive idle cycles equals today's value for the same balance sequence (every window, wei-for-wei)", async () => {
    const tl = timeline(SEQUENCE)
    const rpcToday = fakeRpc()
    const rpcAfter = fakeRpc()
    const today = todayModel(rpcToday)
    const after = afterModel(rpcAfter)
    await run(today, rpcToday, SEQUENCE, tl)
    await run(after, rpcAfter, SEQUENCE, tl)
    // The last cycle is active, so every idle window has been closed by a later start read.
    assert.deepEqual(
      after.windows.map((w) => w.outflowWei),
      today.windows.map((w) => w.outflowWei),
    )
    assert.deepEqual(after.windows, today.windows, "start and end balances match too — not just the result")
    assert.ok(today.windows.some((w) => w.outflowWei === 3n * ETH), "the 3 ETH idle-cycle outflow is in both")
    assert.ok(today.windows.some((w) => w.outflowWei === ETH / 10n), "the 0.1 ETH active-cycle outflow is in both")
  })

  test("the carried window closes at the next start read — one idle interval later than today's end read, never lost", async () => {
    const cycles = [{ idle: true, dropInside: 2n * ETH }, { idle: true }]
    const tl = timeline(cycles)
    const rpc = fakeRpc()
    const after = afterModel(rpc)
    rpc.startCycle()
    rpc.set(tl.atStart[0])
    const ctx0 = await after.begin()
    rpc.set(tl.atEnd[0])
    await after.end(ctx0, 0n, { idle: true })
    assert.deepEqual(after.windows, [], "today would have alerted here (end read); the check is deferred…")
    assert.equal(after.carry.pending(), true, "…and held")
    rpc.set(tl.atStart[1])
    await after.begin()
    assert.deepEqual(after.windows, [{ start: 100n * ETH, end: 98n * ETH, outflowWei: 2n * ETH }], "closed by the next start read, at most IDLE_POLL_INTERVAL_MS later")
    assert.equal(IDLE_POLL_INTERVAL_MS / 1000, 300, "i.e. ≤ 300 s")
  })

  test("an outflow BETWEEN cycles (after today's end read, before the next start) is missed today and caught after", async () => {
    const cycles = [{ idle: true, dropBetween: 5n * ETH }, { idle: true }, { idle: false }]
    const tl = timeline(cycles)
    const rpcToday = fakeRpc()
    const rpcAfter = fakeRpc()
    const today = todayModel(rpcToday)
    const after = afterModel(rpcAfter)
    await run(today, rpcToday, cycles, tl)
    await run(after, rpcAfter, cycles, tl)
    assert.equal(today.windows.reduce((s, w) => s + w.outflowWei, 0n), 0n, "today: 5 ETH gone, nothing compared it")
    assert.equal(after.windows.reduce((s, w) => s + w.outflowWei, 0n), 5n * ETH, "after: the carried window spans the gap")
  })

  test("a failed start read does not lose the carried window — the next successful read closes it", async () => {
    const cycles = [{ idle: true, dropInside: 1n * ETH }, { idle: true }, { idle: true }]
    const tl = timeline(cycles)
    const rpc = fakeRpc({ failReadsAt: new Set([2]) }) // cycle 2's start read throws
    const after = afterModel(rpc)
    const reads = await run(after, rpc, cycles, tl)
    assert.deepEqual(reads, [1, 1, 1])
    assert.deepEqual(after.windows, [{ start: 100n * ETH, end: 99n * ETH, outflowWei: 1n * ETH }], "closed at cycle 3's start read")
  })

  test("idle → active transition: the carried idle window is closed by the active cycle's start read; the active cycle's own two-read check is untouched", async () => {
    const cycles = [{ idle: true, dropInside: ETH }, { idle: false, ownGas: ETH / 100n, dropInside: ETH / 4n }]
    const tl = timeline(cycles)
    const rpc = fakeRpc()
    const after = afterModel(rpc)
    const reads = await run(after, rpc, cycles, tl)
    assert.deepEqual(reads, [1, 2])
    assert.deepEqual(after.windows, [
      { start: tl.atStart[0], end: tl.atStart[1], outflowWei: ETH }, // idle window, ownGas 0
      { start: tl.atStart[1], end: tl.atEnd[1], outflowWei: ETH / 4n }, // active window, own gas subtracted — today's
    ])
  })
})

describe("createIdleBalanceCarry", () => {
  test("take() returns and clears the held context; nothing held ⇒ null", () => {
    const carry = createIdleBalanceCarry()
    assert.equal(carry.pending(), false)
    assert.equal(carry.take(), null)
    const ctx = { cycleStartBalanceWei: 1n }
    carry.hold(ctx)
    assert.equal(carry.pending(), true)
    assert.equal(carry.take(), ctx)
    assert.equal(carry.pending(), false)
    assert.equal(carry.take(), null, "cleared once taken — a window is closed exactly once")
  })
})

// ─── Wiring — executor.js really drives the cadence and the watcher ───────────────────────────

describe("executor.js wiring (source anchors) — one balance read per idle cycle", () => {
  test("beginCycleObservability: ONE getBalance, then closes a carried idle window with that read (ownGas 0)", () => {
    const body = sliceBetween(executorSource(), "async function beginCycleObservability(", "\n  return ctx\n}")
    assert.equal(body.split("publicClient.getBalance(").length - 1, 1, "exactly one getBalance in begin")
    const readBlock = sliceBetween(body, "ctx.cycleStartBalanceWei = await publicClient.getBalance({ address: walletAddress })", "\n  } catch (err) {")
    assert.ok(readBlock.includes("const carried = idleBalanceCarry.take()"), "the carried window is taken only after a SUCCESSFUL read")
    assert.ok(readBlock.includes("await checkUnexplainedOutflow(carried, ctx.cycleStartBalanceWei, 0n)"), "and closed with this read, ownGas = 0")
  })

  test("endCycleObservability: idle ⇒ hold the context and return BEFORE any read; active ⇒ today's read + check", () => {
    const body = sliceBetween(executorSource(), "async function endCycleObservability(ctx, publicClient, ownGasSpentWei, { idle = false } = {}) {", "\n}\n")
    const idleBlock = sliceBetween(body, "if (idle) {", "\n  }")
    assert.ok(idleBlock.includes("idleBalanceCarry.hold(ctx)"))
    assert.ok(idleBlock.includes("return"))
    assert.equal(idleBlock.includes("getBalance"), false, "no read on the idle path")
    assert.ok(body.indexOf("if (idle) {") < body.indexOf("publicClient.getBalance("), "the idle branch precedes the read")
    assert.ok(body.includes("const endBalanceWei = await publicClient.getBalance({ address: ctx.walletAddress })"), "today's end read, unchanged")
    assert.ok(body.includes("await checkUnexplainedOutflow(ctx, endBalanceWei, ownGasSpentWei)"), "today's check, unchanged")
    // The early return for a failed start read is still first — a failed start read leaves the
    // PREVIOUS carried window in place (nothing to close it with yet).
    assert.ok(body.indexOf("if (!ctx || ctx.cycleStartBalanceWei === null) return") < body.indexOf("if (idle) {"))
  })

  test("checkUnexplainedOutflow uses the pinned math and today's threshold + alert", () => {
    const body = sliceBetween(executorSource(), "async function checkUnexplainedOutflow(ctx, endBalanceWei, ownGasSpentWei) {", "\n}\n")
    assert.ok(body.includes("const outflowWei = unexplainedOutflowWei(ctx.cycleStartBalanceWei, endBalanceWei, ownGasSpentWei)"))
    assert.ok(body.includes("const unexplainedOutflowEth = Number(formatEther(outflowWei))"))
    assert.ok(body.includes("if (unexplainedOutflowEth > OUTFLOW_THRESHOLD_ETH) {"))
    assert.ok(body.includes("const score = scoreFromContext({ ...ctx, unexplainedOutflowEth })"))
    assert.ok(body.includes("await alertUnexplainedOutflow("))
  })

  test("executeCycle: the 0-orders branch ends the cycle as IDLE; the active path's call is unchanged", () => {
    const body = sliceBetween(executorSource(), "async function executeCycle(", "\n// ---- Stats tracking")
    const noOrders = sliceBetween(body, "if (orders.length === 0) {", "\n  }")
    assert.ok(noOrders.includes("await endCycleObservability(obsCtx, publicClient, ownGasSpentWei, { idle: true })"))
    const activeTail = body.slice(body.indexOf("// Update stats"))
    assert.ok(activeTail.includes("await endCycleObservability(obsCtx, publicClient, ownGasSpentWei)\n"), "active: no idle flag — two reads as today")
    assert.equal(activeTail.includes("{ idle: true }"), false)
  })
})

// ─── Wiring — executor.js really drives the cadence and the watcher ───────────────────────────

describe("executor.js wiring (source anchors) — the loop backs RPC off, not the DB read", () => {
  test("the poll constants come from idle-backoff.js (single source of truth)", () => {
    const src = executorSource()
    for (const name of ["POLL_INTERVAL_MS", "IDLE_POLL_INTERVAL_MS", "createIdleCadence"]) {
      assert.ok(
        new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./idle-backoff\\.js"`).test(src),
        `${name} is imported from ./idle-backoff.js`,
      )
    }
    assert.equal(/^const POLL_INTERVAL_MS = /m.test(src), false, "no second definition of the poll interval")
  })

  test("executeCycle reports the number of active orders it found (0 on the no-orders branch)", () => {
    const body = sliceBetween(executorSource(), "async function executeCycle(", "\n// ---- Stats tracking")
    const noOrders = sliceBetween(body, "if (orders.length === 0) {", "\n  }")
    assert.ok(noOrders.includes("return 0"), "0 orders ⇒ returns 0")
    assert.ok(body.endsWith("  return orders.length\n}\n\n// ---- Stats tracking"), "the active path returns the count")
  })

  test("the tick: idle ⇒ DB-only probe (the same two Supabase calls as a cycle), 0 rows ⇒ no RPC; then the RPC cycle records the count and pushes the mode to the watcher", () => {
    const tick = sliceBetween(executorSource(), "async function runTick() {", "\n  }\n")
    const probe = sliceBetween(tick, 'if (cadence.tick() === "probe") {', "\n    }")
    assert.ok(probe.includes("await unlockStaleOrders()"), "probe unlocks stale rows, as every cycle does")
    assert.ok(probe.includes("await fetchActiveOrders()"), "probe reads active orders")
    assert.ok(probe.includes("length === 0) return"), "0 rows ⇒ return before ANY RPC")
    assert.equal(probe.includes("publicClient."), false, "the probe never touches the RPC")
    assert.equal(probe.includes("executeCycle("), false)
    assert.ok(tick.includes("const activeOrders = await executeCycle("), "the RPC cycle's count is captured")
    assert.ok(tick.includes("cadence.record(activeOrders)"), "and recorded")
    assert.ok(tick.includes("watcher.setIdle(cadence.isIdle())"), "and pushed to the event watcher")
  })

  test("the interval still fires every POLL_INTERVAL_MS (the probe cadence) and runs the tick, not executeCycle directly", () => {
    const main = sliceBetween(executorSource(), "async function main() {", "\n}\n")
    assert.ok(main.includes("const watcher = startEventWatcher(publicClient, watchedContracts, monitor)"))
    assert.ok(main.includes("const cadence = createIdleCadence()"))
    assert.ok(main.includes("await runTick()"), "boot runs the tick (ACTIVE ⇒ a full cycle)")
    const interval = sliceBetween(main, "setInterval(async () => {", "}, POLL_INTERVAL_MS)")
    assert.ok(interval.includes("await runTick()"))
    assert.equal(interval.includes("executeCycle("), false)
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function executorSource() {
  return readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
}

/** The first occurrence of `from` up to the next `to` after it — fails loudly if either is missing. */
function sliceBetween(src, from, to) {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `anchor not found in executor.js: ${JSON.stringify(from)}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b >= 0, `end anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
  return src.slice(a, b + to.length)
}
