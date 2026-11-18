/**
 * [SEC-4 / fix/keeper-active-orders-window] The keeper's active-orders scan, pre-screen and walk (pure;
 * unit-tested in active-window.test.mjs, wired in executor.js fetchActiveOrders + executeCycle; shipped-cycle
 * tests in active-window-cycle.test.mjs and active-scan-probes.test.mjs).
 *
 * Before (origin/main): every cycle read the 15 OLDEST active rows of the chain and locked each one to ask
 * canExecute. A row whose canExecute is false is unlocked back to `active` without a miss and keeps its
 * place, so 15 rows that could not execute yet hid every newer order on that chain until they expired.
 * Round 1 (a9f12d9a) rotated a 15-row window; the A88 audit showed a flood of 15+ rows per cycle still hid
 * rows, a query error restarted the rotation, and overlapping cycles pruned ADR-026 streaks.
 *
 * Now (design 120b, owner answers 2026-11-18): asking is separated from locking.
 *   1. Scan. Each cycle reads up to SCAN_CAP (1000) active rows of the chain in keyset pages
 *      (created_at, id). With M <= SCAN_CAP the scan starts at the oldest row every cycle and holds the
 *      whole table: no cursor. With M > SCAN_CAP it rotates: the next page starts after the previous page's
 *      last row and wraps to the oldest. The page's Content-Range count says whether it reached the newest
 *      row, so a server that caps rows per request (Supabase max_rows) is never mistaken for the end.
 *      A fresh process with M > SCAN_CAP starts at a random page (S-8).
 *   2. Pre-screen. Every scanned row is asked canExecute WITHOUT a lock, batched through Multicall3
 *      (executor.js). The struct is built by the per-order path's own builder.
 *   3. Walk. The rows that answered true go, oldest first, through the EXISTING per-order path (lock,
 *      canExecute again, every gate, the retry ladder). Also walked: rows whose off-chain expiry has passed
 *      (the path's first step marks them `expired`; nothing else does), and up to ONE_BY_ONE rows the
 *      pre-screen could not answer (struct not buildable, own call reverted, chunk failed or timed out),
 *      chosen least-recently-walked first so the same rows can never hold that budget (owner answer 3).
 *      MAX_BATCH executions per cycle, unchanged.
 *   4. Carry-over. Ready rows the loop did not reach (MAX_BATCH, a gas SKIP — the row the SKIP stopped on
 *      included) are attempted next cycle: re-read by id when the next page does not hold them, and then
 *      they go first; otherwise they keep their oldest-first place (owner answer 1).
 *
 * Bound. Every active row is screened at least once every ceil(M / SCAN_CAP) cycles, plus one cycle per
 * fallback cycle (a scan query that failed, a pre-screen chunk that failed): consecutive pages tile the
 * table in keyset order, a fallback cycle moves nothing. To hide a row a flood must add SCAN_CAP rows per
 * cycle.
 *
 * Pruning (S-3). An in-memory per-order entry (ADR-026 infra streak) is dropped only for a row absent from
 * two consecutive COMPLETE scans: a cycle whose scan held the whole table, or, when rotating, a pass from
 * the oldest row to the newest. A row that was `executing` during one scan therefore keeps its streak.
 */

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

/** True for a uuid — the only id shape ever put in an `id=in.(…)` list. */
export function isUuid(id) {
  return typeof id === "string" && UUID_RE.test(id)
}

/**
 * The query parameters of one scan page, appended by executor.js to its chain-scoped base
 * (`orders?status=eq.active&chain_id=eq.${CHAIN_ID}`): rows in (created_at, id) order, after `cursor` when
 * one is given, else from the oldest — or from row `offset` of that order (a fresh process's random page).
 * The timestamp and the id are double-quoted (PostgREST's rule for values holding reserved characters) and
 * everything is form-encoded, so the '+' of "+00:00" travels as %2B and is never read as a space.
 * @param {{ cursor?: { createdAt: string, id: string } | null, limit: number, offset?: number | null }} p
 * @returns {string}  e.g. "or=%28created_at.gt.%22…%22%2C…%29&select=*&order=created_at.asc%2Cid.asc&limit=1000"
 */
export function activeWindowParams({ cursor = null, limit, offset = null }) {
  const q = new URLSearchParams()
  if (cursor) {
    const ts = `"${cursor.createdAt}"`
    const id = `"${cursor.id}"`
    q.set("or", `(created_at.gt.${ts},and(created_at.eq.${ts},id.gt.${id}))`)
  }
  q.set("select", "*")
  q.set("order", "created_at.asc,id.asc")
  q.set("limit", String(Math.max(1, Math.floor(limit))))
  if (!cursor && Number.isInteger(offset) && offset > 0) q.set("offset", String(offset))
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
 * Build this cycle's scan from the database's answers. Pure.
 *
 * @param {{
 *   chainId: number,
 *   windowSize: number,          // SCAN_CAP
 *   cursor: { createdAt: string, id: string } | null,  // where the page starts (exclusive); null = oldest / offset
 *   offset?: number | null,      // a random-page start (cursor null); the page is rows offset.. of the table
 *   tail: object[],              // the page's rows, as returned
 *   tailTotal?: number | null,   // its Content-Range count: rows matching the page's filter (offset ignored)
 *   head?: object[] | null,      // rows from the oldest, fetched only when the page reached the newest row
 * }} p
 * @returns {{
 *   rows: object[],              // the scan, in keyset order from where it started (page, then head)
 *   tailCount: number,           // how many of `rows` came from the page
 *   endReached: boolean,         // the page reached the newest row
 *   coversAll: boolean,          // the scan holds every active row of the chain (a complete scan)
 *   fromOldest: boolean,         // the page started at the oldest row (no cursor, no offset)
 *   cursor: { createdAt: string, id: string } | null,      // where it started
 *   nextCursor: { createdAt: string, id: string } | null,  // the key of its last row
 * }}
 */
export function selectActiveWindow({ chainId, windowSize, cursor, offset = null, tail, tailTotal = null, head = null }) {
  const size = Math.max(1, Math.floor(windowSize))
  const tailRows = Array.isArray(tail) ? tail : []
  const headRows = Array.isArray(head) ? head : null
  const start = Number.isInteger(offset) && offset > 0 && !cursor ? offset : 0
  // The count (when the server gave one) decides; without it, a short page is the end.
  const endReached = Number.isInteger(tailTotal) ? start + tailRows.length >= tailTotal : tailRows.length < size

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

  // The whole table is in this scan when the page started at the oldest row and reached the newest, or
  // when the head (from the oldest) came back to where the page started: it ran short, met a page row, or
  // ended on the cursor row itself.
  const fromOldest = cursor === null && start === 0
  const headLimit = size - tailRows.length
  const coversAll =
    endReached &&
    (fromOldest ||
      (headRows !== null &&
        (headRows.length < headLimit || headDuplicated || (cursor !== null && headRows[headRows.length - 1]?.id === cursor.id))))

  return { rows, tailCount, endReached, coversAll, fromOldest, cursor, nextCursor: lastCursor(rows) }
}

/** The key of the last row that has one; null when none does. */
function lastCursor(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = cursorOf(rows[i])
    if (c) return c
  }
  return null
}

/**
 * The scan state after one SCREENED scan (a fallback or paused cycle changes nothing). Pure.
 *
 *   cursor   -- where the next page starts; null = the oldest row (no rotation).
 *   pass     -- rotating only: ids seen since the scan last left the oldest row, and whether this pass
 *               really began there (false after a random start or a missed wrap read: such a pass is never
 *               counted complete).
 *   complete -- the ids of a COMPLETE scan finished by this cycle, or null. With M <= SCAN_CAP every cycle
 *               is one; when rotating, a pass from the oldest row to the newest.
 *
 * @param {{ cursor: object|null, pass: { ids: Set<string>, fromOldest: boolean } }} state
 * @param {ReturnType<typeof selectActiveWindow>} scan  (or truncateScan's prefix of it)
 * @param {{ extraIds?: string[] }} [opts]  extraIds: carried rows re-read by id this cycle
 * @returns {{ cursor: object|null, pass: { ids: Set<string>, fromOldest: boolean }, complete: Set<string>|null }}
 */
export function advanceScan(state, scan, { extraIds = [] } = {}) {
  const ids = scan.rows.map((r) => r.id)
  // Rows past the page are the head (from the oldest): read, and screened.
  const headFetched = ids.length > scan.tailCount
  if (scan.coversAll) {
    return { cursor: null, pass: { ids: new Set(), fromOldest: true }, complete: new Set([...ids, ...extraIds]) }
  }
  // A page that starts at the oldest row begins a pass (the table just outgrew one scan, or a random start
  // fell back to the oldest page); otherwise the pass in progress goes on.
  const pass = scan.fromOldest ? { ids: new Set(), fromOldest: true } : state?.pass ?? { ids: new Set(), fromOldest: false }
  const tailIds = ids.slice(0, scan.tailCount)
  const headIds = ids.slice(scan.tailCount)
  if (!scan.endReached) {
    // Mid-table: the pass goes on.
    return { cursor: scan.nextCursor, pass: { ids: new Set([...pass.ids, ...tailIds, ...extraIds]), fromOldest: pass.fromOldest }, complete: null }
  }
  // The page reached the newest row: this pass ends here.
  const complete = pass.fromOldest ? new Set([...pass.ids, ...tailIds, ...extraIds]) : null
  if (headFetched) {
    // The head (from the oldest) begins the next pass.
    return { cursor: scan.nextCursor, pass: { ids: new Set(headIds), fromOldest: true }, complete }
  }
  // No head this cycle (its read failed, or the page reached the newest row with no room left): the next scan
  // starts at the oldest row with its own first read, so a failing wrap read can never stall the scan on the
  // newest row.
  return { cursor: null, pass: { ids: new Set(), fromOldest: true }, complete }
}

/**
 * The prefix of a scan the pre-screen really answered: its first `k` rows. A failed Multicall3 chunk holds
 * the scan's position at its first row, so no row is passed over unscreened (one more cycle per fallback
 * cycle, as the bound says). Pure.
 * @param {ReturnType<typeof selectActiveWindow>} scan
 * @param {number} k
 * @returns {ReturnType<typeof selectActiveWindow>}
 */
export function truncateScan(scan, k) {
  const n = Math.max(0, Math.min(Math.floor(k), scan.rows.length))
  if (n >= scan.rows.length) return scan
  const rows = scan.rows.slice(0, n)
  return {
    rows,
    tailCount: Math.min(scan.tailCount, n),
    endReached: scan.endReached && n >= scan.tailCount,
    coversAll: false,
    fromOldest: scan.fromOldest,
    cursor: scan.cursor,
    nextCursor: lastCursor(rows) ?? scan.cursor,
  }
}

/**
 * The ids that keep an in-memory per-order entry (ADR-026 infra streak) after a complete scan, or null to
 * prune NOTHING: an entry goes only when its row is absent from this complete scan AND the previous one.
 * @param {Set<string>|null} previousComplete
 * @param {Set<string>|null} complete
 * @returns {Set<string>|null}
 */
export function keepIdsAfterScans(previousComplete, complete) {
  if (!complete || !previousComplete) return null
  return new Set([...previousComplete, ...complete])
}

/**
 * Which scanned rows the per-order path walks this cycle. Pure.
 *
 * @param {{
 *   rows: object[],                 // what executeCycle iterates, in order (carried re-reads first, then the scan)
 *   answers: Map<string, { canExec: boolean } | { unanswered: string }>,  // the pre-screen, per row id
 *   nowSec: number,
 *   budget: number,                 // ONE_BY_ONE: rows the pre-screen could not answer, per cycle
 *   lastWalked?: Map<string, number>,  // id -> sequence of the cycle it last used the budget
 * }} p
 * @returns {{ ids: Set<string>, ready: string[], expired: string[], oneByOne: string[], unanswered: number }}
 */
export function planWalk({ rows, answers, nowSec, budget, lastWalked = new Map() }) {
  const ready = []
  const expired = []
  const unanswered = []
  for (const [i, row] of rows.entries()) {
    const id = row?.id
    if (typeof id !== "string") continue
    // The path's own pre-filter, unchanged: an expired row is marked `expired` there.
    if (Number(row.expiry) < nowSec) {
      expired.push(id)
      continue
    }
    const a = answers.get(id)
    if (a && a.canExec === true) ready.push(id)
    else if (!a || a.unanswered) unanswered.push({ id, i, last: lastWalked.get(id) ?? -1 })
  }
  // Least recently walked first; never walked = -1; ties in scan order (oldest first).
  unanswered.sort((x, y) => x.last - y.last || x.i - y.i)
  const oneByOne = unanswered.slice(0, Math.max(0, Math.floor(budget))).map((u) => u.id)
  return { ids: new Set([...ready, ...expired, ...oneByOne]), ready, expired, oneByOne, unanswered: unanswered.length }
}

/**
 * Carry-over after the loop: the ready rows it did not reach, plus the row a gas SKIP stopped on, in scan
 * order. Pure.
 * @param {ReturnType<typeof planWalk>} walk
 * @param {Set<string>} reached  ids the loop got to
 * @param {string | null} stoppedOn  the ready row a gas SKIP broke the loop on, or null
 * @param {number} cap
 * @returns {string[]}
 */
export function carryAfterLoop(walk, reached, stoppedOn, cap) {
  const out = walk.ready.filter((id) => !reached.has(id) || id === stoppedOn)
  // A row walked from the one-by-one budget that the SKIP stopped on was ready too: it leads.
  if (stoppedOn && !out.includes(stoppedOn)) out.unshift(stoppedOn)
  return out.slice(0, Math.max(0, Math.floor(cap)))
}

/**
 * Ops-alert pacing for a fallback that persists (S-7): alert on the first cycle of an episode, then again
 * at most once per `repeatMs` while it persists; one quiet cycle ends the episode.
 * @param {{ repeatMs: number }} p
 */
export function createEpisodeGate({ repeatMs }) {
  let since = null
  let lastAlertAt = null
  let cycles = 0
  return {
    /** @returns {{ alert: boolean, cycles: number, sinceMs: number | null }} */
    onCycle(failed, nowMs) {
      if (!failed) {
        since = null
        lastAlertAt = null
        cycles = 0
        return { alert: false, cycles: 0, sinceMs: null }
      }
      if (since === null) since = nowMs
      cycles++
      const alert = lastAlertAt === null || nowMs - lastAlertAt >= repeatMs
      if (alert) lastAlertAt = nowMs
      return { alert, cycles, sinceMs: since }
    },
  }
}

const MAX_COUNT = 10_000_000
const count = (n) => (Number.isInteger(n) && n >= 0 && n <= MAX_COUNT ? String(n) : "?")

/**
 * The fallback flag of the cycle line, from a fixed vocabulary only: none, scan-<3-digit status | timeout |
 * network>, prescreen-<failed>of<chunks>, joined by "+".
 * @param {{ scan?: string | number | null, prescreenFailed?: number, prescreenChunks?: number }} p
 */
export function fallbackFlag({ scan = null, prescreenFailed = 0, prescreenChunks = 0 } = {}) {
  const parts = []
  if (scan !== null && scan !== undefined) {
    const s = String(scan)
    parts.push(`scan-${/^\d{3}$/.test(s) || s === "timeout" || s === "network" ? s : "error"}`)
  }
  if (Number.isInteger(prescreenFailed) && prescreenFailed > 0) parts.push(`prescreen-${count(prescreenFailed)}of${count(prescreenChunks)}`)
  return parts.length ? parts.join("+") : "none"
}

/**
 * The one per-cycle line (S-11). Counts and flags only — never an order id, an address, a signature or a URL;
 * every number is a validated non-negative integer, else "?".
 * @param {{ active: number|null, scanned: number, ready: number, attempted: number, carried: number, rotate: boolean, fallback?: string }} p
 */
export function activeScanLogLine({ active, scanned, ready, attempted, carried, rotate, fallback = "none" }) {
  const flag = /^(none|(scan-(\d{3}|timeout|network|error)|prescreen-\d+of\d+)(\+(scan-(\d{3}|timeout|network|error)|prescreen-\d+of\d+))*)$/.test(fallback) ? fallback : "?"
  return `Active scan: active=${count(active)} scanned=${count(scanned)} true=${count(ready)} attempted=${count(attempted)} carried=${count(carried)} rotate=${rotate ? "yes" : "no"} fallback=${flag}`
}

/**
 * A response body or error text fit for one log line (S-11): uuids, 0x-hex of 40+ digits and URLs replaced,
 * whitespace collapsed, capped at 200 characters.
 * @param {unknown} text
 */
export function logBody(text) {
  return String(text ?? "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/0x[0-9a-f]{40,}/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}
