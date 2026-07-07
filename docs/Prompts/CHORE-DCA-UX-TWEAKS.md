# CHORE-DCA-UX-TWEAKS — DCA presets (buys/interval) + scrollable category chips

## Context
Now that DCA executes end-to-end on Base, three small UX tweaks requested by the owner. Pure UI — no order
engine / contract / keeper changes.

## Requirements
1. **DCA panel — "Number of buys" presets:** change to **3, 5, 10, 15, 20, 30** (currently 3, 5, 7, 10, 14, 30
   — drop 7 + 14, add 15 + 20). KEEP the existing per-chunk `MIN_ORDER_AMOUNT` floor validation: more buys =
   smaller chunks, so if a chosen total ÷ buys puts a chunk under the floor, show the existing min hint and
   block submit (don't let an un-executable order be signed).
2. **DCA panel — "Interval" presets:** **add `1h`** (3600s) as the first option → `1h, 4h, 8h, 12h, 1d, 3d, 7d`.
   (Server already accepts dcaInterval ≥ 60s, so 1h is valid.)
3. **Token selector — category chips:** make the category row (Native, Stablecoin, Wrapped BTC, Liquid
   Staking, …) **horizontally scrollable** (overflow-x / swipe side) so all categories are reachable when they
   overflow the width. Keep it touch-friendly on mobile, no wrap/layout break, no clipped last chip.

## Verify
- DCA shows 3/5/10/15/20/30 buys; selecting 20 or 30 with a small total triggers the min-chunk hint (floor
  still enforced).
- Interval shows 1h first; a 1h DCA creates + the keeper executes on the 1h schedule.
- Category chips scroll horizontally to reveal all categories (desktop drag/scroll + mobile swipe); no clipping.
- Existing DCA tests green; add/adjust tests for the new preset sets + the floor at high buy counts.

## Do NOT
- Don't touch the order engine, contract, or keeper. Don't remove the MIN_ORDER_AMOUNT floor validation.
  Don't regress the balance line / quick-fill % / always-visible expiry from #216.

## Files affected (verify on main)
- DCA panel component (buys + interval preset arrays).
- Token selector category-chips row (styling: overflow-x-auto + scroll affordance).

## Expected output
- Branch `chore/dca-ux-tweaks` off latest `origin/main`; SSH-signed; CI green; tests for the new presets +
  floor at 20/30 buys; FEEDBACK. No Auditor (pure UI).

## Quality criteria
Buys = 3/5/10/15/20/30 with the floor enforced; interval includes 1h; category chips scroll horizontally with
no clipping; no regression to the other DCA/selector UX.
