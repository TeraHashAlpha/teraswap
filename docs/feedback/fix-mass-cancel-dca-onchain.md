## Feedback — BUG-MASS-CANCEL-DCA-ONCHAIN

**Auditor pass required before merge (fund-flow-adjacent: cancel guarantees).**

### Mis-routing mechanism
The hook (`src/hooks/useOrderEngine.ts`) already routes correctly — `cancelAllOrders`
(~L972-1019) partitions v3 orders by `orderType !== OrderType.DCA` into `v3Batches`
(bitmap, `invalidateUnorderedNonces`) vs `v3DcaOrders` (individual `cancelOrder`), and
`confirmCancel` (~L1093-1135) executes exactly that split. This matches PR #301's design
and TeraSwapOrderExecutorV3.sol ground truth (DCA branch skips the nonce bitmap check
entirely — checks only `cancelledOrders`/expiry/`dcaExecutions`).

The actual defect was in `OrderCancelReviewModal.tsx`: it never read `v3Batches`/
`v3DcaOrders`, so it always rendered "invalidate your order nonce on-chain (one
transaction) ... cancelling every active order below" — false whenever a DCA order is
in the batch, since that order's cancellation happens via a separate `cancelOrder` tx the
copy never mentioned. Root cause was UI copy overstating a guarantee the hook already
correctly avoided, not a routing bug.

### Partition logic (unchanged, confirmed correct)
`nonceTxCount = (newNonce !== null ? 1 : 0) + v3Batches.length`; `cancelTxCount =
v3DcaOrders.length`. Modal now derives both and only falls back to the original
single-tx copy when `cancelTxCount === 0` (byte-identical for v2-only / non-DCA-only).

### Tx-count table per batch shape (hook-level, `useOrderEngine.v3.test.ts` L260-312; modal-level, `OrderCancelReviewModal.test.tsx`)
| Shape | nonce txs | cancelOrder txs |
|---|---|---|
| all-DCA | 0 | N |
| mixed (v2 + DCA) | 1 (v2) | N |
| mixed (v3 non-DCA + DCA) | 1 per bitmap word | N |
| non-DCA-only (v2 or v3) | 1 (or 1/word) | 0 |
| v2 unchanged | unchanged from #299 | n/a |

### Single-cancel sweep (report only, no fix)
`confirmCancel`'s `action === 'cancel'` branch (~L1041-1090) always calls `cancelOrder`
on-chain for both v2 and v3 — no nonce-only shortcut exists for single-order cancel.
Toast copy in `DCAPanel.tsx:136` and `LimitOrderPanel.tsx:91` ("cancelled on-chain") is
accurate for this path.

Other surfaces claiming on-chain cancellation, NOT touched here (outside files-affected
scope, flagging for Architect triage): `DocsPage.tsx:638` and `:779` — "a single mass
nonce-invalidation can void all of your pending orders at once" repeats the same
overstated guarantee in static marketing/docs copy and should be corrected to match the
partitioned reality above.
