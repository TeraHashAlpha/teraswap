# SPRINT-9W-oracle — cbETH depeg circuit-breaker (market-vs-ExchangeRate divergence)

> NOTE: distinct from the merged SPRINT-9W (CoW wrapped-native). Named "9W-oracle" to avoid collision.
> Ships AFTER 9V (per-feed staleness) is merged — builds on its composed-feed + per-feed-staleness work.

## Rationale (Architect + owner, 2026-06-08)
For cbETH there are THREE live Chainlink feeds on Base (on-chain verified in 9V-M-01):
- `0x806b4Ac04501c29769051e42783cF04dCE41440b` — **CBETH/ETH market** (18 dec) — what cbETH trades at.
- `0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04` — **cbETH/ETH Exchange Rate** (18 dec) — protocol
  redemption rate; slow (24h heartbeat), manipulation-resistant, blind to market depeg.
- `0xd7818272…` — CBETH/USD direct (8 dec).
9V keeps the MARKET feed as the swap-price reference (correct: a swap guard validates against tradeable
price). This sprint ADDS a second, independent use of the Exchange Rate: a **depeg / manipulation
circuit-breaker** on the divergence between the two. In normal conditions market≈ER (<1%); a large gap
means depeg, pool attack, or a manipulated market feed. Threat model: we are a passthrough aggregator
(no custody/lending), so this protects (a) the USER from unknowingly trading a depegged asset, and
(b) the swap-price gate from a manipulated MARKET feed (caught by the manipulation-resistant ER) — NOT
"our funds" (there are none mid-swap beyond atomic execution + on-chain minimumOutput).

## Design — reuse the SPRINT-9J deviation-gate consent pattern
Compute `divergence = |market − ER| / ER` for cbETH (and any future asset with both a market and an
exchange-rate/redemption feed — make it data-driven, not cbETH-hardcoded).
- **divergence < WARN (e.g. 2%)** → no friction (normal premium/discount).
- **WARN ≤ divergence < BLOCK (e.g. 2–10%)** → informed-consent warning (reuse the 9J mode:'consent'
  path + SwapBox acceptedDeviation UX): "cbETH is trading X% off its exchange rate — possible depeg.
  Verify before swapping." User must explicitly accept. Consent auto-revokes if divergence worsens
  (same accepted+0.5% rule as 9J) and resets on trade-param change.
- **divergence ≥ BLOCK (e.g. 10%)** → hard-block (mode:'block', NOT click-through), like the 9J
  extreme-deviation ceiling.
Thresholds in ONE config constant set (shared/visible), not magic numbers; justify the chosen values
(cbETH normal market-vs-ER spread is well under 1%, so 2%/10% are conservative).

## Integrity / edge handling
- Both feeds must pass the 9V per-feed staleness + validateRoundData (answer>0, round complete,
  startedAt) BEFORE computing divergence. If EITHER is stale/invalid → do NOT compute a false
  divergence; fall back to the existing no-oracle calm warning + multi-source path (don't hard-block on
  a missing feed — that's a feed outage, not a depeg).
- Decimals exact (market 18 dec, ER 18 dec — same here, but keep the math explicit).
- The ER is slow (24h); divergence is driven by the market leg moving — that's expected and correct.

## Tests (TDD)
- market≈ER (0.3%) → no warning. market 5% off ER → consent required; accept → proceeds; worsens to 6%
  → consent revoked. market 12% off ER → hard-block, no click-through.
- Either feed stale/invalid → no divergence verdict, falls to multi-source (no false block).
- Direction symmetric (cbETH cheap vs expensive both trip). Mainnet unaffected (cbETH path is Base).
- Non-cbETH swaps unchanged (data-driven: only assets with both feeds get the check).

## Do NOT
- Do NOT change the swap-price reference (stays the MARKET feed from 9V). Do NOT replace the composition
  with the direct CBETH/USD feed (that's a separate, mutually-exclusive option — and it would remove the
  divergence signal this sprint depends on). Do NOT loosen the 9J/9V/9S gates.
- No contract changes. Keys server-only. Mainnet byte-identical.
- Branch `feat/sprint-9w-oracle-depeg-breaker`, atomic SSH-signed commits, CI green, append FEEDBACK.
  **SECURITY GATE (rule #9) → FULL Auditor review before prod** (focus: thresholds justified, consent
  band can't click through a true block, fail-open on stale feed is correct, no false blocks on normal
  spread). Browser checks are OWNER post-merge — do everything automatable and STOP (no loop).
