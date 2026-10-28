# feat/ui-v2-swap-lifecycle — feedback (B5)

Off origin/main `a61d9d6` (B4 merged, #619). Worktree `~/ts-worktrees/ui-v2-swap-lifecycle`, real `npm ci`. Signed, noreply, no PR. Diff only `src/ui/v2/**` + this file.
**AUDITOR-NOTE:** wires the real sign/send path (approve → permit/sign → send) — review with B6 before the v2 flag reaches production. Tests mock wallet/RPC; no wallet was connected and no transaction was sent.

## Checklist
- [x] C1 Confirm → real path (gates mirror, hooks, approval, consent/409, CoW, split)
- [x] C2 pending / success / failure (28a/b/c), wrong network (29), toasts (05), sounds, m03
- [x] C3 a11y + stale-quote + edge states
- [ ] Evidence 1–7, push, compare link

## Premises that did not hold (owner answered in-session — the answers supersede the goal text)
1. **No `TransactionStatus*` exists in v1.** v1 has no pending/success/failure screen: the lifecycle is SwapButton's labels/stepper, toasts and a Etherscan link. 28a/b/c are new v2 surfaces built from those v1 states + copy.
2. **v1's `anyBlocked` price gates live in SwapBox's click handlers, not SwapButton.** Owner: **mirror them including the consent checkboxes** (price-impact, depeg) — done with v1's own evaluators (`evaluatePriceGate`, `evaluatePairOracle`, `estimateSwapUsd`, `useDepegCheck`) and v1's copy.
3. **Split toggle unreachable in v2.** Owner: **wire `useSplitRoute` + v1's `SplitRouteVisualizer` toggle copy** (extra read of `SplitRouteVisualizer.tsx`).
4. **v1 has no "quote updated" notice.** Owner: **v1 behaviour — auto-close**: a changed quote key resets the hooks and closes the sheet (no new copy).

Extra v1 reads beyond the goal list, all read-only: `SwapUnpricedConsentDialog` (exports), `SplitRouteVisualizer`, `useSplitRoute`, `useDepegCheck`, `lib/price-gate`, `lib/chainlink` (`evaluatePairOracle`), `lib/swap-usd-estimate`, `lib/executable-sources`, `lib/mev-savings`.

## Findings
- v1: cancelling `TransactionPreview`/`CowOrderReviewModal`/`SplitReviewModal` calls only `reset…` — the `waiting` loop started by the Swap click keeps playing (stopped only on success/error). v2 stops it on cancel (documented deviation, sound table).
- v1's blocked-handler `trackWalletActivity` call is unreachable (the button is disabled when `anyBlocked`); the guard is mirrored, the tracking is not.
- Caught by the 409 equality test (fixed in C1): gating `{ unpricedAck }` on the client tier would have dropped the ack after a server 409 on a pair the client thought priced; v1's `confirmUnpricedSwap` passes it whenever consent was given. v2 passes the ack the attempt's consent produced.
