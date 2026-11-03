# feat/ui-v2-portfolio — FEEDBACK (B8 Portfolio; Code Agent; 2026-11-03)

## Checklist
- [x] Worktree ~/ts-worktrees/ui-v2-portfolio off origin/main 19cced7 (#637), real `npm ci`, SSH-signed noreply committer
- [x] Premises checked against v1; owner answered 4 questions (below) — answers supersede the /goal text
- [x] C1 holdings + Active Approvals panel · [x] C2 chain switch / Swap link / no-poll (rpc-budget scenario p) · [ ] C3 mobile 375 + a11y
- [ ] Verify (suite vs main, lint delta 0, tsc, build, v1 proof, rpc-budget, CodeQL full) · [ ] push + compare link

## Frames read (round7/app): desktop 44-portfolio-connected-approvals, 45a-portfolio-disconnected,
45b-portfolio-loading-error · mobile m06-portfolio-approvals (+ CHANGELOG, FUNCTIONAL-CONTAINERS)

## Premises that were false in the /goal text → owner answers (2026-11-03)
- "per chain and in total": v1 is ACTIVE-CHAIN ONLY (header chain; usePortfolio follows useActiveChainId), grouped by
  token CATEGORY then "Discovered in Wallet"; no cross-chain total → **mirror v1**.
- v1 has NO 24h, NO hide-small/zero filters, NO sort control, NO imported badge, NO links to DCA/Orders/History,
  NO chain filter of its own → **mirror v1**; C2 = parity (Swap button → Swap tab, chain switch, no-poll).
- Frames show extras not in v1 Portfolio → owner: ship ONLY **Active Approvals** (v1 ActiveApprovals, reused unchanged).
  NOT shipped: "Hidden · unverified" group, "ETH · Base" native label, frame-only headline/skeleton/CONNECT CTA/RETRY copy.

## Content-map delta (v1 → v2)
- Kept verbatim: every v1 string (parity test: same visible text nodes, same order, 3 chains + 14 states).
- Added: Active Approvals beside the holdings (v1 shows it under the Swap box; the v2 swap card still has none).
- Restyled only: hairline rows, mono caps labels, text buttons (Swap/Add/Revoke/Try again), icon refresh, tunnel photo.
- Deviation: a revoked approval row stays listed with "✓ Revoked ↗" (v1 drops it in the same render, so v1 never shows it).

## Findings (for the Architect)
- v1 `isDefaultToken` uses mainnet DEFAULT_TOKENS on EVERY chain → on Base/Arbitrum catalog tokens (e.g. USDC) land under
  "Discovered in Wallet" with Add. Mirrored for parity (owner: "nothing may disappear"); fix belongs in v1.
- `ApprovalRecord` has no chainId: Revoke sends approve(spender,0) on whatever chain the wallet is on NOW, and the receipt link
  uses the active chain — same as v1. A record made on Base and revoked while on Ethereum hits the wrong chain. Needs a hook change.
- v1 Swap button ignores the token (setSwapMode only); mirrored.
- v1's hook polls the API (discovery + prices, 60 s setInterval) even while the BROWSER tab is hidden; RPC is 0 hidden
  (measured, scenario p). Unmounted v2 tab = 0 API + 0 RPC (tested). A visibility gate needs a hook change → owner call.
- Deviation: imports keyed chain:address (v1: address only) so an import on Base never marks the Ethereum row.

## Evidence
(filled in the final commit: 1 frames+screenshots · 2 parity · 3 totals · 4 states matrix · 5 CodeQL+rpc-budget · 6 v1 proof/suite/lint/tsc/build/diff/link)
