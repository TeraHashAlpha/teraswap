# CHORE-ORDER-EXEC-PREP — chain-aware order executor + trim order tabs

Two parts, ONE branch `chore/order-exec-prep` off latest `origin/main`, atomic SSH-signed commits
(A then B). CI green incl. the real **test-contracts** gate; append `FEEDBACK.md`. **Mainnet byte-identical
for the swap path AND for mainnet order signing** (verifyingContract on chainId 1 must stay
`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`). No Solidity/contract changes. Keys server-only.

## Context (verified on-chain 2026-06-13 — see `docs/DEPLOYMENTS.md`)
`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` is the **OrderExecutor on mainnet** (has `executeOrder`) but a
**FeeCollector on Base** (has `swapTokenWithFee`/`swapETHWithFee`, NO `executeOrder` — different bytecode,
same address). Today `src/lib/order-engine/config.ts` exports a single hardcoded `ORDER_EXECUTOR_ADDRESS`
used by every caller and by `getOrderExecutorDomain(chainId)` regardless of chain. So on Base the order
engine would point at the **FeeCollector** → EIP-712 order signing / execution / event-monitoring against the
wrong contract. There is **no OrderExecutor deployed on Base yet.** Conditional orders are not launched.

---

## Part A — make the order executor chain-aware + fail-closed

**In `src/lib/order-engine/config.ts`:**
- Replace the single `ORDER_EXECUTOR_ADDRESS` with a per-chain map and resolver:
  ```ts
  // Mainnet OrderExecutor (verified: has executeOrder). Env override kept for mainnet upgrades only.
  // Base (8453): NO OrderExecutor deployed — 0xeFC3…f130 on Base is the FeeCollector, NOT an executor.
  // Add the Base address here ONLY after a real Base OrderExecutor is deployed + verified.
  export const ORDER_EXECUTOR_BY_CHAIN: Record<number, `0x${string}` | null> = {
    1: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS ?? '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130') as `0x${string}`,
    8453: null,
  }
  export function getOrderExecutor(chainId: number): `0x${string}` | null {
    return ORDER_EXECUTOR_BY_CHAIN[chainId] ?? null
  }
  ```
- `getOrderExecutorDomain(chainId)` must resolve via `getOrderExecutor(chainId)`; if it's `null`, **throw**
  a clear error (never sign/verify EIP-712 against a non-existent executor). Mainnet (1) result unchanged.
- Migrate ALL callers off the bare `ORDER_EXECUTOR_ADDRESS` to `getOrderExecutor(<chainId>)`, resolving the
  chain from the order/request context:
  - `src/hooks/useOrderEngine.ts` (lines ~288/295/537/669/683/713/733) — use the connected `chainId`;
    if `getOrderExecutor(chainId)` is null, **disable order creation/signing** for that chain (no call).
  - `src/app/api/orders/route.ts` (~134) — resolve from the order's `chainId`; if null → **reject 400**
    ("conditional orders not yet available on chain X"). Fail-closed before any signature verification.
  - `src/app/api/orders/[id]/route.ts` — cancel path uses `getOrderExecutorDomain(chainId)`; the throw on
    null is acceptable (no executor → no valid order existed).
  - `src/lib/on-chain-monitor.ts` (~288) — only scan chains where `getOrderExecutor(chainId)` is non-null
    (skip Base). Do NOT scan the Base FeeCollector for OrderExecutor events.
- Keep `ORDER_EXECUTOR_ADDRESS` as a deprecated alias = `ORDER_EXECUTOR_BY_CHAIN[1]` ONLY if removing it
  cleanly is risky; prefer full migration. Note the choice in FEEDBACK.

**Tests:** `getOrderExecutor(1)` = mainnet addr, `getOrderExecutor(8453)` = null; `getOrderExecutorDomain(1)`
unchanged (verifyingContract = mainnet addr), `getOrderExecutorDomain(8453)` throws; order POST on chainId
8453 → 400 fail-closed; monitor skips chains with null executor. Update `useOrderEngine.test.ts` (it asserts
`verifyingContract === ORDER_EXECUTOR_ADDRESS`) to the chain-aware resolver.

---

## Part B — trim the order tabs (keep DCA "Soon", remove Limit + SL/TP)

**In `src/app/page.tsx`:**
- Remove the `['limit', 'Limit']` and `['sltp', 'SL / TP']` entries from the tab array (~lines 103-104).
  Keep `['dca', 'DCA']` (stays as the "Soon" teaser).
- Remove the `limit` and `sltp` entries from the coming-soon info object (~lines 32-33). Keep `dca` (31).
- Remove/disable any tab-content `switch`/render branch for `'limit'` and `'sltp'` so they're unreachable
  (no dead routes, no console errors). Keep Swap, Portfolio, DCA(Soon), Orders, History, Analytics.
- **Do NOT delete** `LimitOrderPanel.tsx`, `ConditionalOrderPanel.tsx`, or related order components/source
  (rule #4 — history preserves; we'll re-wire later). Unwire from nav only.

---

## Do NOT
- No contract/Solidity changes. No change to the instant-swap (FeeCollector) path — mainnet + Base swaps
  unaffected/byte-identical. Mainnet order signing (chainId 1) semantics unchanged.
- Do NOT add a Base entry to `ORDER_EXECUTOR_BY_CHAIN` (none deployed). Do NOT delete order components.

## Files affected
`src/lib/order-engine/config.ts`, `src/hooks/useOrderEngine.ts`, `src/app/api/orders/route.ts`,
`src/app/api/orders/[id]/route.ts`, `src/lib/on-chain-monitor.ts`, `src/app/page.tsx`, related tests.

## Expected output
Branch `chore/order-exec-prep`, 2 signed commits (A, B), CI + test-contracts green, FEEDBACK appended with
the caller-migration list + the deprecated-alias decision.

## Quality criteria
Order executor resolves per-chain; Base fail-closed everywhere (create/sign/cancel/monitor); mainnet order
signing unchanged; nav shows Swap/Portfolio/DCA(Soon)/Orders/History/Analytics — no Limit, no SL/TP; all
tests green. **No Auditor needed** — but flag for Architect if any change alters mainnet (chainId 1) EIP-712
order-signing semantics.
