# SPRINT-ORDER-ENGINE-TESTS — test coverage for the order/Base paths going live

A substantial, pure-code sprint to de-risk the DCA go-live: add meaningful test coverage to the
order-engine + order APIs + chain-aware/fail-closed paths that are about to handle real Base conditional
orders. **Tests only — no logic changes.** Branch `sprint/order-engine-tests` off latest `origin/main`.
CI + test-contracts green; SSH-signed commits; append FEEDBACK.

## Phase 0 — coverage assessment (report first)
Run vitest coverage on the target surface and put a before-table in FEEDBACK. Target modules:
- `src/lib/order-engine/config.ts` (getOrderExecutor / getOrderExecutorDomain / router & feed getters)
- `src/app/api/orders/route.ts` (create) + `src/app/api/orders/[id]/route.ts` (cancel)
- `src/hooks/useOrderEngine.ts`, `src/hooks/useConditionalOrder.ts`
- `src/lib/on-chain-monitor.ts` (chain-aware scan)
- `src/lib/conditional-order-types.ts`, `src/lib/limit-order-api.ts` (DCA/limit param logic)

## Phase 1 — add tests for the HIGH-RISK paths (target risk, not % padding)
Cover, with real assertions on both happy + edge/fail-closed paths:
1. **Chain-aware executor resolution (#184):** `getOrderExecutor(1)` = mainnet addr, `getOrderExecutor(8453)`
   = the wired Base addr, `getOrderExecutor(<unwired e.g. 42161>)` = null. `getOrderExecutorDomain(chainId)`
   returns correct `{chainId, verifyingContract}` for wired chains and **throws** (fail-closed) for null.
2. **Order creation API fail-closed:** POST an order on an unwired chain → **400** before any signature
   verification; valid mainnet/Base order → accepted; malformed/oversized/zero-amount → rejected. Signature
   path verifies against the **per-chain** executor (right verifyingContract).
3. **Cancel API auth:** EIP-712 cancel recovers the signer and rejects a non-owner; right domain per chain.
4. **Monitor chain-awareness:** `on-chain-monitor` scans chains where `getOrderExecutor(chainId)` is non-null
   and **skips** chains where it's null (no scanning the Base FeeCollector for order events); per-chain
   cursors (mainnet vs :8453) independent.
5. **DCA / conditional-order params:** interval / dcaTotal / minAmountOut / MIN_ORDER_AMOUNT validation;
   price-condition (ABOVE/BELOW) logic; expiry handling — assert the boundaries that protect users.

## Rules
- **No production logic changes.** If a test uncovers a real bug or a gap, do NOT silently fix it — write the
  test to document expected behaviour (xfail/skip with a note) and **flag it for Architect** in FEEDBACK.
- Tests must be real (meaningful assertions, exercise the branch) — no snapshot-only or trivially-true tests.
- Mock external I/O (RPC, Supabase, wallet) at the boundary; keep tests deterministic. Mainnet behaviour
  assertions must stay byte-identical to current.

## Output
- Branch `sprint/order-engine-tests`; coverage before/after table + per-path list of new tests in FEEDBACK;
  any bug/gap discovered flagged for Architect (do not fix). CI + test-contracts green. No Auditor unless a
  flagged finding is security/gate-adjacent.
