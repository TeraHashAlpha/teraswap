# SPRINT-9S — Base oracle coverage + warning UX + chain-aware polish

## Context
`Audits/BASE-REVIEW-2026-06-04.md` Phase-2 items + a live UX report: on Base, USDC→ETH now executes
(9Q) but shows "⚠ No Chainlink oracle for USDC" — TWICE, stacked, in yellow — creating user anxiety.
Owner's (correct) observation: ETH→USDC validates fine, so USDC→ETH must be able to use the same
feeds — pair validation needs X/USD and Y/USD and is direction-agnostic. The Base feed map
(`chainlink-feeds.ts:19-25`) is simply missing the major tokens, and the lookup appears to validate by
the INPUT side only.

## S1 — Base Chainlink feed map (ORACLE CONFIG — rule #9, Auditor light review)
Add the official **Base mainnet** Chainlink feeds for the catalog majors: USDC/USD, DAI/USD, cbETH
(cbETH/USD or cbETH/ETH composed — pick what Chainlink officially publishes on Base), USDbC. For EACH
address: verify 3 independent ways (Chainlink official docs/data.chain.link + an on-chain read of
`description()`/`decimals()` on Base + cross-reference a second source). Wrong feed address = wrong
validation, so treat addresses like the 9H selectors: no guessing, evidence in the commit message.
Keep staleness/`startedAt` guards exactly as 9G left them.

## S2 — Direction-agnostic validation + ONE calm warning
- Verify (and fix if needed) that pair validation uses BOTH tokens' feeds regardless of which side is
  input — selling or buying USDC must behave identically.
- Deduplicate the warning: ONE notice instead of two stacked yellow boxes saying the same thing. Copy
  should be calm and specific: name the token(s) actually missing a feed and state that multi-source
  comparison + on-chain minimumOutput still protect the swap. Keep it prominent ONLY for genuinely
  unfeeded tokens (e.g. exotic imports) — that warning is correct and must stay.

## S3 — Chain-aware polish (from the review, M-rated)
- Explorer links: tx/address links must be chain-aware (etherscan.io ↔ basescan.org) everywhere
  (toasts, history, badges — grep for hardcoded etherscan).
- Analytics: tag events/rows with chainId so Base and mainnet data don't blend.
- Circuit breakers: per-chain state — a source failing on Base must not open the breaker for mainnet
  (and vice versa).
- Bebop silent-off: diagnose why Bebop returns nothing on Base (env key present? demo-mode? adapter
  skip?) — fix if config-side is fine, else report exactly what the owner must set.

## Tests (TDD)
- Feed map: each new feed resolves on Base (mocked client), staleness guard intact; mainnet map
  untouched (byte-identical).
- Validation: USDC→ETH and ETH→USDC produce identical oracle verdicts; missing-feed token still warns.
- Warning: renders once; names the missing token; absent when both feeds exist.
- Explorer links per chain; breaker isolation per chain; analytics rows carry chainId.

## Do NOT
- No changes to gate thresholds/manipulation logic — S1/S2 add coverage and fix symmetry, they do NOT
  loosen anything. No FeeCollector/adapter/selector/contract changes. No 9Q/9R regressions.
- Mainnet byte-identical (test-guarded). Keys server-only.
- Branch `feat/sprint-9s-base-oracle-polish`, atomic SSH-signed commits (S1 separate from S2/S3), CI
  green, append FEEDBACK. **Auditor light review of S1** (feed addresses + no gate loosening) before
  prod. Live checks in a browser are OWNER post-merge steps — do everything automatable and STOP.
