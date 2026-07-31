# FEAT-DEPEG-GATE-ORDER-CREATION — Extend the depeg gate to order creation

> Spec as issued by the Architect (`/goal`, 2026-07-28). Committed with the implementation per the
> post-#273 process fix. Branch: `feat/depeg-gate-order-creation`.

## Context

The cbETH depeg circuit-breaker (`useDepegCheck`, fail-closed since `fix/oracle-fail-closed` and
`fix/depeg-gate-retry-window`) only guards `SwapBox`. DCA, Limit and SL/TP create autonomous
multi-day/multi-week orders with no peg verification at all — a user could start a 30-day DCA into
a depegged LST with zero signal.

## Objective

Wire the existing, twice-audited gate into all order-creation panels, unmodified.

## Design

1. Reuse `useDepegCheck` exactly as `SwapBox` consumes it. Do not modify the hook, `depeg-gate.ts`,
   or any threshold — this is wiring, not gate design. `DEPEGGED` → block with depeg copy;
   `UNVERIFIED` → block with could-not-verify copy; consent flow → same; `pending` → do not block;
   no registered pair → check does not apply, creation proceeds (the app-wide invariant pinned by
   the independent audit).
2. Check the pair being ordered at the moment of creation (both legs, same as `SwapBox`). The gate
   runs before submission — blocking the submit action, not just showing a banner.
3. Copy consistent with `SwapBox`, with panel-appropriate variants (e.g. "DCA blocked" /
   "Order blocked" instead of "Swap blocked") while keeping the ok/depegged/unverified distinction
   intact.
4. `DCAPanel`'s existing min-buy warning logic (`fix/dca-min-buy-copy`) is untouched — the depeg
   gate is additive.

## Tests (per panel: DCA, Limit, SL/TP)

- depegged pair → creation blocked, depeg copy
- unverified (oracle unreadable) → creation blocked, unverified copy
- healthy pair → creation proceeds
- token with no registered pair → creation proceeds (no false block)

`useDepegCheck` is mocked directly, mirroring `SwapBox.test.tsx`'s own established pattern for
testing consumers of this hook — its internals are exhaustively covered in
`useDepegCheck.test.ts`/`depeg-gate.test.ts` and are not re-tested here.

## Do NOT

- Modify `useDepegCheck.ts` or `depeg-gate.ts` beyond imports · touch Solidity · touch
  `clients.ts`/`rpc.ts` · touch the order-submission API route · `npm install`/`npm update` ·
  stage anything not changed (explicit paths, never `git add -A`).

## Files affected

- `src/components/DCAPanel.tsx`, `src/components/LimitOrderPanel.tsx`,
  `src/components/ConditionalOrderPanel.tsx` — the wiring
- their test files, plus five additional `DCAPanel.*.test.tsx` variant files discovered mid-task
  that import the real (unmocked) component

## Expected output

One signed commit, branch pushed, no PR opened.

## Quality criteria

Verify: `npx tsc --noEmit` (2 expected pre-existing errors) · `npm run lint` · `npm test` (1
expected pre-existing failure: `cuer`). Auditor runs in a SEPARATE session.
