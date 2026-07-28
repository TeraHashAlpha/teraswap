# Feedback — FIX-DEPEG-GATE-RETRY-WINDOW (M-01)

## Mechanism chosen: `errorUpdateCount`, alongside the existing `failureCount` — both, not either

The spec offered `errorUpdateCount` **or** an own ref. I used `errorUpdateCount`, and kept
`failureCount` beside it, because neither counter alone covers both windows:

| window | `failureCount` | `errorUpdateCount` |
|---|---|---|
| first retry sequence, before any error is committed | **> 0** ✅ | 0 ❌ |
| after the poll's `'fetch'` wipes the counters | 0 ❌ | **> 0** ✅ |

`failureCount` is the only signal in the first window (query-core dispatches `'failed'` per attempt
and only dispatches `'error'` once retries are exhausted). `errorUpdateCount` is the only signal in
the second. Dropping either re-opens a window — verified by mutation, see below.

**Why the library cannot reset `errorUpdateCount`** — verified first-hand in the installed
`@tanstack/query-core@5.50.1`, not from memory:

- `fetchState()` (`query.js:346-356`) — applied on **every** `'fetch'` action — returns
  `fetchFailureCount: 0`, `fetchFailureReason: null`, `fetchStatus`, and, when `data === undefined`,
  also `error: null, status: 'pending'`. **`errorUpdateCount` is not among the fields it returns.**
- `errorUpdateCount` is written in exactly two places: `state.errorUpdateCount + 1` on the `'error'`
  action (`query.js:318`) and `0` in `getDefaultState()` (`query.js:366`, initial construction only).
  It is monotonic for the life of the cache entry.
- It reaches us because `queryObserver.js:326` maps it onto the observer result, so wagmi's
  `useReadContract` surfaces it unchanged.

**Why not an own ref.** A `useRef` is per-mount, so it resets on remount while the *query cache* —
and therefore the failure history — persists; the two have mismatched lifetimes, and the ref is the
shorter one. `errorUpdateCount` is scoped to the same cache entry as the failure it records, which is
the correct lifetime for this decision. A ref would also have to be written during render.

## Where the fix lives

The predicate is a pure, exported function in `depeg-gate.ts` (`hasReadFailed`) rather than an inline
expression in the hook — so the single most security-relevant line in this change is unit-testable
without React, and its rationale sits next to `PENDING`/`UNVERIFIED` where a future reader will find
it. The hook keeps only the composition.

## Recovery semantics — worth stating explicitly

Because `errorUpdateCount` never decreases, the gate can **never** reopen via the failure memory
going false. It reopens only when all four reads carry `data` and execution falls through to
`evaluateDepeg` — i.e. mechanically, "only a completed successful read transitions back", which is
requirement 1 stated as code rather than as a comment. Two tests pin this, including one asserting
that recovered data still yields a *real* verdict (a depeg in it blocks) rather than a rubber stamp.

## Verification

The audit's runtime reproduction is now a table-driven test replaying the exact 9-frame observer
sequence query-core emits during a sustained outage. **Mutation-verified:** reverting `hasReadFailed`
to the pre-fix `failureCount`-only logic fails **5 tests** — including `the exact regressed frame`
and `stays blocked across EVERY step of a sustained outage`. Before this change, that frame returned
`'pending'` and nothing caught it.

Suite: 3050 passed (+10). `tsc` clean bar the 2 known pre-existing errors; lint 0 errors, 121
warnings (baseline unchanged — the `Date.now()`-during-render purity warning at
`useDepegCheck.ts:121` is pre-existing and untouched).

## Not addressed here (still open from the same audit)

- **L-01** — `isError` short-circuits before the in-hand data check, so a failed *background* refetch
  blocks even while valid in-heartbeat data is retained. Untouched: it is the fail-*safe* direction,
  and the spec scoped this branch to the fail-*open* window only.
- **L-02** — `useChainlinkPrice.ts:54-56` has the same fail-open defect with a wider blast radius.
  Explicitly out of scope per the spec (separate queued work); still the recommended next follow-up.
- **L-03 / L-04** — depeg gate unreachable from the conditional-order panels; `refetchInterval`
  itself still has no direct test (this change tests its *consequence*, not the option's presence).
