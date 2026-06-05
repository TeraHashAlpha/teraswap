# SPRINT-9U — EIP-712 clear-signing review (CoW orders + Limit/DCA/SL-TP)

## Context
9R enforced the principle "**no wallet signature without a TeraSwap review of the exact frozen payload
being signed**" for TRANSACTION signatures. The 9R FEEDBACK flagged the remaining gap: **EIP-712
typed-data signatures** still bypass review:
- **CoW swaps** — the user signs a CoW ORDER (typed data), not a tx; today the wallet shows raw typed
  data with no TeraSwap review modal.
- **Order Engine (Limit / DCA / SL·TP)** — order creation signs an EIP-712 order; same gap. (Order
  engine is mainnet-only today — keep it so.)

## U1 — CoW order review
Before requesting the EIP-712 signature, present the review modal rendering the DECODED frozen order:
sell/buy token + amounts (human units), receiver, validTo (human time), feeAmount, partnerFee/appData
summary, settlement contract address, and the MEV-protection framing. Render exclusively from the
frozen order struct that will be signed; add a test asserting modal contents == the signed payload
fields. Any rebuild (re-quote) invalidates the review → re-present.

## U2 — Order Engine review
Same for Limit/DCA/SL·TP creation: modal renders the typed-data fields — order type, token pair,
amounts, trigger/limit price, expiry, minAmountOut, router constraint, nonce — from the frozen struct;
re-review on rebuild; signature only reachable from the reviewed state. Reuse the 9R review components
and state pattern (awaiting-review → confirm), including the chain/account-switch invalidation
(prevChainIdRef/prevAddressRef) defense from 9R.

## Tests (TDD)
- No EIP-712 signature path reachable without review (CoW swap, each order type).
- Modal == signed payload (field-by-field), incl. post-rebuild.
- Chain/account switch with modal open invalidates (mirrors 9R remediation).
- No behavioural change to order execution/validation itself — display + flow-control only.

## Do NOT
- No changes to order-engine contracts, EIP-712 domains/structs, CoW order construction, gates,
  adapters, or 9R/9Q/9S work. Signing FLOW only.
- Mainnet/Base behaviour identical except the added review step. Keys server-only.
- Branch `feat/sprint-9u-eip712-review`, atomic SSH-signed commits (U1, U2 separate), CI green, append
  FEEDBACK. **Auditor light review before prod** (signing-trust: no bypass, faithful rendering,
  rebuild/chain-switch invalidation). Live signature taps are OWNER post-merge steps — do everything
  automatable and STOP (no loop).
