# BASE-REVIEW 2026-06-04 — End-to-end review of the Base (8453) swap path

Read-only investigation (NO code edits). Output: `Audits/BASE-REVIEW-2026-06-04.md` with findings
rated C/H/M/L/I + a prioritized fix plan (RICE-ready) the Architect will triage into sprints.

## Why
Base shipped on a codebase hardened for mainnet over many sprints. 9G made the SAFETY gates
chain-aware, but the swap-flow/UX layer keeps surfacing chain-pinned corners (token catalog 9C/9E,
import/badges 9P). Live symptoms now cluster on Base; instead of fixing one at a time, sweep the whole
Base path.

## Phase 1 — FIRST, the live swap blocker (report this before the rest)
**Symptom:** on Base, USDC→ETH fails pre-swap simulation ("Simulation reverted") on Velora AND
KyberSwap; the 9O fallback fires ("velora couldn't execute this route — switched to uniswapv3") and the
next source ALSO fails. ETH-input swaps (e.g. →ETHfi) work.
**Hypothesis to verify first:** the ERC20-INPUT path on Base is broken — allowance/spender resolution
is chain-unaware (mainnet allowance/spender read on Base, or wrong per-chain spender), so the UI says
"No approval needed", the sim runs without allowance, `transferFrom` reverts → conclusive revert on
every source. Trace end-to-end: spender resolution per chain (/api/spender?), allowance read (which
client/chain), Permit2 path on Base, `buildSimulationTx` for token-in via `swapTokenWithFee`, and how
mainnet avoids this (sim ordering vs approval). Identify the exact broken link and the minimal fix.

## Phase 2 — Systematic sweep (each = finding w/ severity + file:line)
1. **Oracle coverage on Base.** The app shows "No Chainlink oracle for USDC" on Base — but Base HAS a
   USDC/USD feed. Inventory the per-chain Chainlink feed registry: which Base feeds exist vs which the
   catalog tokens need (ETH, USDC, USDbC, DAI, cbETH, WETH…). List missing mappings (data gap, easy
   fix) vs structural issues. Same for the DefiLlama slug coverage of Base catalog tokens.
2. **Review-modal bypass.** Some transactions reach the wallet WITHOUT the TeraSwap "Review
   Transaction" popup; others show it. Audit EVERY path that ends in a wallet signature (normal swap,
   9O fallback re-entry, split swap, retry, approval txs): each route/source change MUST re-present the
   review modal with the new calldata before signing. Flag any path that auto-sends. (Prime suspect:
   the 9O Part B fallback re-entry.)
3. **Chain-pinned residue sweep** of the swap UX layer on Base: allowance/approval UI state, balances,
   gas estimate display (Est. gas shows ~$0.00 on Base — legit cheap L2 or broken estimate? verify),
   USD pricing, tx status/receipt polling, explorer links, analytics logging — anything still
   hardcoding mainnet (chainId 1, mainnet client, etherscan, mainnet token list).
4. **Base-vs-mainnet parity table** for the full swap lifecycle (quote → compare → oracle check →
   approval → review → sim → send → receipt → history): for each step, chain-aware? tested? Where are
   the Base-specific tests thin?
5. **Source behaviour on Base:** which of the 12 sources actually quote/execute on Base; breaker states
   correct (sushiswap/cowswap expected-open); Bebop status (key present?).

## Method
- Read-only: code + tests + (where possible) Base mainnet reads via the configured RPC. NO live swap
  sends (human/wallet steps are owner-side — note them, don't loop).
- Severity honestly relative to BASE BEING LIVE (no "coming soon" discount — lesson from the
  2026-06-02 full audit re-rating).
- Each finding: file:line, severity, why, suggested fix, effort (S/M/L).

## Output
`Audits/BASE-REVIEW-2026-06-04.md`: Phase-1 root cause up top (flagged URGENT), findings table,
parity table, prioritized fix plan. Append FEEDBACK with anything the prompt missed. No code edits,
no contract calls that mutate state, signed commit for the report doc only.
