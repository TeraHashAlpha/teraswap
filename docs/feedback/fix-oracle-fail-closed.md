# Feedback — FIX-ORACLE-FAIL-CLOSED

## Assumption that turned out wrong

- The spec located `useActiveChainId()` at `src/lib/useChainId.ts:16`; it actually lives at
  `src/hooks/useChainId.ts:16`. No `src/lib/useChainId.ts` exists.

## Edge case not covered by the spec — and the sharpest risk in this change

- The spec lists "missing feed" as an UNVERIFIED trigger. Read literally as "no exchange-rate pair",
  that would hard-block **every swap in the app**: only cbETH-on-Base has a pair today, so virtually
  every swap resolves "no pair". The implementation therefore draws an explicit line the spec did
  not: **"the check does not APPLY" (no pair → `ok`, frictionless) is distinct from "the check
  applies and we could not run it" (→ `unverified`, blocking).** "Missing feed" is read as a
  registered pair with an incomplete feed address — structurally impossible with today's registry
  types, handled defensively anyway. This distinction is load-bearing; conflating the two states is
  the one change that would take the app down. It is asserted directly in
  `useDepegCheck.test.ts` ("does not apply is NEVER conflated with could not verify").

## Design note — a fourth state, not a third

- The spec asked for one new state (UNVERIFIED) and separately required that in-flight not block.
  Satisfying both without a `pending` state means in-flight has to be represented as `ok` — i.e.
  "still checking" and "checked, healthy" become the same value. That is the exact shape of the bug
  being fixed, so `pending` was made explicit rather than left implicit. `pending` is frictionless
  (identical observable behaviour to today's first render); `unverified` blocks.

## Security concern discovered during implementation — out of scope, needs triage

- **`src/hooks/useChainlinkPrice.ts:54-56` has the same fail-open defect.** A *read error* (not just
  a stale round) leaves `roundData` undefined, and the hook returns `level: 'none'`,
  `oracleUnavailable: false`, `message: null` — indistinguishable from "not loaded yet". In
  `SwapBox` that silently disables **both** the Chainlink deviation gate and the `oracleBlocked`
  >$10k unpriceable gate: a failing feed reads as "no oracle concern" rather than "no oracle
  answer". This is the same root cause and arguably a wider blast radius than the depeg check, since
  it affects every pair with a feed, not just cbETH. Left untouched per the spec's "do not widen
  into a general error-handling refactor" — **recommend it as the immediate follow-up.**

## Other fail-open paths reviewed and deliberately left alone

Not defects — each is fail-open by design and correctly so:

- `lib/order-engine/economic-floor.ts:57`, `dca-custom.ts:101` — client-side mirrors; the server is
  the authoritative gate and fails *closed* there.
- `lib/order-engine/check-route.ts`, `check-oracle.ts`, `oracle-coverage.ts` — advisory UX notes, not
  gates; blocking on an infra blip would be the worse failure.
- `lib/monitoring-loop.ts`, `cow-fee-monitor.ts`, `source-health-monitor.ts`, `alert-wrapper.ts`,
  `kv-rate-limiter.ts`, `circuit-breaker.ts` — monitoring/infra; must never break the user path.
- `api/swap/route.ts:242,360` + `lib/defillama.ts:287` — fail-open for small swaps only, fail-closed
  above $10k. Deliberate, documented, and ratified.

## Defects found by adversarial self-review and fixed before commit

A 4-lens review with 2 independent verifiers per finding was run against the working tree. Five real
defects in the first cut of this change were found, reproduced by mutation testing, and fixed. All
five are recorded because each was a case of the change *looking* correct while not being correct:

1. **Residual fail-open in the retry window** (`useDepegCheck.ts`). `isLoading` alone was used to
   detect "in flight", but TanStack keeps it `true` for the *entire* retry/backoff sequence — so
   during precisely the RPC outage this gate exists to catch, the hook reported `pending`
   (non-blocking) for the whole backoff window. Fixed by treating `failureCount > 0` as failing
   rather than loading.
2. **The `isError` guard was untested** (`useDepegCheck.test.ts`). The wagmi mock returned
   `data: undefined` alongside `isError: true`, but real TanStack **retains the last successful
   `data`** when a refetch errors. With `data` dropped, mutants fell through to the `!dataComplete`
   branch and reached `unverified` anyway — so deleting the guard the source calls "the single most
   important line in the fix" still passed 21/21. The mock is now faithful.
3. **`unverified` could latch permanently** (`useDepegCheck.ts`). A query that settles into `error`
   is not retried by TanStack on its own, and these four reads had no `refetchInterval` — so the
   block could persist for the whole session view while the UI copy promised it would clear.
   `refetchInterval: 30_000` added, matching every sibling read hook.
4. **A vacuous test** (`useDepegCheck.test.ts`). "resolves the pair from EITHER side" asserted
   `'ok'` — which is *also* the no-pair verdict, so deleting tokenOut-side resolution outright still
   passed. Re-asserted against a `block` verdict, which only a resolved pair can produce.
5. **No coverage for the new button copy** (`SwapButton.tsx`). Deleting the `depeg-unverified`
   branch left the suite green and silently fell through to *"Oracle data unsafe — swap blocked"* —
   the exact mis-claim this change exists to prevent.

All four guards are now **mutation-verified**: deleting the `isError` guard fails 4 tests, the
`failureCount` guard 1, tokenOut-side resolution 1, and the button branch 1. Before these fixes, all
four mutants survived.

### Deliberately NOT changed, with reasoning

The review also flagged that the `isError` short-circuit runs *before* the data check, so a failed
**background refetch** hard-blocks even while valid, in-heartbeat data is still in hand — arguably
over-blocking. Verifiers split on whether this is a defect. It was left as-is: the spec states
plainly that a read error is UNVERIFIED, this is the fail-*closed* direction, the exposure is
cbETH-on-Base only, and with fix (3) it self-clears within 30s. Flagging it as a judgement call the
Architect may want to revisit — evaluating in-hand data first would be defensible, since data inside
the staleness ceiling is by our own definition still verified.

Banner copy was also corrected: it claimed *"we could not reach the price feeds"* and *"this is not
a depeg"*, but three of the six routes to `unverified` (stale round, failed integrity, non-positive
answer) DO reach the feeds and reject the data, and "not a depeg" is itself an unverified negative
claim. It now says only what we can support.

## Test gap closed

`useDepegCheck` had **no test file at all** before this change — the hook's entire decision tree was
covered only indirectly through mocked consumers. `src/hooks/useDepegCheck.test.ts` is new (24
cases) and pins every branch, including the over-blocking direction (non-pair tokens, other chains,
disconnected) that a fail-closed change most risks breaking.

## Pre-existing tests whose expectations were inverted (not deleted)

Both encoded the old fail-open contract and are retained with an explicit note saying so:

- `src/lib/depeg-gate.test.ts:47` — `FAIL-OPEN: a null / non-positive leg → ok` → now asserts
  `unverified`.
- `src/components/SwapBox.test.tsx:605` — `either feed stale → hook returns ok → NO false block` →
  now asserts blocked with reason `depeg-unverified`.
