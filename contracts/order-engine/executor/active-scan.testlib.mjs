// Shared helpers for the active-scan tests (not a test file itself): run one SHIPPED cycle against the
// fixture's fake PostgREST and fake chain, and check the screening bound. Used by active-scan-probes.test.mjs,
// active-scan-cycle.test.mjs, active-scan-property.test.mjs and the hand-run active-scan.differential.mjs.

import assert from "node:assert/strict"

import { loadShippedExecutor, withFakes } from "./executor-cycle.fixture.mjs"

export const CYCLE_MS = 30_000 // POLL_INTERVAL_MS
export const T0 = Date.now()

/** A shipped keeper process. `runOneCycleAtATime` is exported when executor.js has it (absent on older heads). */
export function loadKeeper(opts = {}) {
  return loadShippedExecutor({
    exportNames: ["executeCycle", "fetchActiveOrders", "orderInfraMisses", "stats"],
    optionalExports: ["runOneCycleAtATime"],
    ...opts,
  })
}

/**
 * One shipped cycle at fake time startMs + c * CYCLE_MS. Returns what happened in it: every canExecute ask
 * (`asked`, by either route), the pre-screen's (`screened`) and the path's (`path`) asks, the fills, the
 * requests, the captured lines and the cycle's `Active scan:` line.
 */
export async function runCycle(k, db, chain, c, { random = null, startMs = T0 } = {}) {
  const before = {
    asked: chain.canExecuteCalls.length,
    screened: chain.screenCalls.length,
    path: chain.pathCalls.length,
    executed: chain.executions.length,
    requests: db.requests.length,
  }
  const out = await withFakes(db, () => k.executeCycle(chain.publicClient, chain.walletClient, null, null, null, null), {
    nowMs: startMs + c * CYCLE_MS,
    random,
  })
  return {
    asked: chain.canExecuteCalls.slice(before.asked),
    screened: chain.screenCalls.slice(before.screened),
    path: chain.pathCalls.slice(before.path),
    executed: chain.executions.slice(before.executed),
    requests: db.requests.slice(before.requests),
    lines: out.lines,
    result: out.result,
    scanLine: out.lines.find((l) => l.includes("Active scan:")) ?? null,
  }
}

/** Resolve `p`, or fail after `ms` naming `what` (a cycle that hangs is a failure, not a stuck test). */
export async function settles(p, ms, what) {
  let timer
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms (hung)`)), ms)
  })
  try {
    return await Promise.race([p, limit])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cycles 0..n-1 that fail at `rate`, evenly spread and centred (0.5 % of 200 ⇒ cycle 99; 10 % ⇒ 4, 14, 24, …):
 * c fails when floor((c+1)·rate + ½) > floor(c·rate + ½).
 */
export function evenSchedule(n, rate) {
  const out = new Set()
  for (let c = 0; c < n; c++) if (Math.floor((c + 1) * rate + 0.5 + 1e-9) > Math.floor(c * rate + 0.5 + 1e-9)) out.add(c)
  return out
}

/**
 * The design's bound (120b §7, restated in round 3 — active-window.js header): every active row that is not
 * quarantined is screened at least once every ceil(M / SCAN) cycles, plus one cycle per fallback cycle (a failed scan
 * query or wrap read), plus ceil(M / SCAN) cycles per cycle that left pre-screen rows unresolved (the scan no longer
 * holds its position, so such a row waits for the scan to come round). For every start cycle s, K(s) is the smallest
 * k with k >= ceil(M(s,k) / scan) * (1 + P(s,k)) + F(s,k) + E(s,k), where M(s,k) counts the distinct rows present in
 * cycles s..s+k-1, F(s,k) the fallback cycles, P(s,k) the unresolved-pre-screen cycles and E(s,k) the cycles in
 * `extraAt` among them; every row present throughout s..s+K-1 must be asked (by either route) in that window.
 * `extraAt` is for the attempted variant: a ready row is attempted by the path within the screen bound plus one cycle
 * per cycle whose loop stopped early (MAX_BATCH fills or a gas SKIP: the carry-over goes first the next cycle).
 *
 * @param {{ presentAt: Set<string>[], askedAt: Iterable<string>[], fallbackAt?: boolean[], passPenaltyAt?: boolean[], extraAt?: boolean[], scan: number, label: string, what?: string }} p
 * @returns {{ checked: number, worstK: number }}
 */
export function checkScreenBound({ presentAt, countAt = presentAt, askedAt, fallbackAt = [], passPenaltyAt = [], extraAt = [], scan, label, what = "asked canExecute" }) {
  // presentAt: the rows CHECKED; countAt (default the same): the rows the scan reads, which make M (round 3: the
  // quarantined rows are read by the scan, so they count in M, but they are not checked).
  const n = presentAt.length
  const born = new Map()
  const end = new Map()
  const counted = new Set()
  const newAt = new Array(n).fill(0)
  const asked = new Map()
  const fPrefix = [0]
  const pPrefix = [0]
  const ePrefix = [0]
  for (let t = 0; t < n; t++) {
    pPrefix.push(pPrefix[t] + (passPenaltyAt[t] ? 1 : 0))
    ePrefix.push(ePrefix[t] + (extraAt[t] ? 1 : 0))
    for (const id of countAt[t]) {
      if (counted.has(id)) continue
      counted.add(id)
      if (t > 0) newAt[t]++
    }
    for (const id of presentAt[t]) {
      if (!born.has(id)) born.set(id, t)
      else assert.ok(!end.has(id), `${label}: row ${id.slice(-6)} came back after leaving (the checker assumes it cannot)`)
    }
    if (t > 0) for (const id of presentAt[t - 1]) if (!presentAt[t].has(id) && !end.has(id)) end.set(id, t)
    for (const id of askedAt[t]) {
      if (!asked.has(id)) asked.set(id, [])
      const list = asked.get(id)
      if (list[list.length - 1] !== t) list.push(t)
    }
    fPrefix.push(fPrefix[t] + (fallbackAt[t] ? 1 : 0))
  }
  let checked = 0
  let worstK = 0
  for (let s = 0; s < n; s++) {
    let M = countAt[s].size
    let K = 0
    for (let k = 1; s + k - 1 < n; k++) {
      if (k > 1) M += newAt[s + k - 1]
      if (k >= Math.ceil(M / scan) * (1 + pPrefix[s + k] - pPrefix[s]) + (fPrefix[s + k] - fPrefix[s]) + (ePrefix[s + k] - ePrefix[s])) {
        K = k
        break
      }
    }
    if (!K) break
    worstK = Math.max(worstK, K)
    for (const id of presentAt[s]) {
      if ((end.get(id) ?? Infinity) < s + K) continue // not present throughout
      checked++
      const list = asked.get(id) ?? []
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid] < s) lo = mid + 1
        else hi = mid
      }
      const first = list[lo]
      assert.ok(
        first !== undefined && first < s + K,
        `${label}: row …${id.slice(-6)} present in cycles ${s}..${s + K - 1} (M=${M}, fallback cycles=${fPrefix[s + K] - fPrefix[s]}, unresolved-pre-screen cycles=${pPrefix[s + K] - pPrefix[s]}, extra=${ePrefix[s + K] - ePrefix[s]}, bound ${K}) was never ${what}; next at ${first ?? "never"}`,
      )
    }
  }
  return { checked, worstK }
}
