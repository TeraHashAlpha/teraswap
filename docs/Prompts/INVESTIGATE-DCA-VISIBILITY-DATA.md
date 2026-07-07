# INVESTIGATE-DCA-VISIBILITY-DATA — is DCA history/positions/stats frontend-only, or does the recording need enriching? (READ-ONLY)

> **Product asks:** (2) show **DCA fills in History** (today only wallet swaps appear; DCA fills are keeper-executed
> → invisible); (3) show **completed DCA positions in Orders→Completed** with per-position **stats** (average buy price
> / cost-basis, total invested, total received, # fills executed/planned, date range, % complete, and the payoff:
> **P&L vs current spot**). Both read the same source (`orders` + `order_executions`). Before speccing any UI, confirm
> the data exists. **READ-ONLY: no code / schema / keeper change.** SSH-signed report.

## Objective
Map the DCA data model, reconcile the existing specs, and report whether #2/#3 are **frontend-only** or need the
keeper's execution recording **enriched first** (per-fill amounts/price). Change nothing.

## Requirements
1. **Supabase schema (read-only).** Dump the columns of **`order_executions`** — does each fill store `amount_in`,
   `amount_out`, `price/rate`, token in/out, `chainId`, timestamp, `tx_hash`, gas? — and **`orders`** — the params
   (input/output token, total, number_of_buys, interval, expiry) + the **status lifecycle** (active / completed /
   cancelled; how/when completion is set). Use the service-role read via the existing API (do NOT expose the key).
2. **Per-stat feasibility.** For each proposed stat — avg buy price (cost-basis), total invested, total received,
   fills executed/planned, date range, next fill, % complete, **P&L vs current spot** — state **computable from
   existing columns** vs **needs a field added to the fill recording** vs **derivable on-chain**. The killer stat
   (P&L vs spot) needs a live price → confirm the **Chainlink/DefiLlama plumbing (#18/#248) is reusable**.
3. **Reconcile the existing specs** — `CHORE-DCA-POSITIONS-DASHBOARD.md`, `CHORE-ANALYTICS-DCA-EXECUTIONS.md`,
   `CHORE-KEEPER-RECORD-EXECUTIONS.md`: what's **implemented on main** vs planned vs stale; do they already cover
   #2/#3? (Avoid duplicating / contradicting.)
4. **`Completed (0)` root cause.** Why does Orders→Completed show 0 — no order has reached completed status, a wrong
   query/filter, or completed positions simply aren't surfaced? Trace the Orders-tab data path.
5. **History source.** How is **Swap History** sourced (local store / on-chain query of the wallet / Supabase)? — to
   know how to surface DCA fills for #2 (a "DCA fill" badge/filter in the same feed vs a merged query).
6. **Deliver a report:** the schema, the per-stat feasibility table, the spec reconciliation, the Completed-0 root
   cause, the History source, and a clear recommendation — **is DCA visibility frontend-only, or does the keeper
   recording need a minimal enrichment first (and exactly which fields)?**

## Do NOT
- No code / schema / keeper change — diagnose only. Don't expose the service-role key or any secret. Don't touch the
  execution/settlement path.

## Files / areas (read-only)
- Supabase `order_executions` + `orders` schema; the `src` Orders / History / DCA components + their data hooks; the
  keeper's execution-recording path (`executor.js`); the 3 existing specs in `docs/Prompts/`.

## Expected output
- A committed read-only report (SSH-signed, e.g. `Audits/Reviews/DCA-VISIBILITY-DATA-2026-07.md`) + FEEDBACK with the
  **frontend-only-vs-enrich verdict**, the proposed stats set with each one's compute path, and the reconciliation
  against the 3 existing specs. No behaviour change.

## Quality criteria
Every proposed stat has a computable / needs-field / on-chain verdict; the 3 existing specs are reconciled; the
Completed-0 is root-caused; the History source is identified; a clear frontend-only-or-enrich recommendation; zero
changes.

---

### `/goal` paste for the Code Agent (≤4000)
```
INVESTIGATE-DCA-VISIBILITY-DATA per docs/Prompts/INVESTIGATE-DCA-VISIBILITY-DATA.md.
READ-ONLY — no code/schema/keeper change. Branch off origin/main, SSH-signed;
commit a report only. Do NOT expose the service-role key or any secret.

Product asks: (2) show DCA fills in History (today only wallet swaps appear; DCA
fills are keeper-executed -> invisible); (3) show completed DCA positions in
Orders->Completed with per-position stats (avg buy price/cost-basis, total
invested, total received, # fills executed/planned, date range, % complete, and
P&L vs current spot). Both read orders + order_executions. Confirm the data exists
before any UI spec.

Do:
1. Dump the Supabase schema (read-only, service-role via the existing API): 
   order_executions per-fill fields (amount_in, amount_out, price/rate, tokens,
   chainId, timestamp, tx_hash, gas?) and orders (params + status lifecycle
   active/completed/cancelled + how completion is set).
2. Per-stat feasibility: for avg buy price, total invested, total received, fills
   executed/planned, date range, next fill, % complete, P&L vs current spot — mark
   computable-from-existing / needs-a-recorded-field / derivable-on-chain. Confirm
   the Chainlink/DefiLlama price plumbing (#18/#248) is reusable for P&L.
3. Reconcile the existing specs CHORE-DCA-POSITIONS-DASHBOARD.md,
   CHORE-ANALYTICS-DCA-EXECUTIONS.md, CHORE-KEEPER-RECORD-EXECUTIONS.md: implemented
   on main vs planned vs stale; do they already cover #2/#3?
4. Root-cause Orders->Completed = 0 (no completed order / wrong filter / not
   surfaced): trace the Orders-tab data path.
5. Identify how Swap History is sourced (local store / on-chain / Supabase) -> how
   to surface DCA fills for #2 (badge/filter vs merged query).

Deliver a report (e.g. Audits/Reviews/DCA-VISIBILITY-DATA-2026-07.md): schema, the
per-stat feasibility table, the spec reconciliation, the Completed-0 root cause, the
History source, and the recommendation — is DCA visibility FRONTEND-ONLY or does the
keeper recording need a minimal enrichment first (exactly which fields). No changes.
```
