# FIX-DEPEG-GATE-RETRY-WINDOW — Close M-01 (depeg gate re-opens on the poll)

> Spec as issued by the Architect (`/goal`, 2026-07-28). Committed with the implementation per the
> post-#273 process fix. Branch: `fix/depeg-gate-retry-window`.

## Context

M-01 from the independent audit of `fix/oracle-fail-closed` (recorded in
[`AUDIT-TOTAL.md`](../security/AUDIT-TOTAL.md), entry `AUDIT-ORACLE-FAIL-CLOSED`, 2026-07-28).

The `refetchInterval: 30_000` added to stop `unverified` latching defeats the `failureCount` guard:
on each 30s poll of a never-succeeded query, TanStack query-core resets `fetchFailureCount` to 0
and, with `data === undefined`, `status` returns to `'pending'` — the hook sees
`isLoading: true / failureCount: 0` and returns `PENDING` (not blocking) for ~0.3–1.3s every 30s,
during exactly the outage the gate exists to catch.

## Objective

Invert the burden of proof so an in-flight state can never re-open the gate after a failure.

## Requirements

1. Once the gate has entered UNVERIFIED (or any failure has occurred), every subsequent
   in-flight/pending state must present as UNVERIFIED, not PENDING. Only a COMPLETED SUCCESSFUL read
   transitions back to ok/depegged evaluation.
2. Do not rely on TanStack's resettable counters. Use memory the library cannot reset —
   `errorUpdateCount` (monotonic) or an own ref tracking "has ever failed since mount". State which
   was chosen and why.
3. First-ever load with NO prior failure keeps the existing PENDING behaviour — do not regress the
   first-render UX.
4. Keep `refetchInterval` so recovery stays automatic; the change is how in-flight presents AFTER a
   failure, not whether we retry.

## Tests (the audit's reproduction must become a permanent test)

- never-succeeded query + refetch cycle → gate stays blocked across the entire poll, no pending
  window (assert at the state level; fake timers if timers are involved, no real sleeps);
- failure → later successful read → gate reopens normally;
- fresh mount, no failure yet → PENDING as today.

## Do NOT

- Touch Solidity · touch `clients.ts` / `rpc.ts` · touch `useChainlinkPrice.ts` (separate queued
  work) · `npm install` / `npm update` · stage anything not yours (explicit paths, never
  `git add -A`).

## Files affected

- `src/lib/depeg-gate.ts` — the failure-memory predicate
- `src/hooks/useDepegCheck.ts` — the in-flight classification
- their test files

## Expected output

One signed commit, branch pushed, no PR opened.

## Quality criteria

Verify: `npx tsc --noEmit` (2 expected pre-existing: `@playwright/test`, `cuer`) · `npm run lint` ·
`npm test` (1 expected pre-existing failure: `cuer`). Auditor runs in a SEPARATE session.
