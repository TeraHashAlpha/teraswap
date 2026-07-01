# CHORE-DCA-DEVIATION-GUARD

Branch: `chore/dca-deviation-guard` (off `origin/main`). No Auditor. Architect review before merge.

## Context

DCA fills execute through **one pinned aggregator** — the EIP-712-signed `order.router` (Velora/Augustus
V6 on Base), resolved by `sourceForRouter()` and enforced by the `tx.to === order.router` guard in
`fetchSwapRoute()`. This is deliberate (`chore/dca-router-chainaware`): the contract approves + calls exactly
that router, so the keeper is NOT free to switch to a best-of-N winner per fill. The trade-off is that a
pinned router can, on a given cycle, quote a materially worse output than the best cross-aggregator route —
and the keeper today has no visibility into that: `fetchSwapRoute()` returns `{ data }` and **discards**
`data.toAmount`, so the committed router's expected output is never even observed.

DCA is **market-price-neutral by design** — it buys on schedule regardless of price, and this chore does NOT
change that. What it adds is an **execution-QUALITY** gate: when the committed route is materially worse than
the best available cross-aggregator quote, DEFER the fill by a bounded amount of time (giving the pinned
router's liquidity a chance to normalise), then execute anyway when the window elapses. It never fails, never
switches aggregators, never blocks the buy — it only nudges *when within a small window* a scheduled chunk
lands, purely to avoid executing into a transient bad quote.

This must stay strictly separate from the `#246` real-failure path (`retry-policy.js`): a DEFER is not a
failure and must not consume the `MAX_CYCLE_FAILURES` budget, mark the order `failed`, or page anyone.

## Objective

A pure, never-throwing keeper module `contracts/order-engine/executor/deviation-guard.js` (+ unit test) and a
minimal wiring into `executor.js` / `swap-route.js` that, **for DCA orders only**, compares the committed
router's expected output against the best cross-aggregator quote and DEFERS a materially-deviated fill within
a bounded `[due, due + windowFraction·interval]` window — fail-open, defer-not-fail, market-neutral.

## Requirements

1. **Cross-aggregator reference via `/api/quote` best-of-N.** Obtain the competitive benchmark from the same
   unconstrained meta-quote the instant swap uses — `buildQuotePath(...)` in `swap-route.js` → GET `/api/quote`
   → `{ all:[...], best:{ source, toAmount, ... } }`. Add `fetchBestQuote(tokenIn, tokenOut, amount, chainId,
   srcDecimals, dstDecimals)` in `executor.js` that returns `json.best?.toAmount` as a string, or `null` on any
   error/timeout/missing field. This reference is **observational only** — it does NOT change `order.router`,
   the `sourceForRouter` constraint, or the `tx.to === order.router` fund-flow guard.

2. **Deviation formula + `DCA_DEVIATION_THRESHOLD = 0.01` (1%).**
   `computeDeviation(bestOut, committedOut) = (best − committed) / best`, accepting decimal wei
   strings/bigints. If `best <= 0` or either input is unparseable → return `0` (treated as not deviated →
   execute; fail-safe). If `committed > best` (the pinned router is actually better) → negative → not deviated.
   A fill is "deviated" when `deviation > threshold`, i.e. the committed route is more than 1% worse than best.

3. **Bounded window `[due, due + 0.25·interval]` with four outcomes + a sub-poll floor.** The deferral window
   opens at the chunk's SCHEDULED due time and is `windowFraction · intervalSec` long (default 25% of the DCA
   interval). `decideDcaExecution(...)` resolves to exactly one of four outcomes:
   - **no reference** (`!referenceAvailable`) → `execute` (fail-open; see req. 5).
   - **window shorter than one poll cycle** → `execute` — FLOOR: if `windowLen < pollIntervalSec` (or
     `dueSec == null` / non-finite), a defer could never re-fire before the window elapses anyway, so don't
     defer. Reason `"window shorter than one poll cycle"`.
   - **not deviated** (`deviation <= threshold`) → `execute`, reason `"route competitive"`.
   - **deviated within window** (`nowSec < windowEnd`) → `defer`, reason `"deviated within window"`.
   - **deviated, window elapsed** (`nowSec >= windowEnd`) → `execute` with `atWindowEnd: true`, reason
     `"window elapsed; executing anyway"` (buy still happens — market neutrality preserved).
   Due time comes from `dcaDueSec(dbOrder)`: first chunk (`dca_last_exec` null) is due at
   `floor(created_at/1000)`; subsequent chunks at `floor(dca_last_exec/1000) + Number(dca_interval)` — mirroring
   the contract's `dcaLastExecution[hash]` semantics (starts at 0 → first chunk due at creation).

4. **Defer ≠ fail; NOT counted toward the `#246` cap.** The defer path is entirely separate from
   `retry-policy.js`. On a `defer` decision the keeper logs a DEFER line, unlocks the order back to `active`
   (`updateOrderStatus(dbOrder.id, "active")`), increments `skipped++`, and `continue`s. It MUST NOT touch the
   `orderRetries` Map, MUST NOT call `handleExecutionFailure`, MUST NOT set status `failed`, and MUST NOT emit
   a failure alert. A deferred chunk simply retries on a later poll like any un-due order.

5. **Fail-open on a missing reference.** Any inability to obtain a trustworthy comparison → execute. This
   includes: `!API_URL`, `/api/quote` HTTP error/timeout/parse failure, missing `best.toAmount`, and a missing
   `swapData.toAmount` (committed out). `referenceAvailable = bestOut != null && swapData.toAmount != null`;
   when false, `deviation = 0` and `decideDcaExecution` returns `execute` before any deviation test. The guard
   can never PREVENT a DCA buy — worst case it is a no-op.

6. **Operational: bounded timeout, cheap, no double-execution.** `fetchBestQuote` uses a 5s `AbortController`
   timeout and returns `null` on abort. The gate runs once per DCA order per cycle, AFTER `canExecute` +
   route-fetch + `routerDataHash` verify (so we only spend the extra quote on an order that would otherwise
   execute right now) and BEFORE the gas-tier/send block. Add NO heavy dependencies. The gate either continues
   to the existing single send path or defers+continues — it never introduces a second send.

7. **Env config.** Two operator knobs, both range-guarded with safe fallbacks, read once at module load:
   - `DCA_DEVIATION_THRESHOLD` — default `0.01`; clamp to `[0, 1]`, fallback `0.01` on unparseable/out-of-range.
   - `DCA_DEVIATION_WINDOW_FRACTION` — default `0.25`; clamp to `(0, 1]`, fallback `0.25`.
   Document both in the executor env docs alongside `POLL_INTERVAL_MS`, `MAX_CYCLE_FAILURES`, etc.

8. **Observability: logs + advisory, non-paging Telegram note.** On `defer`, log a clear single line with the
   order id, deviation %, and window. On the `atWindowEnd` execute, log an "executing anyway at window end still
   deviated" line AND fire an ADVISORY note via `alertOps({ kind: "dca-deviation", detail: ... }, 0)` — score
   `0` → `scoreTier` `info` → no escalation tail → non-paging. Wrap it in `try { … } catch {}` (it never throws
   anyway). No alert on the ordinary competitive/deferred paths.

## Do NOT

- Change the contract, the pinned-router model, or the `sourceForRouter` / `tx.to === order.router` guard.
- Switch aggregators per fill, or use the best-of-N `best.source` for the actual swap — the reference quote is
  observational ONLY; the send still uses the committed `order.router` calldata (`swapData.data`) unchanged.
- Block, fail, or mark an order `failed` on deviation — DEFER within the window, then execute.
- Treat a missing/errored reference as a reason to hold — fail-open (execute).
- Touch `orderRetries`, call `handleExecutionFailure`, or emit a failure/paging alert on the defer path
  (`#246` is the REAL-failure path and stays untouched).
- Alter DCA market-price neutrality — a deviated chunk still buys when the window elapses; the gate only shifts
  timing within a small bounded window, never skips a buy.
- Overlap the next chunk or exceed expiry — the expiry pre-filter already runs first in `executeCycle`; leave
  it. The window floor (`windowLen < pollIntervalSec`) and `windowFraction <= 1` keep the defer inside the
  interval.
- Double-execute, add heavy dependencies, use `Date.now()` inside the pure functions (pass `nowSec` in), or let
  any new function throw.

## Files affected

- `contracts/order-engine/executor/deviation-guard.js` — NEW pure module. Exports:
  `DCA_DEVIATION_THRESHOLD`, `DCA_DEVIATION_WINDOW_FRACTION`, `computeDeviation(bestOut, committedOut)`,
  `dcaDueSec(dbOrder)`, `decideDcaExecution({ deviation, threshold, nowSec, dueSec, intervalSec, windowFraction,
  pollIntervalSec, referenceAvailable })`. Mirror `retry-policy.js` header + JSDoc comment style; ESM; never
  throws.
- `contracts/order-engine/executor/deviation-guard.test.mjs` — NEW `node:test` suite (run via `node --test`),
  same shape as `retry-policy.test.mjs`. Cover: deviation math (positive/negative/zero/unparseable/`best<=0`),
  `dcaDueSec` (first chunk vs subsequent vs unparseable), and all four `decideDcaExecution` outcomes + the
  sub-poll floor + the fail-open branch.
- `contracts/order-engine/executor/swap-route.js` — no signature change to `buildQuotePath`; it is the source of
  the `/api/quote` path used by `fetchBestQuote`. (Referenced, not necessarily edited.)
- `contracts/order-engine/executor/executor.js` — extend `fetchSwapRoute` to return
  `{ data: data.tx.data, toAmount: data.toAmount ?? null }` (existing `swapData.data` callers unchanged); add
  `fetchBestQuote(...)`; insert the DCA-only gate block AFTER the `routerDataHash` verify and BEFORE the
  `// ── Gas Strategy: tier-based execution ──` comment.
- Executor env docs (the `TERASWAP_API_URL` / `CHAIN_ID` env block at the top of `executor.js`, and any
  `.env.example` / keeper README) — document `DCA_DEVIATION_THRESHOLD` and `DCA_DEVIATION_WINDOW_FRACTION`.
- `.github/workflows/keeper-tests.yml` — ensure the new `deviation-guard.test.mjs` is picked up by the existing
  `node --test` glob (add a guard entry only if the suite is not already covered).

## Design (illustrative signatures only — no implementation in this doc)

```js
// deviation-guard.js (pure; never throws; nowSec passed in — no Date.now here)
export const DCA_DEVIATION_THRESHOLD        // clamp([0,1], env DCA_DEVIATION_THRESHOLD, default 0.01)
export const DCA_DEVIATION_WINDOW_FRACTION  // clamp((0,1], env DCA_DEVIATION_WINDOW_FRACTION, default 0.25)

export function computeDeviation(bestOut, committedOut) // → Number (best−committed)/best; 0 if best<=0/NaN
export function dcaDueSec(dbOrder)                        // → int unix seconds | null
export function decideDcaExecution({
  deviation, threshold, nowSec, dueSec, intervalSec, windowFraction, pollIntervalSec, referenceAvailable,
}) // → { action: 'execute'|'defer', atWindowEnd: boolean, deviated: boolean, reason: string }
```

`decideDcaExecution` logic ORDER: (1) `!referenceAvailable` → execute (fail-open); (2) `windowLen =
windowFraction·intervalSec`, `windowEnd = dueSec + windowLen`; if `windowLen < pollIntervalSec` /
`dueSec == null` / non-finite → execute (floor); (3) `deviated = deviation > threshold`; if not deviated →
execute; (4) deviated & `nowSec < windowEnd` → defer; else → execute with `atWindowEnd: true`.

Wiring in `executeCycle` (DCA only, after `routerDataHash` verify):

```js
const dueSec = dcaDueSec(dbOrder)
const bestOut = await fetchBestQuote(orderStruct.tokenIn, orderStruct.tokenOut, netAmount, CHAIN_ID, srcDecimals, dstDecimals)
const referenceAvailable = bestOut != null && swapData.toAmount != null
const deviation = referenceAvailable ? computeDeviation(bestOut, swapData.toAmount) : 0
const decision = decideDcaExecution({
  deviation, threshold: DCA_DEVIATION_THRESHOLD, nowSec: Math.floor(Date.now() / 1000), dueSec,
  intervalSec: Number(orderStruct.dcaInterval), windowFraction: DCA_DEVIATION_WINDOW_FRACTION,
  pollIntervalSec: POLL_INTERVAL_MS / 1000, referenceAvailable,
})
// decision.action === 'defer'  → log DEFER, updateOrderStatus(id,'active'), skipped++, continue
// decision.atWindowEnd         → log + alertOps({kind:'dca-deviation', ...}, 0) [try/catch], then fall through
// else                          → execute normally (unchanged send path)
```

## Expected output

- `node --test` green for `deviation-guard.test.mjs` (and the rest of the keeper suite), CI `keeper-tests` job
  green.
- On a competitive route: identical behaviour to today (execute).
- On a deviated route inside the window: a DEFER log line, the order returned to `active`, `skipped++`, no
  failure/alert, no `orderRetries` mutation — the chunk retries a later cycle and lands once the router
  normalises or the window elapses.
- On a deviated route at window end: the buy still executes (unchanged send path) + one advisory, non-paging
  Telegram note.
- On any missing/errored reference: execute (fail-open) exactly as before.

## Quality criteria

- Every new function is pure/fail-safe and NEVER throws; the pure module takes `nowSec` (no `Date.now()`
  inside it).
- The defer path is provably disjoint from `#246`: no `orderRetries`/`handleExecutionFailure`/`failed`/failure
  alert on defer.
- Market neutrality preserved: no code path skips a scheduled buy; the window is bounded to
  `windowFraction · interval` and floored at one poll cycle, so a defer cannot overlap the next chunk or push
  past expiry.
- The pinned-router fund-flow model is untouched: the reference quote is observational; the send still uses
  `swapData.data` for the signed `order.router`, with the `tx.to === order.router` guard intact.
- New comments tagged `[chore/dca-deviation-guard]`, matching surrounding style/comment density; no new
  dependencies; env knobs documented and range-guarded.
