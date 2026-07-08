# CHORE-DCA-VISIBILITY-AND-STATS — DCA fills in History + per-position stats (frontend + server-union)

> **Source:** the DCA recon (PR #276, `Audits/Reviews/DCA-VISIBILITY-DATA-2026-07.md`) — verdict **FRONTEND-ONLY, the
> keeper recording needs NO enrichment.** Each fill on `order_executions` already has `amount_in`/`amount_out`
> (decoded from the on-chain `OrderExecuted` event), the fee (0.1%), and `gas_used`; all 8 stats are computable and
> P&L-vs-spot reuses the existing price plumbing. Two product asks: **(2) DCA fills in History; (3) completed (+active)
> DCA positions with stats.** **DCA is Base-only (L2). Read-only display — no keeper/recording/execution/contract
> change.** Respect the **W6 read-auth** gating (the fills/positions are the user's own). SSH-signed. Two independent
> commits.

## Context (from the recon — build on it, don't re-derive)
- The data is real: the completed Base test DCA (`0x5449dea0`, WETH→ETHFI, 5/5 fills, daily 07-01→07-05) has per-fill
  amounts + fee + gas. `price_at_execution` is all-NULL and **irrelevant** — the realized rate comes from the amounts.
- `Completed(0)` is **data reality, not a bug** (the DB holds one ever-completed order, the test wallet's) — do NOT
  "fix" the Completed filter; it works.
- Existing + live (reuse, don't duplicate): `KEEPER-RECORD-EXECUTIONS`, `ANALYTICS-DCA-EXECUTIONS` (its union pattern),
  `DCA-POSITIONS-DASHBOARD` (active positions).

## Commit 1 — DCA fills in History (#2)
- Extend the History path (`/api/history`, today reads only the `swaps` table) to a **server-side union of
  `order_executions ⋈ orders` with `swaps`**, **swaps-first `tx_hash` dedup** — reuse the exact union pattern already
  proven in `/api/analytics`. Gate it behind the **W6 read-token** like the rest (a user sees only their own fills).
- In `WalletHistory`, render DCA fills with a **"DCA" badge** + a link/reference to the parent position. Keep instant
  swaps exactly as they are; the merged feed is ordered by time.

## Commit 2 — per-position stats (#3)
- On the position card (Orders → **Completed**, and **Active** via the existing dashboard), compute + show, **from the
  fills** (`amount_in`/`amount_out` per `order_executions` row):
  - **avg buy price / cost-basis** (Σ`amount_in` vs Σ`amount_out`, in the correct direction);
  - **total invested** (Σ`amount_in`), **total received** (Σ`amount_out`);
  - **fills executed / planned**, **date range** (first→last fill), **% complete**;
  - **P&L vs current spot** — reuse the existing price plumbing (`/api/portfolio/prices` DefiLlama, or the server-side
    Chainlink read) = `current_value(total_received) − total_invested`. **Non-alarmist**, clear (house style).
- Reuse the `DCA-POSITIONS-DASHBOARD` for active positions; add the same stats to completed.

## Also (small, fold in)
- Remove the **dead `fetchDCAExecutions`** (recon flagged it). Optionally add the missing **`failed` bucket** to
  `/api/orders/stats` (small). Do NOT touch the session-only instant-`SwapHistory` store here (separate item).

## Do NOT
- No keeper / recording / execution-gate / SC-04 / R1 / on-chain / contract change (the data already exists). Don't
  expose other wallets' fills (W6 read-auth). Don't "fix" the Completed filter (it's correct). Don't break instant
  swap history. Don't make the P&L cue alarmist.

## Files affected (verify on main)
- `/api/history` (union) + `/api/analytics` (read its union pattern); `WalletHistory` (DCA badge); the Orders →
  Completed/Active position card + the `DCA-POSITIONS-DASHBOARD`; the price plumbing (`/api/portfolio/prices`); remove
  `fetchDCAExecutions`; `/api/orders/stats` (optional failed bucket). Read the recon report + the 3 existing specs.

## Expected output
- Branch `chore/dca-visibility-and-stats` off latest `origin/main`; SSH-signed; CI green. Two commits (History fills;
  per-position stats). Tests: the union returns DCA fills deduped + W6-gated; the stats compute correctly for the known
  completed test DCA (`0x5449dea0`, WETH→ETHFI, 5/5) as a golden fixture; P&L uses a live price. FEEDBACK: the stat
  formulas + the reused analytics-union + the price source.

## Quality criteria
DCA fills appear in History (badged, deduped, W6-gated); completed + active positions show correct per-position stats
incl. avg buy price + P&L vs spot; the golden test DCA reconciles exactly; no keeper/contract/execution change; instant
swap history untouched; Base-only.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-DCA-VISIBILITY-AND-STATS per docs/Prompts/CHORE-DCA-VISIBILITY-AND-STATS.md.
Branch chore/dca-visibility-and-stats off origin/main, SSH-signed (noreply
committer), CI green, TWO independent commits. DCA is Base-only. Read-only display
— NO keeper/recording/execution/SC-04/R1/on-chain/contract change. W6 read-auth
gated. Build on the recon (PR #276) — the verdict is FRONTEND-ONLY, per-fill
amount_in/out + fee + gas already exist on order_executions.

Commit 1 — DCA fills in History (#2): extend /api/history (today reads only the
swaps table) to a server-side union of order_executions JOIN orders WITH swaps,
swaps-first tx_hash dedup — REUSE the union pattern already proven in /api/analytics.
Gate behind the W6 read-token (user sees only their own fills). In WalletHistory,
render DCA fills with a "DCA" badge + link to the parent position; keep instant
swaps as-is; order the merged feed by time.

Commit 2 — per-position stats (#3): on the Orders->Completed (and Active via the
existing DCA-POSITIONS-DASHBOARD) position card, compute FROM the fills
(amount_in/out per order_executions row): avg buy price/cost-basis (Sum amount_in
vs Sum amount_out, correct direction), total invested (Sum amount_in), total
received (Sum amount_out), fills executed/planned, date range (first->last fill),
% complete, and P&L vs current spot (reuse /api/portfolio/prices DefiLlama or the
server-side Chainlink read = current_value(total_received) - total_invested),
non-alarmist. price_at_execution is all-NULL — IGNORE it, use the amounts.

Also (small): remove the dead fetchDCAExecutions; optionally add the failed bucket
to /api/orders/stats. Do NOT touch the session-only instant SwapHistory store here.

Do NOT: keeper/recording/execution-gate/SC-04/R1/on-chain/contract change; expose
other wallets' fills (W6); "fix" the Completed filter (it's correct — the DB just
has one completed order); break instant swap history; alarmist P&L cue.

Files (verify on main): /api/history (union) + /api/analytics (read its pattern);
WalletHistory (badge); Orders Completed/Active card + DCA-POSITIONS-DASHBOARD;
/api/portfolio/prices; remove fetchDCAExecutions; /api/orders/stats (optional).
Tests: union returns deduped W6-gated DCA fills; stats reconcile for the golden
completed test DCA 0x5449dea0 (WETH->ETHFI, 5/5); P&L uses a live price. FEEDBACK:
the stat formulas + reused analytics-union + price source.
```
