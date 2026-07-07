# CHORE-DCA-POSITIONS-DASHBOARD — captivating Positions dashboard with per-buy countdown

## Context
The DCA "Positions" tab lists active orders but is plain. Now that the keeper records fills to
`order_executions` (#232), we can show real progress + a **live countdown to each next buy**. Make it a
polished, captivating dashboard — this is the user's main "my DCA is working" view.

## Objective
A visually engaging Positions dashboard: each active DCA order as a rich card with progress, a live
**countdown timer to the next buy**, and the fills timeline.

## Requirements
1. **Per-order card** (active DCA orders): pair with **token logos** (reuse the existing `<TokenLogo>`), total
   to spend + per-buy amount, **progress (N of M fills)** as a ring or bar, the route/source badge (e.g.
   Velora), expiry, and per-fill **USD values**.
2. **Live next-buy countdown** (the centerpiece): a ticking **HH:MM:SS** until the next chunk executes.
   - Next buy time = (last fill `created_at` from `order_executions`) + `dcaInterval` − now; for 0 fills, use
     the order's schedule start + interval (or "first buy imminent" if it executes ASAP).
   - Tick every 1s, smooth, no layout jank. At ≤ 0 show "Executing soon…" (the keeper runs within ~30s of due).
3. **Fills timeline** per order: each fill = amountIn → amountOut, USD, route, **tx link** (BaseScan), time —
   newest first (reuse the data #228/#232 surface).
4. **Captivating + on-brand**: clean cards, a progress ring, the countdown prominent; subtle motion (a gentle
   pulse when < 60s to the next buy, smooth progress fill, soft hover). Match the dark theme + constellation
   aesthetic + green accents. **Responsive (mobile)**.
5. **States handled clearly**: active (countdown), executing (≤0), completed (all fills done), failed (with
   reason), cancelled. Empty state: a clean "No active DCA — start one" CTA.
6. **Live data**: read active orders + their `order_executions`; refresh progress/fills periodically (e.g.
   every 30s) while the countdown ticks client-side every 1s. Don't hammer the API.

## Do NOT
- Don't change the contract or keeper. Don't fabricate amounts/USD (use #228/#232 data + the order schedule).
  Don't regress the existing Positions/cancel behaviour.

## Files affected (verify on main)
- The DCA Positions tab component + its orders/`order_executions` read + the shared `<TokenLogo>` and route/USD
  helpers.

## Expected output
- Branch `chore/dca-positions-dashboard` off latest `origin/main`; SSH-signed; CI green; tests (countdown math
  incl. last-fill+interval and the 0-fill case; state transitions; no-jank tick); FEEDBACK. No Auditor (UI).

## Quality criteria
Each active DCA shows a live, accurate next-buy countdown + progress + fills timeline with logos/USD/tx links,
in a polished on-brand responsive card; states are clear; data is real (no fabrication); the timer is smooth.
