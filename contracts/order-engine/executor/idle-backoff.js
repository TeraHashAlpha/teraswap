/**
 * [PERF-KEEPER-IDLE-BACKOFF] Orders-driven idle backoff for the keeper's RPC work (pure; unit-tested
 * in idle-backoff.test.mjs, wired in executor.js + event-watcher.js).
 *
 * Measured (Alchemy, August 2026): on a day with ZERO active orders the keeper issued per day
 * 5,760 eth_getBalance (2 per 30s cycle), 5,760 eth_getLogs (event-watcher, one per watched
 * contract), 2,880 eth_blockNumber and 2,880 eth_call (ETH/USD) — every cycle did its full RPC work
 * while fetchActiveOrders() returned 0 rows. The keeper has nothing to execute when there are no
 * orders, so its RPC work backs off; the cheap Supabase read does not, so a new order is still
 * noticed within one POLL_INTERVAL_MS.
 *
 *   ACTIVE (≥1 active order found by the last cycle): every POLL_INTERVAL_MS tick is a full cycle —
 *          byte-for-byte today's behaviour.
 *   IDLE   (0 active orders found by the last cycle): a tick is a DB-only probe (unlockStaleOrders +
 *          fetchActiveOrders, exactly the Supabase calls a cycle makes today); the full RPC cycle —
 *          and the event-watcher poll — run once every IDLE_POLL_INTERVAL_MS. A probe that finds
 *          ≥1 row promotes the keeper to a full cycle on that same tick.
 *
 * Idle-cycle balance reads are handled by createIdleBalanceCarry (Task 3) — see below.
 */

/** Active cadence: the keeper's cycle and the event-watcher poll (unchanged: 30s). */
export const POLL_INTERVAL_MS = 30_000

/**
 * Idle cadence for RPC work: the keeper's full cycle and the event-watcher poll while there are no
 * active orders. Lower it here if a faster idle heartbeat is wanted; it is expressed in whole
 * POLL_INTERVAL_MS ticks (ceil), so a value that is not a multiple rounds UP, never down.
 */
export const IDLE_POLL_INTERVAL_MS = 300_000

/**
 * The keeper loop's mode + tick counter. executor.js calls `tick()` at every POLL_INTERVAL_MS tick
 * BEFORE any RPC and `record(n)` after every full cycle with the number of active orders it found.
 *
 * @param {{ pollIntervalMs?: number, idlePollIntervalMs?: number }} [opts]
 * @returns {{ tick: () => "rpc" | "probe", record: (activeOrderCount: number) => void, isIdle: () => boolean }}
 */
export function createIdleCadence({ pollIntervalMs = POLL_INTERVAL_MS, idlePollIntervalMs = IDLE_POLL_INTERVAL_MS } = {}) {
  const ticksPerIdleCycle = Math.max(1, Math.ceil(idlePollIntervalMs / pollIntervalMs))
  let idle = false // boots ACTIVE: the first tick is always a full cycle
  let ticksSinceRpcCycle = 0

  return {
    /** "rpc" ⇒ run the full cycle now; "probe" ⇒ DB-only probe, no RPC unless it finds an order. */
    tick() {
      if (!idle) return "rpc"
      ticksSinceRpcCycle += 1
      return ticksSinceRpcCycle >= ticksPerIdleCycle ? "rpc" : "probe"
    },
    /** After a full cycle: 0 active orders ⇒ IDLE, ≥1 ⇒ ACTIVE. Restarts the idle countdown. */
    record(activeOrderCount) {
      idle = activeOrderCount === 0
      ticksSinceRpcCycle = 0
    },
    isIdle() {
      return idle
    },
  }
}
