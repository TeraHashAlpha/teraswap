# feat/ui-v2-portfolio — FEEDBACK (B8 Portfolio · Code Agent · 2026-11-03) · raw outputs: feat-
ui-v2-portfolio.evidence.md
Done: worktree off 19cced7 (#637), real npm ci, 3 SSH-signed noreply commits (C1 19c1ed5 · C2 1153c66 · C3 7b5a82c),
  pushed.
Frames read (round7/app): desktop 44-portfolio-connected-approvals, 45a-portfolio-disconnected, 45b-portfolio-loading-
  error;
mobile m06-portfolio-approvals; round7 CHANGELOG + FUNCTIONAL-CONTAINERS. Nothing else from the pack.
## False premises → owner answers (supersede the /goal text)
- "per chain + total": v1 is ACTIVE-CHAIN ONLY (grouped by category, then Discovered in Wallet) → mirror v1.
- v1 has no 24h / hide-small / sort control / imported badge / DCA-Orders-History links / chain filter → mirror v1.
- Frame-only extras → ship ONLY Active Approvals (v1 ActiveApprovals, reused). Not shipped: Hidden·unverified group,
  "ETH · Base", frame headline/skeleton/CONNECT CTA, RETRY copy (copy = v1 verbatim).
## Content-map delta (v1 → v2)
Kept: every v1 string (same text nodes, same order). Restyled: hairline rows, mono caps, text buttons, tunnel photo.
Added: Active Approvals beside holdings (v1: under the Swap box). Deviations: a revoked row stays as "✓ Revoked ↗"
(v1 drops it in the same render); imports keyed chain:address (v1: address) so a Base import never marks Ethereum.
## Findings for the Architect
- v1 isDefaultToken = mainnet DEFAULT_TOKENS on every chain → Base/Arb catalog tokens land under Discovered + Add.
  Mirrored.
- ApprovalRecord has no chainId: Revoke and its receipt link use the chain the wallet is on NOW (as v1). Needs a hook
  change.
- usePortfolio's 60 s API intervals keep firing in a browser-hidden tab (RPC is 0 hidden). Unmounted tab: 0 API, 0 RPC.
## Evidence 1-6
1 Frames above. Screenshots (1440 + 375): docs/feedback/feat-ui-v2-portfolio-
  shots/{desktop,m375}-{populated,disconnected,
  loading,error}.png
2 Parity v1 ⊆ v2, 0 missing: chains 1/8453/42161 = 34/28/22 nodes; approvals 27; 17 state runs. Same nodes, same order.
3 Totals: v1 text == v2 text == independent bigint-cents sum ($10 230.00 / $2 980.00 / $3 100.00 fixtures), equality.
4 States matrix (each vs v1): populated, disconnected, unavailable ×3, loading, refreshing, error ±rows, empty ×3,
  unpriced,
  clock 7 s / 1 m / 3 h; plus chain switch ×3, import per chain, revoke Revoking/Confirming/Revoked/Retry.
5 CodeQL javascript-security-extended: 0 alerts in changed files (19 pre-existing elsewhere). rpc-budget 26/26 green;
  new scenario p (Portfolio, wallet): v1 = v2 = 4 calls/min visible, 0 hidden, budget ≤ 6.
6 v1: 0 files changed outside src/ui/v2 + docs/feedback; `/` and `/swap` chunks Δ0 B, 0 v2 markers, route table
  identical.
  Suite 404/6423 (main) → 409/6485; lint 93 = 93; tsc 0; build 0. Compare: github.com/TeraHashAlpha/teraswap/compare/
  main...feat/ui-v2-portfolio
