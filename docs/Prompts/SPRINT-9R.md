# SPRINT-9R — Review-modal integrity (split-swap legs + frozen pendingSwap)

## Context (BASE-REVIEW 2026-06-04, both chains — not Base-specific)
Two signing-trust findings from `Audits/BASE-REVIEW-2026-06-04.md`:
- **H — split-swap signs every leg with NO Review modal** (`useSplitSwap.ts:291,310,319`). The user
  receives N wallet prompts for calldata they never reviewed in the TeraSwap UI. (This was the
  "transactions go straight to the wallet" report — NOT the 9O fallback, which correctly rebuilds
  pendingSwap and re-presents review.)
- **M — the single-swap Review modal renders LIVE Send/Receive state, not the frozen `pendingSwap`**.
  After a 9O fallback (source switch), the modal can describe a DIFFERENT route/amounts than the
  calldata actually being signed.
Principle: **no wallet signature without a TeraSwap review of the exact frozen calldata being signed.**

## R1 — Split-swap review
Before ANY split-leg signature: present a split review — one aggregate "Review Split Plan" modal
listing EVERY leg (source, send/receive amounts, min output, router, validated selector — the same
trust surface as the single-swap modal), confirmed once; then each subsequent wallet prompt must map
1:1 to a reviewed leg. If any leg is REBUILT after review (retry/fallback/price refresh → calldata
changed), that leg's review is stale → re-present (per-leg re-review) before its signature. Reuse the
existing Review components/decoders (calldata-decoder, selector validation, recipient gate display).

## R2 — Frozen modal data
The single-swap Review modal must render exclusively from the frozen `pendingSwap` snapshot (the
calldata that will be signed): source, send/receive, min output, selector, router, fee route. It must
NOT read live quote state. After a 9O fallback rebuild, the modal shows the NEW frozen route. Add a
test asserting modal contents == decode of the signed calldata (including the post-fallback case).

## Tests (TDD)
- Split: no leg signature reachable without the plan review; rebuilt leg forces re-review; modal lists
  all legs with per-leg validation.
- Single: modal renders frozen pendingSwap; live-state changes after freeze do NOT alter the modal;
  post-fallback modal == switched source's calldata decode.
- Both chains (the components are chain-agnostic; just don't regress 9Q's chainId threading).

## Do NOT
- No changes to safety gates, simulation, FeeCollector routing, adapters, selectors, contracts, or the
  9O fallback/9Q reads. Display + flow-control only.
- Mainnet/Base behaviour identical except the intended review-flow additions. Keys server-only.
- Branch `feat/sprint-9r-review-integrity`, atomic SSH-signed commits, CI green, append FEEDBACK.
- **Auditor light review before prod** (signing-trust UX: confirm no signature path bypasses review,
  frozen-snapshot rendering is faithful to the calldata, and the re-review trigger covers every rebuild
  path). Live wallet taps are an OWNER post-merge step — do everything automatable and STOP (no loop).
