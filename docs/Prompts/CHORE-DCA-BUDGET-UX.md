# CHORE-DCA-BUDGET-UX — "max execution cost" in dollars on the DCAPanel, mapped to the signed maxSlippageBps

> **Source:** owner design 2026-07-22 (adopted; see SPRINT-KEEPER-FILL-ECONOMICS.md for the full arc). The
> user sets a MAX TOTAL EXECUTION COST in $ for the whole DCA (e.g. $2 on $100); we map it to the
> ALREADY-SIGNED `maxSlippageBps` — the on-chain oracle floor then enforces it trustlessly. This chore
> ships the FRONTEND half only; the keeper route-preference/gate half stays in the blocked sprint (after
> P1b). **Do NOT touch executor.js / keeper / api routes / LimitOrderPanel / ConditionalOrderPanel /
> useOrderEngine signing internals** (P1b owns those surfaces). Display+derivation only, fail-closed →
> Auditor note in the PR body. SSH-signed; branch `chore/dca-budget-ux`, dedicated worktree; 2 droppable
> commits. **Exit = push + compare link; owner opens the PR.**

## Requirements
1. **bps↔$ util** (new small module in src/lib/order-engine, no edits to existing config exports):
   `budgetUsdToBps(totalNotionalUsd, budgetUsd)` = clamp(round(budget/notional × 10000), MIN_FLOOR_BPS,
   500) and the inverse for display; unit tests incl. edges (tiny totals, clamp both ends, rounding).
2. **DCAPanel input:** "Max execution cost" field ($, whole DCA) feeding the EXISTING maxSlippageBps config
   value the panel already derives/signs (PR #299 path) — no new signed fields, no signing changes; live
   breakdown copy: "up to $B total — includes the $F protocol fee (0.1%)"; sensible default = current
   DEFAULT_MAX_SLIPPAGE_BPS shown as $; the $5-economic-floor pre-flight message references the budget when
   relevant. Tests: input→bps wiring, clamp at 500 surfaces a warning, default unchanged when untouched,
   v2-mode (no v3 executor) hides the field, existing DCAPanel suites green and untouched otherwise.

## Do NOT
Touch executor.js/keeper, api routes, LimitOrderPanel/ConditionalOrderPanel, useOrderEngine, signing
struct/domains, order-engine config exports; open a PR.

## Files affected (read ONLY these + new)
`src/components/DCAPanel.tsx` + its tests, NEW util module + tests,
`docs/Prompts/CHORE-DCA-BUDGET-UX.md`. Read-only: SPRINT-KEEPER-FILL-ECONOMICS.md, order-engine config.

## Expected output
Branch + compare link. FEEDBACK ≤1 screen: the mapping function as landed, the panel copy, tests. Auditor
note: display/derivation only, signed struct untouched, keeper half deferred.
