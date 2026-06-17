# CHORE-CANCEL-REVIEW — EIP-712 review for order cancel/invalidate (9U follow-up)

## Context
9R + 9U enforced "no wallet signature without a TeraSwap review of the exact frozen payload" for swap
txs (9R) and order CREATION typed-data (9U: CoW orders + Limit/DCA/SL·TP create). The 9U FEEDBACK
flagged the remaining gap: **order CANCEL / INVALIDATE signatures are still un-gated** — the user signs
a cancel/invalidate EIP-712 message with no TeraSwap review modal. Close it.

## Scope
- Order Engine **cancel / invalidate** flows (Limit / DCA / SL·TP) — wherever the app requests an
  EIP-712 signature (or an on-chain cancel tx) to cancel or invalidate an existing order/nonce.
- CoW order cancellation if it also signs typed-data (check; include if present).
- **Chain-agnostic — do NOT hardcode mainnet.** Strategic direction (owner): Limit/DCA/SL·TP will be
  **L2-only (Base first)** — mainnet gas makes small conditional orders unviable. The review must work
  on whichever chain the order engine runs (Base when it activates there), via the active chain — never
  pinned to chainId 1. This complements, does not block, the L2-only activation.

## Fix (reuse the 9R/9U pattern exactly)
Before requesting the cancel/invalidate signature, present the review modal rendering the DECODED frozen
payload: action (Cancel / Invalidate), which order(s) — pair, amount, type, the order id/nonce being
invalidated, expiry — from the frozen struct that will be signed. Signature only reachable from the
reviewed state; re-review on any rebuild; include the 9R chain/account-switch invalidation
(prevChainIdRef/prevAddressRef + synchronous confirm-time re-check). Reuse the existing review
components/decoders — no new trust surface.

## Tests (TDD)
- No cancel/invalidate signature path reachable without the review state.
- Modal contents == the signed cancel/invalidate payload, field-by-field.
- Chain/account switch with the modal open invalidates the plan.
- No change to cancel/invalidate EXECUTION or order-engine logic — flow/display only.

## Do NOT
- No order-engine contract / EIP-712 domain-struct changes, no gates/adapters/swap changes. Mainnet/
  Base byte-identical except the added review step. Keys server-only.
- Branch `chore/cancel-invalidate-review`, atomic SSH-signed commits, CI green, append FEEDBACK.
  Signing-trust → **LIGHT Auditor review before prod** (no bypass, faithful frozen rendering, rebuild/
  chain-switch invalidation). Live signature taps are an OWNER post-merge step — do everything
  automatable then STOP (no loop).
