/**
 * [SEC-4 / fix/keeper-active-orders-window] The keeper's rotating active-orders window (pure; unit-tested
 * in active-window.test.mjs, wired in executor.js fetchActiveOrders + executeCycle; cycle-level tests in
 * active-window-cycle.test.mjs).
 *
 * Before: every cycle read the 15 OLDEST active rows of the chain (order=created_at.asc,
 * limit=MAX_BATCH*3). A row whose canExecute is false is unlocked back to `active` without a miss and
 * keeps its place, so 15 rows that cannot execute yet (unfunded, no allowance, a DCA between chunks) hid
 * every newer order on that chain until they expired — up to 90 days, no attacker needed.
 *
 * Now: the same per-cycle budget (W = MAX_BATCH*3 = 15 rows) is a WINDOW that rotates over the whole table.
 *   - Keyset by (created_at, id), both ascending — the order PostgREST is asked for. The cursor is the key
 *     of the last row the previous cycle reached; it lives in memory only, so a restart begins at the
 *     oldest row.
 *   - tail = up to W rows after the cursor. If the tail comes back short, the scan has reached the newest
 *     row and WRAPS: head = up to W − |tail| rows from the oldest, ids already in the tail dropped. A table
 *     of ≤ W rows is therefore read whole every cycle, oldest first once the cursor settles — today's
 *     behaviour for a small table.
 *   - The cursor moves past the rows the order loop REACHED (owner reading 2026-11-17: the loop still stops
 *     after MAX_BATCH executions and on a gas SKIP; the rows it did not reach lead the next window).
 *
 * Bound. With M rows on the chain and no early stop, consecutive windows tile the table in keyset order
 * (each starts right after the previous one's last row, wrapping), so every row is in some window within
 * ceil(M / W) cycles. Each cycle the loop stops early (MAX_BATCH executed, or gas SKIP) moves the cursor
 * past at least the rows it reached instead of W, adding at most one cycle. Rows added or removed between
 * cycles: a row passes at most once before the scan returns to any given row, so M counts the distinct
 * rows active during those cycles (owner reading 2026-11-17).
 *
 * Slow-down. A row whose canExecute answered "Insufficient balance" / "Insufficient allowance" (the
 * contracts' exact strings, V2 and V3) ACTIVE_WINDOW_SLOW_AFTER times in a row is examined at most once per
 * ACTIVE_WINDOW_SLOW_MS: it stays in the window (the cursor passes it, it never holds a slot) but the loop
 * skips it until the period has passed since its last answer. In memory only — no status change, no
 * database counter, no alert. Any other answer (true, interval not reached, a price reason, …) clears it;
 * no other reason is ever slowed.
 *
 * Pruning. executor.js used to drop an order's in-memory infra streak (ADR-026 / A73b S-9) when the order
 * was absent from the rows just fetched. A window is not the table, so absence from it proves nothing by
 * itself: an id keeps its streak (and its slow-down entry) until a whole pass of the table has not seen it.
 * A window that holds the whole table keeps today's rule exactly.
 */

/** Consecutive balance/allowance answers before a row is slowed. */
export const ACTIVE_WINDOW_SLOW_AFTER = 3
/** A slowed row is examined at most once per this many ms. */
export const ACTIVE_WINDOW_SLOW_MS = 10 * 60_000
/** canExecute's reasons that slow a row down — exact strings of TeraSwapOrderExecutor(V3).canExecute. */
export const ACTIVE_WINDOW_SLOW_REASONS = Object.freeze(["Insufficient balance", "Insufficient allowance"])

// PostgREST's timestamptz output ("2026-11-17T10:00:00.123456+00:00") and a uuid. Anything else is never
// put in a URL: a row without a usable key cannot become the cursor.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The keyset position of a row, or null when it has no usable (created_at, id).
 * @param {{ created_at?: unknown, id?: unknown } | null | undefined} row
 * @returns {{ createdAt: string, id: string } | null}
 */
export function cursorOf(row) {
  const createdAt = row?.created_at
  const id = row?.id
  if (typeof createdAt !== "string" || !TIMESTAMP_RE.test(createdAt)) return null
  if (typeof id !== "string" || !UUID_RE.test(id)) return null
  return { createdAt, id }
}

/**
 * The query parameters of one page of the window, appended by executor.js to its chain-scoped base
 * (`orders?status=eq.active&chain_id=eq.${CHAIN_ID}`): rows in (created_at, id) order, after `cursor` when
 * one is given (the tail), else from the oldest (the head). The timestamp and the id are double-quoted
 * (PostgREST's rule for values holding reserved characters) and everything is form-encoded, so the '+' of
 * "+00:00" travels as %2B and is never read as a space.
 * @param {{ cursor?: { createdAt: string, id: string } | null, limit: number }} p
 * @returns {string}  e.g. "or=%28created_at.gt.%22…%22%2C…%29&select=*&order=created_at.asc%2Cid.asc&limit=15"
 */
export function activeWindowParams({ cursor = null, limit }) {
  const q = new URLSearchParams()
  if (cursor) {
    const ts = `"${cursor.createdAt}"`
    const id = `"${cursor.id}"`
    q.set("or", `(created_at.gt.${ts},and(created_at.eq.${ts},id.gt.${id}))`)
  }
  q.set("select", "*")
  q.set("order", "created_at.asc,id.asc")
  q.set("limit", String(Math.max(1, Math.floor(limit))))
  return q.toString()
}

/**
 * The total of a PostgREST Content-Range header ("0-14/37", "*\/0"), or null when absent / "*".
 * @param {string | null | undefined} header
 * @returns {number | null}
 */
export function contentRangeTotal(header) {
  const m = /\/(\d+)\s*$/.exec(String(header ?? ""))
  return m ? Number(m[1]) : null
}

/**
 * Build this cycle's window from the database's answers. Pure.
 *
 * @param {{
 *   chainId: number,
 *   windowSize: number,
 *   cursor: { createdAt: string, id: string } | null,  // where this window starts (exclusive)
 *   tail: object[],              // rows after `cursor` (or from the oldest when it is null), as returned
 *   head?: object[] | null,      // rows from the oldest, fetched only when the tail came back short
 *   slow?: Map<string, { streak: number, lastAt: number }>,
 *   nowMs: number,
 * }} p
 * @returns {{
 *   rows: object[],              // the window, in scan order (tail, then head): what the loop walks
 *   tailCount: number,           // how many of `rows` came from the tail
 *   slowedIds: Set<string>,      // rows of the window the loop must skip this cycle (slow-down)
 *   examineIds: Set<string>,     // rows of the window to examine: rows minus slowedIds
 *   endReached: boolean,         // the tail was short: this window reaches the newest row
 *   coversAll: boolean,          // the window holds every active row of the chain
 *   cursor: { createdAt: string, id: string } | null,      // where it started
 *   nextCursor: { createdAt: string, id: string } | null,  // where the next one starts if the loop reaches every row
 * }}
 */
export function selectActiveWindow({ chainId, windowSize, cursor, tail, head = null, slow = new Map(), nowMs }) {
  const size = Math.max(1, Math.floor(windowSize))
  const tailRows = Array.isArray(tail) ? tail : []
  const headRows = Array.isArray(head) ? head : null
  const endReached = tailRows.length < size

  const rows = []
  const seen = new Set()
  const take = (row) => {
    if (rows.length >= size) return
    // Defence in depth: the query is chain-scoped; a row of another chain is never handed to the loop.
    if (!row || typeof row.id !== "string" || Number(row.chain_id) !== Number(chainId)) return
    if (seen.has(row.id)) return
    seen.add(row.id)
    rows.push(row)
  }
  for (const row of tailRows) take(row)
  const tailCount = rows.length
  let headDuplicated = false
  if (endReached && headRows) {
    for (const row of headRows) {
      if (row && seen.has(row.id)) headDuplicated = true
      take(row)
    }
  }

  // The whole table is in this window when the tail reached the newest row AND the head (if any)
  // came back to the cursor: it ran short, met a tail row, or ended on the cursor row itself.
  const headLimit = size - tailRows.length
  const coversAll =
    endReached &&
    (cursor === null ||
      (headRows !== null &&
        (headRows.length < headLimit || headDuplicated || headRows[headRows.length - 1]?.id === cursor.id)))

  const slowedIds = new Set()
  for (const row of rows) if (isSlowed(slow?.get(row.id), nowMs)) slowedIds.add(row.id)
  const examineIds = new Set(rows.filter((r) => !slowedIds.has(r.id)).map((r) => r.id))

  return { rows, tailCount, slowedIds, examineIds, endReached, coversAll, cursor, nextCursor: lastCursor(rows, rows.length) }
}

/** The key of the last of the first `count` rows that has one; null when none does. */
function lastCursor(rows, count) {
  for (let i = Math.min(count, rows.length) - 1; i >= 0; i--) {
    const c = cursorOf(rows[i])
    if (c) return c
  }
  return null
}

/**
 * After the loop: where the next window starts, whether the scan wrapped (passed the newest row), and the
 * rotation's ids (for activeWindowKeepIds). Pure.
 *
 * The rotation set holds ids fetched since the scan last started from the oldest row, and it always
 * covers the keyset range [oldest row, cursor]: every row that was active when the scan passed its
 * position in that range is in it. It restarts (as the head part of this window) only when the cursor
 * moves INTO that head part; otherwise this window's ids are added (the cursor moved within the range they
 * cover). A cursor that stops on the newest row keeps accumulating: the next window starts after it.
 *
 * @param {ReturnType<typeof selectActiveWindow> | null} scan
 * @param {number} reached  rows of scan.rows the loop got to (scan.rows.length unless it stopped early)
 * @param {Set<string>} rotation  ids covering [oldest row, scan.cursor]
 * @returns {{ cursor: { createdAt: string, id: string } | null, wrapped: boolean, rotation: Set<string> }}
 */
export function advanceActiveWindow(scan, reached, rotation = new Set()) {
  if (!scan) return { cursor: null, wrapped: false, rotation }
  const n = Math.max(0, Math.min(Math.floor(reached), scan.rows.length))
  const all = n >= scan.rows.length
  // Reaching every row moves the cursor to the window's end; an early stop moves it past the reached
  // rows only. Reaching none (a stop on the first row cannot happen: MAX_BATCH ≥ 1) keeps it.
  const cursor = all ? scan.nextCursor : n === 0 ? scan.cursor : lastCursor(scan.rows, n) ?? scan.cursor
  // Wrapped = this cycle's scan got past the newest row: the tail was short and the loop reached all of it.
  const wrapped = scan.endReached && n >= scan.tailCount
  const ids = scan.rows.map((r) => r.id)
  const intoHead = scan.endReached && n > scan.tailCount
  const next = cursor === null ? new Set() : intoHead ? new Set(ids.slice(scan.tailCount)) : new Set([...rotation, ...ids])
  return { cursor, wrapped, rotation: next }
}

/**
 * The ids that may keep an in-memory per-order entry (ADR-026 infra streak, slow-down) this cycle, or null
 * to prune NOTHING. Pure.
 *   - the window holds the whole table ⇒ exactly its ids (today's rule: absent from the active set ⇒ gone);
 *   - the window's tail reached the newest row ⇒ the rotation's ids (covering [oldest, cursor]) plus this
 *     window's (covering (cursor, newest]) — a full pass of the table, so an id missing from both was not
 *     active when the scan went past its position;
 *   - otherwise ⇒ null: this cycle saw only part of the table and proves no absence.
 * @param {ReturnType<typeof selectActiveWindow> | null} scan
 * @param {string[]} windowIds  ids of the rows the loop is handed (scan.rows)
 * @param {Set<string>} rotation  ids covering [oldest row, scan.cursor] (advanceActiveWindow)
 * @returns {Set<string> | null}
 */
export function activeWindowKeepIds(scan, windowIds, rotation = new Set()) {
  if (!scan || !scan.endReached) return null
  const ids = Array.isArray(windowIds) ? windowIds.map(String) : []
  if (scan.coversAll) return new Set(ids)
  return new Set([...rotation, ...ids])
}

/** True for canExecute reasons that slow a row down. */
export function isSlowReason(reason) {
  return typeof reason === "string" && ACTIVE_WINDOW_SLOW_REASONS.includes(reason.trim())
}

/**
 * The row's slow-down entry after one canExecute answer, or null (no entry). Pure.
 * @param {{ streak: number, lastAt: number } | null | undefined} prev
 * @param {{ canExecute: boolean, reason?: string, nowMs: number }} answer
 */
export function nextSlowEntry(prev, { canExecute, reason, nowMs }) {
  if (canExecute || !isSlowReason(reason)) return null
  return { streak: (prev?.streak ?? 0) + 1, lastAt: nowMs }
}

/** A row is slowed after ACTIVE_WINDOW_SLOW_AFTER consecutive slow answers, until ACTIVE_WINDOW_SLOW_MS after the last. */
export function isSlowed(entry, nowMs) {
  return Boolean(entry) && entry.streak >= ACTIVE_WINDOW_SLOW_AFTER && nowMs - entry.lastAt < ACTIVE_WINDOW_SLOW_MS
}

/** Record one canExecute answer in the slow-down map (the map executor.js holds). */
export function noteCanExecuteAnswer(slow, id, answer) {
  const next = nextSlowEntry(slow.get(id), answer)
  if (next) slow.set(id, next)
  else slow.delete(id)
}

/** Drop slow-down entries whose id is not in `keepIds` (null ⇒ drop nothing). Returns how many were dropped. */
export function pruneSlowRows(slow, keepIds) {
  if (!keepIds) return 0
  let dropped = 0
  for (const id of [...slow.keys()]) {
    if (!keepIds.has(id)) {
      slow.delete(id)
      dropped++
    }
  }
  return dropped
}

/**
 * The one per-cycle log line. Counts and flags only — never an address, a signature or an id.
 * @param {{ active: number | null, window: number, examined: number, slowed: number, wrapped: boolean, fallback?: number | null }} p
 */
export function activeWindowLogLine({ active, window, examined, slowed, wrapped, fallback = null }) {
  const a = Number.isInteger(active) ? String(active) : "?"
  const tail = fallback ? ` keyset=rejected(${fallback}) fallback=oldest` : ""
  return `Active window: active=${a} window=${window} examined=${examined} slowed=${slowed} wrap=${wrapped ? "yes" : "no"}${tail}`
}
