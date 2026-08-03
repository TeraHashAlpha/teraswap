# BUG-MASS-CANCEL-DCA-ONCHAIN — "Cancel all" uses nonce invalidation for DCA orders, which does NOT cancel them on-chain

> **Source:** v3 Base cutover smoke, 2026-07-21 (owner + Architect). "Cancel all" over TWO v3 DCA orders
> (nonces 0 and 4) sent ONE `invalidateUnorderedNonces` tx + per-order off-chain removal signatures, and
> toasted "cancelled on-chain". **Contract ground truth (TeraSwapOrderExecutorV3.sol):** `executeOrder`
> consumes/checks the nonce bitmap ONLY in the non-DCA branch (~L499); the DCA branch checks only
> `cancelledOrders[orderHash]` (~L453), expiry, and dcaExecutions/interval. Therefore nonce invalidation is
> a NO-OP for DCA execution: the two orders remain on-chain-executable until expiry; only the Supabase
> status (keeper honesty) stops them. This contradicts PR #301's design ("mass-cancel = individual
> cancelOrder calls for v3 DCA; invalidateUnorderedNonces for non-DCA") and the UI copy overstates the
> guarantee. Risk bounded (recipient==owner + oracle floor + whitelisted-keeper-only ⇒ worst case =
> unwanted fair-priced conversion to the owner's own wallet) but this is a cancel-guarantee defect on a
> fund-flow-adjacent surface → **Auditor pass required before merge (0C/0H).** SSH-signed; branch
> `fix/mass-cancel-dca-onchain` off `origin/main`, dedicated worktree; 3 droppable commits.
> **Exit = push + local suite green + compare link; owner opens the PR.**

## Requirements (per-commit)

### 1. FAILING TEST FIRST
Mass-cancel over a set containing v3 DCA orders must issue an on-chain `cancelOrder` per DCA order (and
`invalidateUnorderedNonces` only for the non-DCA subset). Reproduce the current behavior (all-DCA batch →
nonce-only path) as a failing test against main; prove the failure in FEEDBACK.

### 2. Fix — route by order type, honest copy
- The cancel-all flow (OrderCancelReviewModal / its hook) partitions affected orders: **v3 DCA →
  individual `cancelOrder(order, signature?)` txs** (batch via multicall ONLY if the contract already
  exposes one — do not add contract code); **non-DCA v3 → one `invalidateUnorderedNonces`** covering their
  nonces; v2 orders keep their existing path untouched.
- The confirmation modal lists what will ACTUALLY happen (N cancelOrder txs + 1 nonce tx when mixed) and
  the copy never claims on-chain cancellation for anything that is DB-only. Toast reflects reality.
- Wallet-cost note in the modal when multiple txs will be prompted (one per DCA order) — expected UX,
  document it.

### 3. Tests + reconciliation sweep
- Tests: all-DCA batch → N cancelOrder txs, 0 nonce txs; mixed batch → N cancelOrder + 1 nonce tx;
  non-DCA-only → nonce tx only; v2 path unchanged; UI copy assertions for each shape; failing test from §1
  now green. Full suite + tsc + eslint green.
- REPORT ONLY (no fix here): whether single-cancel ("Cancel Order" on one DCA position) already uses
  on-chain cancelOrder everywhere it appears (it did in the 2026-07-18 smoke — confirm no other path
  shares the nonce-only shortcut), and list any other UI surface that claims on-chain cancellation.

## Do NOT
Touch the contract, keeper, signing/approve paths, routing/quotes; change v2 behavior; open a PR;
hand-type hex.

## Files affected (read ONLY these + tests)
The cancel-all flow: `src/components/OrderCancelReviewModal.tsx` + hook(s) it uses
(`useOrderEngine.ts` cancel paths ~L946/982), their tests, `docs/Prompts/BUG-MASS-CANCEL-DCA-ONCHAIN.md`
(commit this spec). Read-only: `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (ground truth), PR
#301 FEEDBACK.

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the mis-routing mechanism (exact line), the partition
logic, tx-count table per batch shape, single-cancel sweep result. **Flag for the Auditor pass (0C/0H
before merge).**

## Quality criteria
Failing-test-first; DCA mass-cancel terminal on-chain; honest UI copy; v2 + non-DCA paths byte-identical;
suite green.
