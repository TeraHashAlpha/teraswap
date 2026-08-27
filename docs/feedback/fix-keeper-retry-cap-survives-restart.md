# Feedback — fix/keeper-retry-cap-survives-restart

Closes the part of INC-2026-08-07-001 that was never asked: order `ef85438b` reverted 516 times
against a structurally unattainable signed minimum while `MAX_CYCLE_FAILURES` (default 8) was
supposed to stop it at eight. The pricing CAUSE was fixed on `fix/signing-min-price-integrity`;
this branch fixes the BOUND. Line numbers below are `origin/main` @ `c26ccdf` before this change.

---

## Task 1 — diagnosis (before any change)

### Q1. Does a repeated on-chain minimum-output revert on a DCA chunk reach `handleExecutionFailure` and increment `orderRetries`?

**Yes.** Traced path, quoting the code:

1. `executor.js:1672` — `txWalletClient.writeContract({ ... functionName: "executeOrder", ... })` is
   called **without a `gas` field**, so viem runs `eth_estimateGas` first. The contract's per-chunk
   floor check reverts there — `TeraSwapOrderExecutorV3.sol:526` `scaledMin = (order.minAmountOut *
   executeAmount) / order.amountIn`, `:541` `floorOut = scaledMin` (max with the oracle floor), `:610`
   `revert InsufficientOutput()`. That is why the incident saw "every attempt died in simulation, nonce
   stayed at 14": the throw happens before any tx is signed.
2. The throw lands in the `catch (err)` at `executor.js:1785`. `extractRevertData(err)` →
   `decodeSwapFailed(revertData)` returns **null** (the revert is the executor's own error, not
   `SwapFailed(bytes)` — the router call succeeded; the post-swap floor check failed) →
   `decodeExecutorMarketRevert(revertData)` matches selector `0xbb2875c3` → `executorErrorName =
   "InsufficientOutput"`, `swapReason = null` (`:1798-1812`).
3. `executor.js:1832`:
   ```js
   if (dbOrder.order_type !== "dca" && isMarketRevert({ swapReason, executorErrorName })) {
   ```
   For a DCA row the first operand is `false`, so the **pinned-route branch is skipped by
   construction** — `pinnedRouteReverts` (`:279`) is never touched for DCA. The other two non-counting
   paths cannot be reached either: the gas-price defer (`:1630`, `if (!gasTier.execute)`) and the
   oracle-floor delay-not-drain (`:1497`) both sit **before** `writeContract` and compare the *built
   quote* against gas tiers / the reference price — the built quote was at market (~1.2e15), so both
   gates passed; neither inspects the *signed* `minAmountOut`, and nothing in the keeper pre-checks
   the signed floor (`minAmountOut` appears only in the ABI and in the struct build at `:1298`).
4. `executor.js:1864` — `await handleExecutionFailure(dbOrder, { err, swapReason }, obsCtx)`.
   Note `executorErrorName` is **not** passed — the handler cannot tell a floor revert from any other
   transient miss.
5. `executor.js:625-634` — `const prev = orderRetries.get(dbOrder.id)` → `planFailureHandling({ ...,
   prevFailures: prev ? prev.count : 0 })`. In `retry-policy.js:232-238`, `classifyFailure` sees the
   text `insufficientoutput()` which matches **none** of `PERMANENT_SIGNATURES` (`:57-82`) → transient
   → `failures = prevFailures + 1` → `nextRetryDecision` (`:138-146`) → `retry` while `failures < 8`,
   `fail` with `no_route_after_retries` + one-shot alert at 8.
6. `executor.js:660` — `orderRetries.set(dbOrder.id, { count: plan.failures, lastAttempt: Date.now() })`.

So the counter **is** incremented on every one of these reverts. The path is the ordinary failure
ladder. The cap was reached — the incident (§1) confirms the order left the active set "via the
retry-cap fail path" — it was just reached far too late.

### Q2. `orderRetries` is an in-memory `Map` (`:275`). With 228 restarts, what happens to the count?

`executor.js:275` — `const orderRetries = new Map()` — module scope, process memory only; the
comment at `:273-274` even says so: *"In-memory only (resets on keeper restart — see FEEDBACK)"*.
Nothing about the count is persisted: the transient-miss patch is `retry-policy.js:176-178`
`buildOrderActivePatch` → `{ status: "active", updated_at }`; the row never learns how many times it
missed. On every restart, therefore:

- `orderRetries.get(id)` is `undefined` → `prevFailures: 0` → the next miss is counted as **1/8**.
- The backoff gate at `:1210-1212` also reads only this Map → no `retryState` → the order is attempted
  on the **first poll after boot** with no backoff, and the backoff ladder restarts at 30 s.

Quantified: the effective cap is `min(8, attempts in one process lifetime)`. Reaching 8 in one
lifetime needs the full backoff ladder — attempts at t=0 and after 30 s, 60 s, 120 s, 240 s, 480 s,
960 s, 1800 s (`backoffMs`, `retry-policy.js:154-158`), i.e. the 8th attempt lands at
**≥ 3690 s ≈ 61.5 min** of uninterrupted uptime (a little more, since each wake is rounded up to the
30 s poll). 516 reverts across 228 restarts is a mean of **2.26 attempts per lifetime**; any lifetime
shorter than ~62 min could never trip the cap. The order only failed when one process finally stayed
up long enough to count to 8 on its own. Had the count survived restarts, the order would have
stopped after attempt 8: **508 of the 516 reverts (98.4 %) were the counter being reset**, not the
cap being too high.

### Verdict

The reverts DO reach the counter → persisting the counter **is** the right fix. The pinned-route
exemption at `:277` was not involved (DCA is excluded from it at `:1832`), so it is left intact and
no separate bound is added there — see Task 2 below for what was bounded and why.

---

## Task 2 — which path was bounded, and why

**Bounded: the ordinary failure ladder** (`handleExecutionFailure` → `planFailureHandling`), because
Task 1 shows that is the path the incident's reverts took. The pinned-route exemption at `:277`/`:1832`
(ADR-014 a) is **untouched** and **no separate bound was added there**: DCA never enters that branch
(`dbOrder.order_type !== "dca"`), so it was not the incident's path; bounding it would change a
protection the incident never exercised.

How the cap now survives a restart:

- **Migration** `supabase/migrations/20260827190000_add_orders_retry_state.sql` (skill
  `.claude/skills/supabase-migration.md`: timestamped snake_case, idempotent, COMMENT, rollback block;
  no new table ⇒ no new RLS; no index because neither column is in a WHERE/JOIN/ORDER BY). Adds
  `orders.consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (>= 0)` and `orders.last_attempt_at
  TIMESTAMPTZ`. Mirrored into `contracts/order-engine/schema.sql` (the keeper's own DDL — the `orders`
  table is **not** in `supabase/schema.sql`), with the same constraint name so migrate-over-mirror
  yields one constraint, not two.
- **The DECISION reads the row.** `planFailureHandling` derives its base from
  `dbOrder.consecutive_failures` (`readPersistedRetryState`); `handleExecutionFailure` no longer reads
  `orderRetries` at all. Every ladder patch (retry and fail) writes `consecutive_failures` +
  `last_attempt_at`; both success patches (DCA chunk, Limit/SL fill) spread `resetRetryStateFields()`
  (`consecutive_failures: 0`). `fetchActiveOrders` uses `select=*`, so the row the keeper holds each
  cycle already carries the count and each order is attempted at most once per cycle — the row is as
  fresh as the Map was.
- **Backoff survives too.** The cycle gate now does `orderRetries.get(id) || readPersistedRetryState(dbOrder)`
  + `isInBackoffWindow` (same `backoffMs` ladder), so a restarted keeper does not hammer a mid-ladder
  order on its first poll — the second half of the Q2 finding.
- **The Map stays as a same-process backoff cache only.** The pinned-route path still writes it for
  backoff reuse but never persists a count, so it can never feed the ladder. (Side effect worth
  naming: pre-fix, the pinned path's `orderRetries.set(count = consecutiveReverts)` at `:1855` DID
  seed `prevFailures` for a later non-market error on the same order — 50 pinned reverts then one RPC
  blip would have failed the order immediately. Reading the row instead closes that incidentally;
  pinned by acceptance-2 test "…a later NON-market error starts the ladder at 1, not at 51".)
- **Deploy-order safety.** New `patchOrderRow` helper: if PostgREST rejects the two columns (HTTP 400
  naming them — migration not yet applied), it re-sends the patch **without** them so the status
  transition still lands (an order that should be `failed` must not sit in `executing` until the
  stale-unlock resurrects it and it retries forever) and pages ops ONCE per process (`schema-drift`).
  Until the migration is applied the keeper degrades exactly to today's behaviour. Any other non-2xx
  on an orders PATCH is now logged (it was silently ignored before — for the ladder AND the success
  patches).

Not changed: `MAX_CYCLE_FAILURES` default, `RETRY_BACKOFF_*`, any signing/derivation code, the pinned
tracker, the defer paths (`updateOrderStatus` still writes `status` + `updated_at` only — pinned by
a source anchor).

## Task 3 — naming the state

New terminal reason `FAILURE_REASON.MIN_OUTPUT_UNREACHABLE = "min_output_unreachable"`, emitted when
the cap is reached and the cap-tripping miss was the executor's **own** `InsufficientOutput()`
(`isFloorRevert`: `executorErrorName === "InsufficientOutput"` from `revert-decode.js`, or the
ABI-decoded text `InsufficientOutput()`). `executorErrorName` — already computed in the catch — is now
forwarded to `handleExecutionFailure`. Deliberately narrow: a ROUTER min-out revert inside
`SwapFailed` ("Too little received", `INSUFFICIENT_OUTPUT_AMOUNT`) is slippage on keeper-built
calldata, a route condition, and stays `no_route_after_retries`; `PriceConditionNotMet` is a trigger,
not a floor. Below the cap a floor revert is an ordinary transient retry — the floor may be merely
tight. The keeper stops and records why; it **never cancels** and never moves funds (asserted).

UI: `failed-reason.ts` gains the `min_output_unreachable` label ("…the minimum is above what the market
can deliver… Cancel this order and re-create it with a realistic minimum") — `OrderDashboard` renders
`failedOrderReason(order.error)` so it surfaces with no other UI change.

**Sync enforcement, both directions, both suites:** `failed-reason.test.ts` imports the keeper's
`FAILURE_REASON` directly (ESM; `allowJs` is on) and asserts set equality with
`FAILURE_REASON_LABELS`; `retry-policy.test.mjs` parses `failed-reason.ts` and asserts the same, so
the keeper's own CI workflow fails too.

## Acceptance results

1. **Cap holds across a restart** — `retry-cap-restart.test.mjs`: 4 `InsufficientOutput` misses,
   restart, 3 more retry, the **8th overall fails** (`status=failed`, `error=min_output_unreachable`,
   `consecutive_failures=8`, `dca_executed` untouched); scanned for every restart point 1..7 (plus a
   double restart) and for a restart before **every** cycle (the 228-restart shape) — always 8, never
   516. A **regression pin** models the pre-fix cache-only count and shows 4 + restart + 4 = still
   `active`, so the passing test is provably discriminating. Backoff-after-restart and fill-resets-count
   are asserted too. ✅
2. **Pinned-route revert never walks the ladder** — 50 consecutive pinned reverts on a Limit order:
   `keepActive` every time, persisted count stays 0, alert from the 5th; after a restart a later
   non-market error starts at 1/8. Source anchors: the branch is still `!== "dca"`-guarded, unlocks via
   `updateOrderStatus(…,'active')`, contains no `handleExecutionFailure`/`planFailureHandling`/
   `patchOrderRow`/`consecutive_failures`; `pinnedRouteReverts` Map still declared. ✅
3. **A defer counts as zero** — 20 defers ⇒ persisted count 0, `last_attempt_at` null, not in backoff,
   next real miss is 1/8. Source anchors on all four defer sites (gas-tier, DCA deviation, oracle-floor
   delay-not-drain, submission-refused) + `updateOrderStatus`'s exact body. ✅
4. **Sync test fails on divergence** — demonstrated live in both directions (each side mutated with a
   probe key, both suites run, files restored byte-identical): keeper suite `58 pass / 1 fail`
   ("FAILURE_REASON (keeper) and FAILURE_REASON_LABELS (UI) have diverged") and app suite 2 fails
   (keeper-only code) / 3 fails (UI-only label). ✅
5. **Suites + migration** — keeper `node --test`: **463/463** (was 419; +44). App `vitest run`:
   **227 files / 3251 tests** green; `tsc --noEmit` exit 0; eslint clean on the changed TS files.
   Migration on a throwaway `postgres:15.19` (Docker): applied over origin/main's pre-migration
   `orders` DDL ✓, re-applied idempotently ✓ (NOTICEs only), columns/types/default/NOT NULL as
   specified ✓, named CHECK rejects −1 ✓, 2 COMMENTs ✓, RLS still enabled ✓, mirrored `schema.sql` +
   migration ✓, ROLLBACK block from the comment ✓. ✅

## Feedback — FIX-RETRY-CAP-RESTART

### Concern — ops sequencing (for the Auditor / owner)
- Apply the migration to the live Supabase project **before** restarting the keeper on this code
  (pm2 restart is still required after merge, as for every keeper change). The keeper tolerates the
  reverse order (fallback + one-shot `schema-drift` alert), but until the columns exist the cap is
  process-memory only — i.e. the incident's exposure.
- A pre-existing DCA row that is mid-ladder at deploy time starts from `consecutive_failures = 0`
  (column default). Acceptable: it is the last time the count will reset.

### Edge case
- The cap failure is named from the **cap-tripping** miss only (no per-kind history is persisted): 7
  floor reverts then one no-route blip reports `no_route_after_retries`. Persisting a last-failure-kind
  column would fix that; deliberately not added — it is outside the two columns the goal specified,
  and the mixed case is rare next to the incident's 516-identical shape.
- `error` is only written by fail/expired patches; the transient ladder never writes it, so an active
  order's `error` stays null as before.

### Assumption that turned out wrong
- The `orders` DDL is not in `supabase/schema.sql` (which has swaps/quotes/security_events/…); it is
  `contracts/order-engine/schema.sql`. The mirror went there.
- The Sonatype MCP (`sonatype-guide`) requires authentication this session lacks, so I did **not**
  install `@electric-sql/pglite` for the schema check; I used the official `postgres:15` image on the
  already-installed Docker Desktop instead (started it, ran the checks, removed the container, quit it
  — it was not running before).

### Test gap (pre-existing, unchanged)
- `executor.js` auto-runs `main()` on import, so its wiring is pinned by source anchors rather than
  executed — the same technique `env-order.test.mjs` / `arbitrum-plumbing.test.mjs` already use. An
  importable `runCycle` would let acceptance 1 run against the real handler.
