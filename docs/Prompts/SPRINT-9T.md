# SPRINT-9T — Partner fees for 0x + CoW (uniform 0.1% across all sources)

## Context (revenue gap, owner-confirmed 2026-06-04)
FEE_INCOMPATIBLE_SOURCES (0x, CoW, Bebop) bypass the FeeCollector contract by design (their
settlements take custody — can't be wrapped). Monetization for them must use each protocol's NATIVE
partner-fee mechanism. Current state in code:
- **Bebop** ✅ wired: `fee` (bps) + `fee_recipient = FEE_RECIPIENT` (bebop.ts:111).
- **CoW** ❌ only `metadata.referrer` (attribution, NOT a fee) — cow.ts:176. Revenue: zero.
- **0x** ❌ no fee params at all (zerox.ts). Revenue: zero.
Side effect: 0x/CoW quote WITHOUT our 0.1% → artificial +0.1% edge in Compare vs fee-routed sources
(skews win-rates). Goal: uniform 0.1% on every source, paid to `0x107F6eB7C3866c9cEf5860952066e185e9383ABA`
(NEXT_PUBLIC_FEE_RECIPIENT / FEE_RECIPIENT — use the env/constant, do NOT hardcode).

## T1 — 0x adapter
Add the 0x API v2 swap-fee params to quote + swap-build requests: `swapFeeRecipient = FEE_RECIPIENT`,
`swapFeeBps = <the standard fee bps constant — reuse the same constant the FeeCollector/Bebop use, no
new magic number>`, and `swapFeeToken` per the 0x docs (pick sell-token side to mirror FeeCollector
behaviour of charging on input; document the choice). The returned quote already reflects the fee —
verify the normalized output is post-fee so Compare is honest. Both chains (1 + 8453) where 0x quotes.

## T2 — CoW adapter
Add the CoW partner fee to the appData JSON: `metadata.partnerFee = { bps: <same constant>, recipient:
FEE_RECIPIENT }` alongside the existing referrer. CRITICAL: appData string ⇄ `appDataHash` consistency
is validated (cow.ts:63-65) — build the appData exactly per CoW's appData schema version that supports
partnerFee, and keep quote-time and order-time appData identical. If the CoW API rejects the
partnerFee schema, FAIL-SOFT to the current appData (quote still works, log a structured warning) —
never break CoW quoting over the fee.

## T3 — Consistency + no double-charge
- One source of truth for the bps across FeeCollector / Bebop / 0x / CoW.
- Assert FEE_INCOMPATIBLE_SOURCES still bypass the FeeCollector contract (no double-charging: partner
  fee + FeeCollector fee must be mutually exclusive — add a test).
- Compare/win-rate fairness: all sources' normalized `toAmount` are now post-our-fee. Update any test
  fixtures that assumed fee-free 0x/CoW quotes.

## Tests (TDD)
- 0x request carries the three fee params; normalized quote reflects post-fee output.
- CoW appData includes partnerFee + hash consistency holds; API-reject path fails soft to current
  behaviour.
- No double-charge invariant. Bebop unchanged. Mainnet + Base. Fee bps constant shared.

## Do NOT
- No contract changes, no FeeCollector/selector/gate changes, no change to which sources are
  FEE_INCOMPATIBLE. Do not hardcode the recipient (env/constant only). Keys server-only.
- Branch `feat/sprint-9t-partner-fees`, atomic SSH-signed commits (T1, T2 separate), CI green, append
  FEEDBACK. **Auditor light review before prod** (fund-flow: correct recipient everywhere, shared bps,
  no double-charge, fail-soft can't zero out an order's validity). Live fee-arrival check on DeBank/
  explorer is an OWNER post-merge step — do everything automatable and STOP (no loop).
