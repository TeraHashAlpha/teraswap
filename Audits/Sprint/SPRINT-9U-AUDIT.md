# Sprint 9U Audit — EIP-712 Review Gates (CoW + Order Engine)

**Date:** 2026-06-08
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9u-eip712-review`
**Commits reviewed:** `6c0027b` (U1 CoW order review), `f7539af` (U2 Order Engine review), `4dadedc` (FEEDBACK), `3186b48` (audit follow-ups — expiry-freshness guard)
**Files changed:** 13 (+980/−137 lines)
**Tests:** +20 new `it()` blocks
**Signatures:** All 4 commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9U Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

## Principle: NO EIP-712 signature without TeraSwap review of the exact FROZEN typed-data payload being signed.

### Check 1: No-bypass — no signature path reaches the wallet un-reviewed ✅

| Path | Pre-review gate | Verified |
|------|----------------|----------|
| **CoW swap** | `executeCowSwap()` = Phase A: build domain/types/message, freeze as `PendingCowOrder` → status `'cow_awaiting_review'` → CowOrderReviewModal opens. `confirmCowOrder()` = Phase B: signs frozen payload 1:1. | ✅ No `signTypedDataAsync` in Phase A. `confirmCowOrder` guards on `status !== 'cow_awaiting_review'` implicitly (early return if `!pendingCowOrder`). |
| **Limit order** | `createOrder()` = Phase A: build OnChainOrder struct + computeOrderHash → freeze as `PendingOrderReview` → OrderReviewModal opens. `confirmOrder()` = Phase B: signs frozen struct 1:1. | ✅ No `signTypedDataAsync` or `writeContractAsync` in Phase A. `confirmOrder` guards on `!pendingOrder \|\| !address`. |
| **Stop-Loss / Take-Profit** | Same `useOrderEngine` hook (same `createOrder` → `confirmOrder` flow). OrderType.STOP_LOSS uses same Phase A/B split. | ✅ Shared code path — no separate bypass. |
| **DCA** | Same `useOrderEngine` hook. DCA panels call `createOrder` with `OrderType.DCA` config. Same two-phase flow. | ✅ Shared code path — no separate bypass. |
| **Re-quote / re-config** | Re-calling `createOrder` or re-running `executeCowSwap` overwrites the frozen payload → user must re-review the new version. | ✅ `setPendingOrder(...)` / `setPendingCowOrder(...)` replace the frozen struct. |

### Check 2: Faithful rendering — modals render exclusively from the frozen struct ✅

**CowOrderReviewModal (new, 133 lines):**
- Receives `PendingCowOrder` as sole data source. ✅
- Renders from `order.message`: sellAmount (with `tokenIn.decimals`), buyAmount (with `tokenOut.decimals`), receiver, validTo, feeAmount, appData, kind, partiallyFillable. ✅
- Shows `order.settlement` (domain.verifyingContract). ✅
- Shows `order.account` (wallet that will sign). ✅
- `onConfirm` → `confirmCowOrder()` which signs `{ domain: p.domain, types: p.types, primaryType: 'Order', message: p.message }` — the exact frozen fields. ✅
- No live state accessed inside the modal (no `tokenIn`/`tokenOut` from SwapBox, no re-fetch). ✅

**OrderReviewModal (new, 143 lines):**
- Receives `PendingOrderReview` as sole data source. ✅
- Renders from `order.order`: tokenIn/tokenOut, amountIn, minAmountOut, triggerPrice, condition (ABOVE/BELOW), expiry, router, nonce, priceFeed, routerDataHash. ✅
- Shows `order.config`: orderType label, pair (config.tokenIn.symbol → config.tokenOut.symbol), DCA-specific fields (dcaInterval, dcaTotal). ✅
- Shows `order.computedHash`. ✅
- `onConfirm` → `confirmOrder()` which signs the exact frozen `order` struct. ✅
- No live state accessed inside the modal. ✅

**Audit follow-up (3186b48) — surfaced signed fields:**
- `priceFeed` and `routerDataHash` added to the OrderReviewModal display — the user can see which oracle feed and which calldata template the order is bound to. ✅

### Check 3: Invalidation — chain/account switch and expiry force re-review ✅

| Guard | CoW (useSwap) | Orders (useOrderEngine) | Verified |
|-------|---------------|------------------------|----------|
| **Account switch/disconnect** | `prevAddressRef` + `useEffect([address])` → `setPendingCowOrder(null)` + status reset | `prevOrderAddrRef` + `useEffect([address])` → `setPendingOrder(null)` | ✅ Parity with 9R pattern |
| **Chain switch** | `prevChainIdRef` + `useEffect([chainId])` → `setPendingCowOrder(null)` + status reset | `prevOrderChainRef` + `useEffect([chainId])` → `setPendingOrder(null)` | ✅ Parity with 9R pattern |
| **Confirm-time re-check (defense-in-depth)** | `confirmCowOrder`: `if (p.chainId !== chainId \|\| p.account.toLowerCase() !== address.toLowerCase())` → discard + idle | `confirmOrder`: `if (p.chainId !== chainId \|\| p.account.toLowerCase() !== address.toLowerCase())` → discard | ✅ Synchronous, independent of React effect timing |
| **Expiry freshness (3186b48)** | `if (p.message.validTo <= Math.floor(Date.now() / 1000))` → discard + error ("expired before signing") | `if (Number(p.order.expiry) <= Math.floor(Date.now() / 1000))` → discard + order_error event | ✅ Prevents signing a dead-on-arrival order |
| **Reset() / token change** | `reset()` clears `pendingCowOrder`. Token selector calls `resetSwap()`. | `clearPendingOrder()` exposed for modal cancel. | ✅ |

**Rationale for expiry freshness (audit follow-up):** The review modal can stay open indefinitely (human-paced). A CoW order whose `validTo` has already passed will be rejected by the CoW orderbook on submission, but the signature would still be wasted. An autonomous order whose `expiry` has passed can never trigger on-chain. The freshness guard prevents both — fail-safe to re-quote/recreate.

### Check 4: Scope — display/flow-control only ✅

| Scope area | Changed? |
|-----------|----------|
| EIP-712 domain (CoW: `Gnosis Protocol/v2/chainId/settlement`) | NO — constructed identically, just frozen into `PendingCowOrder.domain` |
| EIP-712 types (CoW Order struct) | NO — same `types` object, frozen |
| EIP-712 order struct fields | NO — same fields populated, same computation |
| Order Engine contract / OrderExecutor | NO — no Solidity changes |
| CoW order construction (parseCowOrderParams) | NO — same function, same params |
| CoW order submission (submitCowOrder) | NO — receives same `orderParams` + `signature` |
| signTypedDataAsync call | MOVED from Phase A to Phase B — same args. Zero behavioral change to what is signed. |
| writeContractAsync call | MOVED from Phase A to Phase B — same args. |
| Price gate / deviation / oracle | NO |
| FeeCollector / router whitelist / selectors | NO |
| Adapters | NO |

**The diff is a pure refactor:** the `signTypedDataAsync` and `writeContractAsync` calls that were inline in `executeCowSwap` / `createOrder` are now in `confirmCowOrder` / `confirmOrder`. The arguments are byte-identical — they come from the frozen struct rather than local variables, but those local variables ARE the frozen struct (frozen at the same point in the same function).

### Check 5: Cancel/invalidate signatures un-gated — acceptable follow-up ✅

The FEEDBACK.md (commit `4dadedc`) notes that cancel and invalidate signatures for autonomous orders are NOT gated by the review modal. This is correct per spec — the scope is creation-only (Phase A/B applies to `createOrder`/`confirmOrder`).

**Why this is NOT a hidden bypass:**
1. Cancel/invalidate are **defensive** operations — they prevent an order from executing, not authorize one. ✅
2. Cancel is **idempotent** — re-cancelling an already-cancelled order is a no-op on-chain. ✅
3. The worst case of a malicious cancel is the user's own order being disabled — self-griefing, no fund loss. ✅
4. Adding a review gate to cancel would degrade UX (user clicks "Cancel order" → review modal → confirm → signature) for zero security benefit. ✅

**Acceptable as follow-up** if the team later wants consistency for the review principle, but NOT a security gap.

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9U-I-01 | INFO | `useSwap.ts` / `useOrderEngine.ts` | The `clearPendingOrder()` function (exposed for modal dismiss) sets `pendingOrder` to null without a re-entry guard. In the current architecture this is safe — dismiss is a React state setter, and `confirmOrder` checks `pendingOrder` synchronously before proceeding. If the modal is later replaced with an async close animation, ensure the null-check in `confirmOrder` still fires before the animation completes. |

---

## Recommendation

**Merge.** The two-phase EIP-712 review architecture correctly enforces the review-integrity principle across both signature paths (CoW typed-data orders and Order Engine autonomous orders). No signature reaches the wallet without the user reviewing the exact frozen payload in a dedicated modal. Chain/account-switch invalidation, synchronous confirm-time re-checks, and expiry freshness guards hold the invariant under all observable race conditions. Scope is strictly display/flow-control — no changes to EIP-712 domains, types, structs, contract interaction, or any safety gate.
