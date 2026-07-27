# FIX-DCA-MIN-BUY-COPY

Make the DCA per-buy minimum error human-readable and actionable. **Copy/presentation only** —
`MIN_ORDER_AMOUNT` and its validation are untouched.

- **Branch:** `fix/dca-min-buy-copy` (off `origin/main` @ `ba20806`), SSH-signed

---

## Context

The DCA form rejected small buys with `"Each DCA buy must be at least 10 000 base units (the
on-chain minimum). Increase the total amount or reduce the number of buys."` — developer-speak.
Users don't know what a "base unit" is, or what buy count / total actually clears the floor. The
minimum is a fixed count (10,000) of the token's smallest units, so its human/USD value depends on
decimals + price (e.g. ~$14 for a BTC-like token at 8 dec).

## Requirements

1. `formatMinBuyUnit` + `formatMinBuyMessage` — new pure functions in
   `src/lib/dca-quick-fill.ts` (the existing per-buy-minimum validation util, already home to
   `perChunkRaw`). Given the floor (base units), decimals, symbol, current total, requested buy
   count, and an optional USD price, they return: the floor in the token's own units, its approx
   USD (when priced), and a concrete fix — `floor(total / floor)` max buys the current total
   supports, or the min total needed for the requested buy count.
2. `DCAPanel.tsx`'s inline warning and `useOrderEngine.ts`'s `createOrder` toast (the ACTUAL
   source of the toast copy — the client-side pre-sign floor guard) both call
   `formatMinBuyMessage`, so they render identical copy from one source instead of two hand-written
   duplicate strings.
3. Price source: `APPROX_PRICES` (`lib/order-engine/usd.ts`) — the SAME table `DCAPanel`'s
   `totalUsd` already uses. Unpriced symbol → `priceUsd: null` → token-units-only copy, no
   fabricated USD (mirrors the existing "do not fabricate USD" rule `fillUsd` already follows).

## Do NOT

- Change `MIN_ORDER_AMOUNT` (10,000) or any validation/on-chain logic.
- Touch the contract.
- Alter other DCA behaviour (schedule-fit guard, min-chunk-USD dust guard, etc. — untouched).

## Files affected

- `src/lib/dca-quick-fill.ts` (+ `.test.ts`) — new `formatMinBuyUnit`/`formatMinBuyMessage`.
- `src/hooks/useOrderEngine.ts` — `createOrder`'s pre-sign floor guard now builds its toast text
  via `formatMinBuyMessage`/`formatMinBuyUnit` instead of a hand-written string.
- `src/components/DCAPanel.tsx` (+ `.test.tsx`, `.ux-polish.test.tsx`) — inline warning now renders
  `formatMinBuyMessage(...).text` instead of the old hardcoded paragraph.

## Expected output

Example: `"Each buy is too small. With cbBTC, each buy must be at least 0.0001 cbBTC (~$14.00) —
the on-chain minimum. Lower to 5 buys, or raise your total to ~$70.00."` Price-unavailable fallback
drops the `(~$…)` / `~$…` clauses, staying in token units only.

## Quality criteria

- Unit tests cover cbBTC (8 dec), USDC (6 dec), WETH (18 dec) + the price-unavailable fallback.
- Existing `/on-chain minimum/i` integration assertions (DCAPanel) still hold — extended to also
  assert the new token-unit/USD/max-buys shape.
- Full suite green (pre-existing unrelated failure: `connect-modal-qr.test.ts` — missing `cuer`
  package in `node_modules`, not installed in this worktree, untouched by this change).
