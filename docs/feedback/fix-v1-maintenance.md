# Feedback — fix/v1-maintenance

Base: origin/main `a5cd8fe`. Worktree `~/ts-worktrees/v1-maintenance`. No PR (owner opens). No CI poll.

## Checklist
- [x] C1 tx links use the order's chain
- [ ] C2 Portfolio L2 classification
- [ ] C3 Portfolio hidden-tab polling
- [ ] C4 serialise saveOrders
- [ ] C5 shared escapeRegExp (test-utils)
- [ ] Verify: suite vs main · lint delta · tsc · build · rpc-budget · CodeQL (full security-extended)

## 1. Items (change · file:line · test · fails-on-main)
| # | Change | Where | Test | Fails on main |
|---|--------|-------|------|---------------|
| C1 | `explorerTxUrl(…, 1)` → order's chain; `ExecutionTimeline` gets `chainId` prop (default 1) | `OrderDashboard.tsx` (link + `chainId={orderChainId}`), `ExecutionTimeline.tsx` (prop + link) | `ExecutionTimeline.test.tsx`, `OrderDashboard.test.tsx` "per-chain explorer link" (1/8453/42161, `new URL()` hostname; wallet stays on 1) | yes: 4/6 new cases red (8453, 42161 in both files) before the fix |

## Findings
### Edge case
- C1: `LimitOrderPanel.tsx:1044`, `ConditionalOrderPanel.tsx:917`, `SwapBox.tsx:1193/1203`, `ToastProvider.tsx:182`, `AdminMonitor.tsx:837` still use `ETHERSCAN_TX` (mainnet-only). They are creation/toast/admin surfaces, not Orders/fill rows → left untouched (out of scope + read-scope); worth a follow-up if those panels can run on L2.
