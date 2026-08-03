# CHORE-KEEPER-HARDENING — P5a + P1A-M-01 + P1A-I-01 (batched, one keeper run)

> **Source:** threat model **P5a (HIGH)** + Auditor **P1A-M-01 (MEDIUM, non-blocking)** + **P1A-I-01 (INFO)**. All
> **keeper, off-chain, fund-adjacent.** Branch **AFTER #279 merges** (it edits the same keeper files). SSH-signed
> (noreply committer). 3 independent, droppable commits. **→ Auditor note** (signer/floor-adjacent — can ride a future
> keeper review).

## Commit 1 — P5a (HIGH): the Vault stub must throw (no silent plaintext downgrade)
`kms-signer.js:217-223` — the `if (vaultAddr)` branch only **logs** and **falls through** to `privateKeyToAccount`;
`executor.js:253` skips the plaintext-key FATAL when `hasVault`. So setting `VAULT_ADDR` without a real Vault silently
runs a **plaintext mainnet key**. Fix: the Vault branch **MUST THROW** when it isn't actually wired (don't count
`VAULT_ADDR` as a managed signer until the Vault path is implemented); **assert the resolved signer type at startup**
(fail-closed).

## Commit 2 — P1A-M-01 (MEDIUM): tighten the fail-open floor
`order-floor.js` — today a reference failure → the fill is **flagged, not rejected** (fail-open). Refine into two
cases, reusing the #18/#248 feed config (read-only) to know which pairs have a feed:
- a **transient outage of a pair that HAS a feed** (Chainlink/DefiLlama configured but momentarily unavailable) →
  **DELAY** the fill (do NOT fail-open);
- a pair **genuinely without any feed** → **flag** (fail-open, as today).
Plus a **USD notional cap** on any fail-open fill — only small fills proceed; larger ones delay/skip. Don't loosen the
existing `[50,2000] bps` band.

## Commit 3 — P1A-I-01 (INFO): fix the ADR reference
The Phase-0 comments reference **ADR-011**; the ADR is **ADR-013**. Correct the references.

## Do NOT
No contract / on-chain change; no `ALLOW_PLAINTEXT_KEY`; keep the Phase-0 reject/submission behaviour + the on-chain
gates intact; don't loosen the floor band.

## Files affected (read ONLY these)
`kms-signer.js`, `executor.js` (P5a); `order-floor.js` + the #18/#248 feed config read-only (P1A-M-01); the Phase-0
files' ADR comments (P1A-I-01); + the keeper tests. **Do not scan the rest of the repo.**

## Expected output
Branch `chore/keeper-hardening` off latest `origin/main` (after #279); SSH-signed; **push + report "CI running" — do
NOT poll/watch CI**. 3 commits. Tests: `VAULT_ADDR`-without-Vault throws + startup signer-type assertion; a feed-having
pair in transient outage **delays** (not fail-open); a feed-less pair **flags**; a fail-open fill above the USD cap is
delayed/skipped. **FEEDBACK ≤ 1 screen** (the 3 dispositions + the USD-cap value chosen).

## Quality criteria
`VAULT_ADDR` can't silently run a plaintext key; the fail-open floor is bounded (transient-vs-feedless split + USD cap);
ADR refs corrected; Phase-0 behaviour + on-chain gates intact; no contract change.
