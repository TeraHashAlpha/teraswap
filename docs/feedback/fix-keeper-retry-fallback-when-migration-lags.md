# Feedback — fix/keeper-retry-fallback-when-migration-lags

Closes **L-1** from the audit of PR #425. Branched off `origin/main` @ `0e0e76d` (the #425 merge).

## The defect, reproduced before changing anything

#425 moved the retry-cap decision onto `orders.consecutive_failures` and removed the Map from it
(`prevFailures: prev ? prev.count : 0` is gone from `handleExecutionFailure`). But
`readPersistedRetryState` reads an **absent** column as `0`, so against a database that has not
received migration `20260827190000` the base is `max(0, 0)` on every cycle. Run against the shipped
code at `0e0e76d`:

```
20 consecutive misses, columns ABSENT -> 1:retry 1:retry 1:retry … (×20)
cap ever fired? false
```

The cap did not fire at 8, or at 20, or ever — while the ops page said *"MAX_CYCLE_FAILURES is
process-memory only"*, i.e. claimed the pre-#425 behaviour. Both halves of L-1 confirmed: a deploy
in the wrong order was **strictly worse** than before #425, and the alert asserted an invariant that
was not true. This is pinned permanently as the first test in the new file ("REGRESSION PIN: the
shipped #425 decision (no prevFailures at all) never fires the cap"), so the fix cannot be
re-broken silently and the acceptance-1 test below is provably not vacuous.

## How the fallback state is DETECTED

`patchOrderRow` was already the only place that distinguishes the two schema states; it is now also
the sensor, so nothing new probes the database and no extra round-trip is added:

- **→ missing:** the existing specific HTTP 400 — `res.status === 400 && hadRetryState &&
  /consecutive_failures|last_attempt_at/.test(body)` — now also calls
  `retryStateAvailability.markMissing()`.
- The state starts **optimistic** (`available = true`). The migration is merged, so "present" is the
  overwhelmingly common state, and the first rejected write flips it within one cycle. The single
  miss that happens before the flip is counted as `1` either way, so the ladder loses nothing —
  the sequence is still exactly `1,2,3,4,5,6,7,8`.

## How it is CLEARED (no latch, no restart)

- **→ present:** in the `res.ok` branch, `if (hadRetryState && !retryStateAvailability.isAvailable())
  → markPresent()`. A write that carried the columns and was **accepted** is proof the migration is
  applied, and it is the only thing accepted as proof.
- `hadRetryState` is load-bearing: a status-only patch (`updateOrderStatus`, every defer site) never
  reaches `patchOrderRow` at all, and the **stripped re-send** inside the failure branch carries no
  columns either — so neither can clear the state by succeeding. Pinned by a source anchor and by a
  behavioural test ("only a write that CARRIED the columns may clear the fallback"), and probed:
  removing the `hadRetryState &&` gate fails the anchor.
- The alert latch lives **inside** the same state object and resets on `markPresent()`, so it is
  once-per-**outage** rather than once-per-process. A rollback or a failover to a replica without
  the migration pages again instead of being swallowed by a stale one-shot flag.

## How the Map is kept OUT of the normal path

One gated helper, `prevFailuresForDecision({ columnsAvailable, cached })`, is the only route from
the Map into the decision:

- columns **available** → returns `0`. `planFailureHandling` takes `max(persisted, prevFailures)`,
  so `0` means the decision provably follows the row and the Map *cannot* raise it.
- columns **missing** → returns the cached count, i.e. exactly the pre-#425 behaviour.

The `retry-cap-restart.test.mjs` anchor from #425 asserted the Map was absent from
`handleExecutionFailure` outright. That rule was simultaneously too strong (it forbade the only
correct degradation) and too weak (it permitted the cap to vanish). It is now **narrower, not
weaker**: the Map may appear only as `prevFailures: prevFailuresForDecision({ columnsAvailable:
retryStateAvailability.isAvailable(), … })`, and a regex with a negative lookahead rejects any
ungated `prevFailures: prev…` / `prevFailures: orderRetries…` shape. Probed: restoring the old
ungated line fails the anchor.

## The new alert text, verbatim

```
orders.consecutive_failures / last_attempt_at are MISSING — apply supabase/migrations/20260827190000_add_orders_retry_state.sql. The retry cap has FALLEN BACK to the in-memory count: it still fires after MAX_CYCLE_FAILURES consecutive misses within a single keeper process, but the count RESETS ON RESTART — the INC-2026-08-07-001 shape (516 reverts under a cap of 8 across 228 restarts). It returns to the persisted count automatically, with no restart, on the first successful write after the migration is applied.
```

Exported as `RETRY_STATE_COLUMNS_MISSING_ALERT` from `retry-policy.js` so the string the executor
sends and the string the test pins are the same object and cannot drift. Every claim it makes is
proven by a test in the same file (see acceptance 4), and a test asserts the false `"process-memory
only"` wording does not come back.

## Acceptance results

1. **Columns ABSENT ⇒ the cap still fires at `MAX_CYCLE_FAILURES` in one process** — the ladder is
   `[1,2,3,4,5,6,7,8]`, ends `fail` on attempt 8 with `min_output_unreachable`, `alert: true`,
   `dca_executed` untouched, and no phantom column written to the row. Paired with the regression
   pin above (un-fixed decision: never fires) and with the honest-weakness test (a restart *does*
   reset it — which is what the alert now says). ✅
2. **Columns PRESENT ⇒ the Map is not consulted** — both directions, since `max()` would mask one of
   them: row 2 / Map 5 ⇒ decision **3**, not 6 (the decisive case); row 5 / Map 2 ⇒ decision **6**,
   not 3. Plus row-at-cap-with-empty-Map ⇒ fails now, and `prevFailuresForDecision` returns `0` for
   every cache value when available. ✅
3. **Recovery mid-process, no restart** — three misses on the fallback (row holds nothing), migration
   applied while running, the next accepted write clears the state: count continues `4` (no reset,
   no double-count), the row now carries it, a poisoned Map of `99` is then ignored (row 4 → 5), and
   the recovered semantics survive a restart (→ 6). A second case walks `1..8` straight across the
   transition. ✅
4. **Alert text pinned verbatim** — exact string equality, plus a test asserting each claim maps to a
   test that proves it, plus one asserting the removed false claim stays removed, plus "fires ONCE
   per outage, not once per miss" (8 rejected writes → 1 page). ✅
5. **Keeper suite green; nothing else in the retry path changed** — `node --test`: **484/484**
   (88 suites), up from 463 on `main` (+21). `git status` shows only `executor.js`,
   `retry-policy.js`, `retry-cap-restart.test.mjs`, and the new test file. Verified untouched:
   `MAX_CYCLE_FAILURES`, the backoff constants, `resetRetryStateFields()` on both success patches,
   every `updateOrderStatus` defer site, the ADR-014(a) pinned-route exemption, the migration file,
   and `schema.sql`. ✅

## Concern — for the delta audit

- **The fallback is per-process, and that is the honest ceiling.** With the columns missing there is
  nowhere durable to put the count, so a keeper restarting faster than the ~62-minute backoff ladder
  still cannot reach 8 — the original INC-2026-08-07-001 shape. This branch restores the *previous*
  guarantee, it does not manufacture a new one; the alert now states that limitation explicitly
  instead of implying the cap is intact. The real fix remains "apply the migration", and the alert
  names it.
- **One miss is decided before the sensor learns.** The very first miss of an outage is planned
  before its own write is rejected. Harmless (that miss is `1` under either source of truth), but
  worth stating rather than leaving for a reader to re-derive.

## Edge case

- The backoff gate (`orderRetries.get(id) || readPersistedRetryState(dbOrder)`) is deliberately
  **unchanged**. It is a rate limiter, not the retry-vs-fail decision, it already prefers the Map
  when present, and #425 shipped and audited it in that shape — "nothing else in the retry path
  changes" applies.
- `prevFailuresForDecision` floors and clamps whatever the cache holds (`-3 → 0`, `"nine" → 0`,
  `2.7 → 2`), so a malformed cache entry can never widen the ladder.
