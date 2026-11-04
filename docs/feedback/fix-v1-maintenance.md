# Feedback — fix/v1-maintenance

Base: origin/main `a5cd8fe`. Worktree `~/ts-worktrees/v1-maintenance`. No PR (owner opens). No CI poll.

## Checklist
- [x] C1 tx links use the order's chain
- [x] C2 Portfolio L2 classification
- [ ] C3 Portfolio hidden-tab polling
- [ ] C4 serialise saveOrders
- [ ] C5 shared escapeRegExp (test-utils)
- [ ] Verify: suite vs main · lint delta · tsc · build · rpc-budget · CodeQL (full security-extended)

## 1. Items (change · file:line · test · fails-on-main)
| # | Change | Where | Test | Fails on main |
|---|--------|-------|------|---------------|
| C1 | `explorerTxUrl(…, 1)` → order's chain; `ExecutionTimeline` gets `chainId` prop (default 1) | `OrderDashboard.tsx` (link + `chainId={orderChainId}`), `ExecutionTimeline.tsx` (prop + link) | `ExecutionTimeline.test.tsx`, `OrderDashboard.test.tsx` "per-chain explorer link" (1/8453/42161, `new URL()` hostname; wallet stays on 1) | yes: 4/6 new cases red (8453, 42161 in both files) before the fix |
| C2 | curated vs Discovered uses the ACTIVE chain's list: new `isCuratedToken(address, chainId)` | `lib/chains/tokens.ts` (helper), `PortfolioTab.tsx` `isDefaultToken(token, activeChainId)`; v2 `portfolio-model.ts` + `PortfolioTab.tsx` (restated mainnet-only copy, same fix) | `PortfolioTab.test.tsx` (USDC 8453/42161 curated; unknown still Discovered+Add; mainnet addr on Base is Discovered), `tokens.test.ts`, v2 `portfolio.test.tsx` parity (own USDC curated in both tabs) | yes: 7 new cases red on main (2 "unknown stays discovered" guards pass on both) |

## v2 parity tests updated
- `ui/v2/portfolio/portfolio-a11y.test.tsx`: fixture ran on Base with MAINNET ETH/USDC addresses (only "curated" because v1's set ignored the chain) → now Base's own ETH/USDC from `getChainTokenList(8453)`.
- `ui/v2/portfolio/portfolio.test.tsx`: +1 parity case (own USDC curated in v1 and v2 on 1/8453/42161).

## Findings
### Edge case
- C2: premise partly false — v2 does NOT render through a shared classifier; `portfolio-model.ts` restated v1's mainnet-only set ("on every chain"). Fixed there too via the shared `isCuratedToken`, else v1/v2 would diverge on L2. "Catalog" = `getChainTokenList` (curated list, what `usePortfolio` already uses for metadata), not the full search catalog (long tail would hide real Add candidates).
- C1: `LimitOrderPanel.tsx:1044`, `ConditionalOrderPanel.tsx:917`, `SwapBox.tsx:1193/1203`, `ToastProvider.tsx:182`, `AdminMonitor.tsx:837` still use `ETHERSCAN_TX` (mainnet-only). They are creation/toast/admin surfaces, not Orders/fill rows → left untouched (out of scope + read-scope); worth a follow-up if those panels can run on L2.
