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
 *      they go first; otherwise they keep their oldest-first place (owner answer 1). A fallback cycle keeps
 *      the list untouched (A91 R2-3).
 *
 * Round 3 (A91 R2-1, design 120c, owner answers 2026-11-18): every row is hostile. A row's canExecute runs
 * code its creator chose (tokenIn, priceFeed), and two gas-burning rows can make a whole Multicall3 call
 * fail. So:
 *   - the scan NEVER holds its position on a failed chunk: the cursor moves past every row it read;
 *   - a chunk that failed for any reason but an RPC transport error (HTTP status, network, auth) is
 *     BISECTED in the same cycle (bisectFailedChunks): halves asked again through Multicall3 until the
 *     failing rows are alone, within BISECT_CALL_BUDGET extra calls; rows still unresolved, and the rows of
 *     a transport-failed chunk, go to the one-by-one budget as in round 2;
 *   - a row asked ALONE (a direct canExecute eth_call with an explicit gas cap) that fails with out of gas,
 *     a revert or its own time limit, while another pre-screen call of the cycle answered, is QUARANTINED
 *     in memory (createQuarantine): left out of every chunk and of the walk, asked again alone at most once
 *     every 30 minutes (QUARANTINE_REASK_BUDGET asks per cycle, outside the bisect budget), released when it
 *     answers. Quarantine never changes a row's status, never counts a miss, never touches ADR-024 or
 *     ADR-026 state. An expired quarantined row is still walked, so the path marks it `expired`.
 *
 * Bound (stated in the runbook, EXECUTOR-OPERATIONS.md § 9). Every active row that is not quarantined is
 * screened at least once every ceil(M / SCAN_CAP) cycles, plus one cycle per fallback cycle (the scan query
 * failed) or failed wrap read, plus ceil(M / SCAN_CAP) cycles for each cycle that left its pre-screen chunk
 * unresolved (the bisect budget ran out, or an RPC transport error): consecutive pages tile the table in
 * keyset order and nothing holds the position, so such a row waits for the scan to come round again. To
 * hide a row a flood must add SCAN_CAP rows per cycle. A restarted process starts at a random page (S-8),
 * so restarts are not covered by the bound: the runbook gives the measured worst gap for a restart every
 * cycle and every 2 cycles.
 *
 * Pruning (S-3). An in-memory per-order entry (ADR-026 infra streak, the quarantine) is dropped only for a
 * row absent from two consecutive COMPLETE scans: a cycle whose scan held the whole table, or, when
 * rotating, a pass from the oldest row to the newest. A row that was `executing` during one scan therefore
 * keeps its streak. A scan is complete on what it READ: quarantined rows (read, not asked) do not stop it.
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

// [A91 R2-1] Round 2's truncateScan (a failed chunk HELD the scan at its first row) is gone: one row's
// creator could fail a chunk every cycle and freeze the rotation. A failed chunk is bisected instead.

/**
 * Why one pre-screen call failed, from the error alone (A91 R2-1, owner answer 2 of 2026-11-18). Never throws;
 * cycle-safe; depth-bounded (an error object can be hostile to read: the walk ends at the hostile link).
 *   "time-limit" — the keeper's OWN time limit on the call (the error carries `prescreenTimeLimit: true`);
 *   "transport"  — the RPC itself: an HTTP status anywhere in the chain, viem's HTTP / socket error types,
 *                  a network error code or text, or (isAuth) the provider refusing our key;
 *   "execution"  — the EVM answered: out of gas, a revert (viem's /Revert/ error names or the node's words);
 *   "other"      — anything else (a JSON-RPC error without evidence, no data, an undecodable answer).
 * A chunk that failed for any reason but "transport" is bisected; a row asked alone is quarantined only on
 * "execution" or "time-limit". An HTTP status decides first: a provider's error page may say "reverted". (viem
 * keeps no status when a 5xx carries a JSON-RPC error body — it builds ExecutionRevertedError from it, ADR-026
 * A73c S-12 — so such an answer reads as "execution": it is bisected, and quarantines a row only while other
 * calls of the cycle answer.)
 * @param {unknown} err
 * @param {{ isAuth?: (err: unknown) => boolean }} [opts]
 * @returns {"time-limit" | "transport" | "execution" | "other"}
 */
export function prescreenFailureKind(err, { isAuth = null } = {}) {
  const names = []
  const codes = []
  const parts = []
  let status = false
  let timeLimit = false
  const seen = new Set()
  try {
    let e = err
    for (let depth = 0; e != null && depth < 8; depth++) {
      if (typeof e !== "object") {
        parts.push(String(e))
        break
      }
      if (seen.has(e)) break
      seen.add(e)
      if (e.prescreenTimeLimit === true) timeLimit = true
      if (typeof e.name === "string") names.push(e.name)
      if (typeof e.status === "number") status = true
      if (typeof e.code === "string") codes.push(e.code)
      for (const k of ["shortMessage", "message", "details"]) if (typeof e[k] === "string") parts.push(e[k])
      e = e.cause
    }
  } catch {
    /* a hostile link ends the walk: classify on what was read */
  }
  if (timeLimit) return "time-limit"
  const text = parts.join(" \n ").toLowerCase()
  let auth = false
  try {
    auth = typeof isAuth === "function" && isAuth(err) === true
  } catch {
    auth = false
  }
  if (status || auth) return "transport"
  // viem's own transport timeout (10 s per try) is the RPC's; the keeper's own limit returned "time-limit" above.
  if (names.some((n) => /^(?:HttpRequestError|WebSocketRequestError|SocketClosedError|TimeoutError)$/.test(n))) return "transport"
  if (codes.some((c) => /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|UND_ERR_)/.test(c))) return "transport"
  if (/http request failed|status: \d{3}|fetch failed|econnrefused|econnreset|enotfound|eai_again|socket hang up|network error/.test(text)) return "transport"
  if (names.some((n) => /Revert/.test(n)) || /out of gas|outofgas|execution reverted|\breverted\b|gas required exceeds|invalid opcode/.test(text)) return "execution"
  return "other"
}

/**
 * Bisect the pre-screen's failed Multicall3 chunks (A91 R2-1). The driver only decides WHAT to ask; every call is
 * injected, so it is unit-tested without a chain. Depth-first from the oldest row: a failed set is split in
 * two halves and each half of two or more rows is asked again; a half that answers gives its rows their
 * answer, and a row of that half whose own call failed (a suspect) is asked ALONE; a half that fails again is
 * split again; a half or set of one row is asked alone. A call that fails with an RPC transport error is not
 * split: its rows are unresolved. At most `budget` calls; whatever is left when it is spent is unresolved.
 *
 * Cost, on the measured model (a 50-row call fails only when it holds two or more gas burners, at eth_call caps
 * >= 30M): failed sets are disjoint per depth and each holds >= 2 of the P burners, so <= P/2 per depth over
 * 5 splitting depths (50, 25, 13, 7, 4) — <= 5P batch calls — plus one alone-ask per burner and per one-row
 * half: isolating P burners costs <= 7P calls, i.e. <= ceil(7P / budget) cycles.
 *
 * @template T
 * @param {{
 *   sets: T[][],                                  // failed chunks, in scan order
 *   askChunk: (rows: T[]) => Promise<{ ok: true, results: ({ answered: true, answer: unknown } | { answered: false })[] } | { ok: false, kind: string }>,
 *   askOne: (row: T) => Promise<{ ok: true, answer: unknown } | { ok: false, kind: string }>,
 *   budget: number,
 * }} p
 * @returns {Promise<{ answered: [T, unknown][], isolated: { row: T, kind: string }[], unresolved: T[], calls: number }>}
 *   isolated: rows that failed ALONE with "execution" or "time-limit" (the caller decides on quarantine);
 *   unresolved: rows the budget did not reach, transport failures, and rows that failed alone otherwise.
 */
export async function bisectFailedChunks({ sets, askChunk, askOne, budget }) {
  const cap = Math.max(0, Math.floor(budget))
  const answered = []
  const isolated = []
  const unresolved = []
  let calls = 0
  const pending = sets.filter((s) => Array.isArray(s) && s.length > 0).map((s) => s.slice())
  while (pending.length > 0) {
    const set = pending.shift()
    if (calls >= cap) {
      unresolved.push(...set)
      continue
    }
    if (set.length === 1) {
      calls++
      const r = await askOne(set[0])
      if (r.ok) answered.push([set[0], r.answer])
      else if (r.kind === "execution" || r.kind === "time-limit") isolated.push({ row: set[0], kind: r.kind })
      else unresolved.push(set[0])
      continue
    }
    const mid = Math.ceil(set.length / 2)
    const next = []
    for (const half of [set.slice(0, mid), set.slice(mid)]) {
      // A half of one row is asked alone (its own gas cap), never as a one-call batch.
      if (calls >= cap || half.length === 1) {
        next.push(half)
        continue
      }
      calls++
      const r = await askChunk(half)
      if (r.ok) {
        half.forEach((row, j) => {
          if (r.results[j]?.answered) answered.push([row, r.results[j].answer])
          else next.push([row]) // its own call failed inside an answered half: ask it alone
        })
      } else if (r.kind === "transport") unresolved.push(...half)
      else next.push(half)
    }
    pending.unshift(...next)
  }
  return { answered, isolated, unresolved, calls }
}

/**
 * The pre-screen's quarantine (A91 R2-1): rows whose canExecute failed ALONE. In memory only, never persisted,
 * never a status, a miss or ADR-024 / ADR-026 state. A quarantined row is left out of every chunk and of the
 * walk (unless expired), asked again alone at most once every `reaskMs`, and released when it answers.
 * @param {{ reaskMs: number }} p
 */
export function createQuarantine({ reaskMs }) {
  /** @type {Map<string, { since: number, askedAt: number, kind: string }>} */
  const rows = new Map()
  let total = 0
  let released = 0
  return {
    has: (id) => rows.has(id),
    size: () => rows.size,
    /** Rows ever quarantined / released by this process (for /health). */
    counts: () => ({ total, released }),
    /** Quarantine `id` (asked alone at `nowMs`, failed with `kind`); a re-quarantine only moves askedAt. */
    add(id, nowMs, kind) {
      const q = rows.get(id)
      if (q) {
        q.askedAt = nowMs
        q.kind = kind
        return
      }
      rows.set(id, { since: nowMs, askedAt: nowMs, kind })
      total++
    },
    /** Of `ids` (this cycle's quarantined rows, in scan order): those due a re-ask, least recently asked first. */
    due(ids, nowMs) {
      const out = []
      ids.forEach((id, i) => {
        const q = rows.get(id)
        if (q && nowMs - q.askedAt >= reaskMs) out.push({ id, i, askedAt: q.askedAt })
      })
      out.sort((x, y) => x.askedAt - y.askedAt || x.i - y.i)
      return out.map((x) => x.id)
    },
    /** A re-ask that failed again: the row stays, asked again no sooner than reaskMs from now. */
    asked(id, nowMs) {
      const q = rows.get(id)
      if (q) q.askedAt = nowMs
    },
    /** The row answered: out of quarantine. */
    release(id) {
      if (rows.delete(id)) released++
    },
    /** Drop entries outside `keep` (the two-complete-scans rule: keepIdsAfterScans); null keeps all. */
    prune(keep) {
      if (!keep) return
      for (const id of [...rows.keys()]) if (!keep.has(id)) rows.delete(id)
    },
    /** @returns {Map<string, { since: number, askedAt: number, kind: string }>} a copy, for tests */
    snapshot: () => new Map([...rows].map(([id, q]) => [id, { ...q }])),
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
 *   answers: Map<string, { canExec: boolean } | { unanswered: string } | { quarantined: true }>,  // the pre-screen, per row id;
 *                                   // a quarantined row is never walked (nor in the budget) unless expired
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
 * network | error>, scan-wrap (the scan's wrap read failed, A91 R2-4), prescreen-<failed>of<chunks>, joined by "+".
 * @param {{ scan?: string | number | null, wrap?: boolean, prescreenFailed?: number, prescreenChunks?: number }} p
 */
export function fallbackFlag({ scan = null, wrap = false, prescreenFailed = 0, prescreenChunks = 0 } = {}) {
  const parts = []
  if (scan !== null && scan !== undefined) {
    const s = String(scan)
    parts.push(`scan-${/^\d{3}$/.test(s) || s === "timeout" || s === "network" ? s : "error"}`)
  }
  if (wrap === true) parts.push("scan-wrap")
  if (Number.isInteger(prescreenFailed) && prescreenFailed > 0) parts.push(`prescreen-${count(prescreenFailed)}of${count(prescreenChunks)}`)
  return parts.length ? parts.join("+") : "none"
}

const FLAG_PART = "(scan-(\\d{3}|timeout|network|error|wrap)|prescreen-\\d+of\\d+)"
const FLAG_RE = new RegExp(`^(none|${FLAG_PART}(\\+${FLAG_PART})*)$`)

/**
 * The one per-cycle line (S-11). Counts and flags only — never an order id, an address, a signature or a URL;
 * every number is a validated non-negative integer, else "?". `quarantined` = rows in the pre-screen's
 * quarantine now (A91 R2-1).
 * @param {{ active: number|null, scanned: number, ready: number, attempted: number, carried: number, quarantined?: number, rotate: boolean, fallback?: string }} p
 */
export function activeScanLogLine({ active, scanned, ready, attempted, carried, quarantined = 0, rotate, fallback = "none" }) {
  const flag = FLAG_RE.test(fallback) ? fallback : "?"
  return `Active scan: active=${count(active)} scanned=${count(scanned)} true=${count(ready)} attempted=${count(attempted)} carried=${count(carried)} quarantined=${count(quarantined)} rotate=${rotate ? "yes" : "no"} fallback=${flag}`
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
