# ADR-015-ORDER-EXECUTION-ECONOMICS — user-pays-gas, per-type fees, and the v4 cut

> **Source:** owner decisions fixed 2026-07-23 over two rounds, after the first production v3 DCA fills each
> cost ~$4 in gas (dominated by L1 data fees on fat aggregator calldata) against $0.01–0.02 of protocol fee
> — DCA is structurally loss-making per fill. The decisions are **fixed**: this ADR records them as
> DECISIONS, not options, and specifies the mechanism that implements them.
> **Deliverable = `docs/ADR/ADR-015-order-execution-economics.md` (status: Proposed, ≤3 pages) + this spec
> note. NO code, contract, runbook or live-config change.** Architect adjudicates; a fund-flow Auditor pass
> (0C/0H) and the calibration report gate any implementation.

## Owner decisions recorded (D1–D6)
1. **Scope philosophy (standing):** small controlled increments; v4 scope driven by the live DCA product;
   SL/TP/Limit ride along only at ~zero marginal cost. **Batching OUT of v4 core** — study section only.
   Several small audited deploys over one big one.
2. **User pays gas**, deducted from posted order value, capped on-chain by the signed "Max execution cost"
   budget. **Estimate-with-cap**, never keeper-self-reported; gas over cap ⇒ **defer, never execute**. Fee
   per execution on each chunk's value. Gas priced in a token needs an oracle ⇒ specify the no-feed fallback.
3. **Fees:** simple swap 0.1% (unchanged); DCA/Limit/SL·TP **0.20%**. **Transparency is a product
   invariant**: full receipt per execution; **no "free"/"gasless" claim ever**; fee rises are owned publicly.
4. **Attack gas, not fees:** compact canonical routes + net-cost routing (user's net *including* gas) ship
   **keeper-side before v4**.
5. **Fees UI** = dated best-effort estimates, ours vs competitors' *effective* cost (EVM only, never named,
   no Solana). **New requirement — settlement receipt:** exact realised costs on DCA completion/cancel.
   Read-only, **v4-independent**, shippable on v3 data now.
6. Contract-side changes consolidate with Stop-Loss (ADR-014 option b) into **one v4**, cut so the **DCA
   slice leads and SL cannot delay it**. DCA stays flag-off until v4.

## Requirements (what the ADR must specify)
1. **v4 mechanism sketch:** estimate source (non-self-reported), output/input-token conversion, cap
   enforcement, keeper reimbursement flow, keeper token-dust treasury note, defer semantics.
2. **Fee-constant structure:** per-orderType compile-time constants **vs** timelock-configurable — recommend
   one and justify it.
3. **v3 → v4 migration:** drain rules, what launches day one, how SL rides without gating DCA.
4. **Invariants preserved:** `recipient == owner`, oracle floor, router whitelist, exact approvals.
5. **v4.1 batching study:** feasibility, fairness, failure isolation.
6. **Open questions** cross-referenced to `docs/Reports/FILL-ECONOMICS-CALIBRATION.md` — its numbers fill the
   cost tables when it lands.

## Do NOT
Write or change any code, contract, runbook or live config; touch v3/v4 deploy state; open a PR
(branch `adr/015-execution-economics` pushed + compare link; the owner opens it).

## Files affected (read ONLY these + new)
Read-only: `contracts/order-engine/TeraSwapOrderExecutorV3.sol`, `docs/ADR/ADR-013-*`, `docs/ADR/ADR-014-*`,
`docs/Prompts/SPRINT-KEEPER-FILL-ECONOMICS.md`, `src/lib/order-engine/budget-slippage.ts` + its `DCAPanel`
wiring. New: `docs/ADR/ADR-015-order-execution-economics.md`, this spec note.

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the v4 mechanism sketch (one paragraph), the
fee-structure recommendation, the DCA-first cut of v4, and the open questions left for calibration.
