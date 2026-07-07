# CHORE-DCA-UX-FIXES — 3 DCA order-creation UX bugs (balance, approve→sign, failed/unroutable)

## Context
Live testing surfaced 3 frontend bugs in the DCA order flow (no contract/keeper involvement):
1. The "Balance:" line shows **"—" for imported/unverified tokens** (e.g. ETHFI `0x6c24…2aa2` on Base) even
   when the wallet holds them — the balance read only covers curated tokens.
2. A DCA on an **unroutable** pair (ETHFI→ETH on Base — thin/imported, no Augustus route) was signable, then
   the keeper reverted `executeOrder` → 3 retries → marked failed → the position **silently vanished** from the
   UI with no reason.
3. After the one-time **Approve** tx confirms, the flow **doesn't advance to "Sign"** — it hangs on
   "APPROVE <token>"; the user must leave + re-enter the tab to proceed.

## Requirements
1. **Balance for any selected spend token.** Show the connected wallet's balance of the SELECTED spend token —
   curated OR imported/unverified — via a direct `useReadContract balanceOf` / `useBalance` for that token's
   address + chain. Only "—" while loading or disconnected; never blank for a valid-but-non-curated token.
   Keep the 25/50/100% quick-fill working off this balance.
2. **Approve → Sign auto-advance.** After the approve tx is submitted and **confirmed on-chain**, re-read the
   allowance and **automatically advance to the Sign step** — no manual refresh / tab re-entry. Handle states:
   approve pending (spinner), confirmed (advance), rejected/failed (clear error + retry). Use the tx receipt /
   allowance re-fetch to drive the transition.
3. **Routability pre-check + visible failed state.**
   - **Pre-check at creation:** before enabling Approve/Sign, verify `/api/quote` can produce a route for the
     pair on the target chain (Base). If NO route (thin/imported token, no aggregator coverage), **warn clearly
     and block** — don't let the user approve/sign an un-executable order. Surface it for imported/unverified
     (⚠️) tokens especially.
   - **Failed orders don't vanish:** when the keeper marks an order failed (max retries), show it as **"Failed"**
     in Positions/Orders with a reason if available (e.g. "no route / swap failed"), not a silent disappearance.

## Do NOT
- Don't change the contract or keeper. Routability check uses the existing `/api/quote`. Don't regress the
  #215 approve-then-sign or the #216 balance/quick-fill/expiry for routable curated tokens.

## Files affected (verify on main)
- DCA panel + the shared OrderReviewModal (approve-then-sign, #215) + the balance line (#216) + the
  Positions/Orders list (failed-state rendering) + the order-create routability gate.

## Expected output
- Branch `chore/dca-ux-fixes` off latest `origin/main`; SSH-signed; CI green; tests (balance for imported token;
  approve→sign auto-advance; unroutable pair blocked + failed-order shown); FEEDBACK. No Auditor (UI).

## Quality criteria
Balance shows for any held spend token incl. imported; approve auto-advances to sign without refresh; an
unroutable pair is blocked before signing and a failed order is shown as "Failed" with a reason, never vanishes.
