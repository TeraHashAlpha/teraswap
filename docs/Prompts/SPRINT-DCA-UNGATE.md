# SPRINT-DCA-UNGATE — wire the DCA tab behind a launch flag (build now, flip after e2e)

Build the functional DCA order-creation UI, **gated OFF** behind a launch flag, so after the manual e2e +
go-live steps you just flip the flag to launch. **Touches frontend only** (`src/app/page.tsx`, the DCA panel
component, `useOrderEngine` wiring, a flag) — disjoint from `.github/` and `api/admin`, safe to run in
parallel. Branch `sprint/dca-ungate` off latest `origin/main`. CI + test-contracts green; SSH-signed commits;
FEEDBACK. No backend/contract changes.

## Context
The DCA tab currently shows the "Soon" teaser (`page.tsx`); the panel component exists but isn't wired to the
live order flow. Conditional orders are L2-only; the Base OrderExecutor is live + wired
(`ORDER_EXECUTOR_BY_CHAIN[8453]`). Limit/SL·TP stay removed (CHORE-ORDER-EXEC-PREP).

## Requirements
1. **Launch flag** `NEXT_PUBLIC_DCA_ENABLED` (default **false/off**). While off, the DCA tab behaves exactly
   as today ("Soon" teaser) — zero user-visible change. When on, it renders the functional DCA panel.
2. **Wire the DCA panel → order creation** (`useOrderEngine` create flow): token in/out, quantity, interval,
   number of parts (dcaTotal); build + EIP-712 sign + submit to `api/orders`. Reuse the existing hook/validation
   (incl. the #200 client-side `MIN_ORDER_AMOUNT` floor).
3. **Gating (all must pass to allow creation):** `NEXT_PUBLIC_DCA_ENABLED` on **AND** `isChainActive(8453)`
   **AND** `getOrderExecutor(<chainId>)` non-null. On Base only (per L2-only).
4. **Frozen-state UX:** if order creation returns the freeze 403 (from #201), show a friendly "DCA temporarily
   paused" message and disable the submit — don't surface a raw error. (No new status endpoint; handle the 403.)
5. **Tests:** flag off ⇒ tab is the "Soon" teaser, no order UI, byte-identical to today; flag on + Base active
   ⇒ panel renders, a valid order builds/signs/submits (mock the API), sub-floor amounts blocked client-side,
   403 ⇒ paused message. Mainnet/other chains ⇒ DCA not offered.

## Do NOT
- Do NOT default the flag on. No un-gating of Limit/SL·TP. No backend/contract/gate changes. Mainnet + the
  current "Soon" UX byte-identical while the flag is off.

## Output
- Branch `sprint/dca-ungate`; flag + wired panel + frozen-state UX + tests; FEEDBACK noting the flag name and
  that go-live = flip `NEXT_PUBLIC_DCA_ENABLED` after the e2e + whitelist + funding. No Auditor (frontend
  gating; the order path is already audited/tested — the real gate is the manual e2e before flipping the flag).
