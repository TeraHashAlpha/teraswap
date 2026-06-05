# SPRINT-9J — Auditor brief

Review branch `feat/sprint-9j-swap-ux` once the Code Agent ships it. SPRINT-9J fixes three live
issues (`docs/Prompts/SPRINT-9J.md`). Only **J1 touches a security gate** (rule #9) and is the
focus of this audit; J2/J3 are reliability/UX and need only a sanity pass.

## Context
- Base is LIVE (chainId 8453); mainnet (1) must stay byte-identical.
- SPRINT-9G made the Chainlink + DefiLlama + sequencer gates chain-aware (0C/0H/0M/1L/2I, all 12M
  closed). 9J must NOT regress any 9G closure. SPRINT-9H widened the Velora selector allowlist
  (audited, 22 selectors, TRUSTED_ROUTER). 9J must NOT touch the allowlist.
- J1 is a UX/correctness fix to the **deviation gate**, NOT a loosening of manipulation/staleness
  protection.

## J1 — PRIMARY focus: deviation gate must not conflate price-impact with oracle deviation
The reported bug: a mainnet swap whose best route is an illiquid PMM (price impact ~2.16%) is
indefinitely paused with "Price deviates 2.2% from Chainlink oracle / PRICE OUTSIDE SAFE RANGE —
WAITING". Root cause: the gate compares the **execution rate (post price-impact)** to Chainlink
spot, so the user's own price impact registers as oracle deviation. The fix compares against the
**pre-impact / mid quote price** and converts the indefinite hard-pause into an informed-consent
warning where deviation ≈ displayed price impact.

**Audit must confirm — this is where the risk is:**
1. **No weakening of genuine protection.** A real oracle event still hard-blocks: stale feed
   (`updatedAt` too old / `startedAt==0`), a feed that diverges from the aggregator spot beyond the
   manipulation threshold, and cross-source quorum disagreement. Construct/verify tests for each;
   these must STILL block after 9J. The change must only stop the trade's *own* price impact from
   counting as oracle deviation.
2. **The "pre-impact / mid" reference is sound.** Verify what the new comparison actually uses as
   the reference price — it must be a price the user/route cannot manipulate to dodge the gate (e.g.
   the aggregator's spot/mid or Chainlink itself), NOT a value derived from the same route's
   execution rate (which would make the gate self-referential and bypassable). A malicious/illiquid
   route must not be able to inflate "price impact" to launder a real deviation past the gate.
3. **Informed-consent path is bounded.** The user-acceptable warning must apply ONLY to the
   price-impact-≈-deviation case, must surface the real number, and must NOT become a blanket
   "accept" that also dismisses genuine staleness/manipulation blocks. Confirm the two states are
   distinct in code (recoverable warning vs hard block) and that the hard block cannot be clicked
   through.
4. **Chain-aware + mainnet byte-identical.** The change must behave on both chains and leave all
   mainnet swap-path math byte-identical except the intended gate behaviour (test-guarded). No 9G
   regression (Chainlink/DefiLlama/sequencer chain-awareness intact).
5. **No fee/router/calldata changes.** 9J must not touch FeeCollector, router whitelist, or the
   selector allowlist (9H scope). Confirm.

## J2 — sanity pass (HIGH/MED reliability)
Bounded timeout + AbortController + retry on upstream swap-build fetches so `/api/swap` always
returns JSON within the function limit. Confirm: timeout fires well under max duration; no secret/key
leakage in the error body; retry does not double-submit an on-chain tx (build step only, not the
signed send); `/api/swap` still returns JSON on the timeout path. No behaviour change to a successful
build.

## J3 — sanity pass (LOW)
Tooltip trigger fix + render test. Confirm no XSS/inject via tooltip content, no unrelated UI change.

## Implementation as shipped (verify against this)
Branch `feat/sprint-9j-swap-ux`, 6 signed commits, 1443 tests green, mainnet byte-identical, no
contract edits. J1 landed in `price-gate.ts` (extreme-deviation ceiling) + `SwapBox.tsx`
(`acceptedDeviation` model: escalation + chain-switch re-consent). Remediation `14807a8`, FEEDBACK
`f95ff0a`. The Code Agent rejected a "thread AbortSignal through 10 more adapters" finding (claims the
race timeout already bounds every adapter to <24s < maxDuration → all return JSON).

**Auditor must specifically confirm:**
1. **Extreme-deviation ceiling is real and cannot be click-through.** There MUST be an upper bound
   above which the gate hard-blocks even with user consent — consent-based acceptance cannot extend
   to an arbitrarily large (e.g. 25%+, rug-tier) deviation. Verify the ceiling value is sane and
   the hard-block above it cannot be accepted away.
2. **Consent does not leak across chains.** `acceptedDeviation` must reset on chain switch
   (re-consent required) — confirm in code + test.
3. **Accepted residual risk is acceptable.** FEEDBACK documents: a pair Chainlink can price but
   DefiLlama cannot (exotic, <$10k) → 2–25% deviation is consent-based. Decide whether this band is
   acceptable or needs a tighter cap; the lower DefiLlama coverage must not become a manipulation
   bypass for genuinely mispriced exotic pairs.
4. **J2 rejection is valid.** Sanity-check the claim that the race timeout bounds every adapter
   <24s < maxDuration so `/api/swap` always returns JSON without threading AbortSignal everywhere.

## Verdict format
Classify findings C/H/M/L/I. 0C/0H = approved. Produce a prompt for the Code Agent for any finding;
do not edit source directly. Record the verdict in `docs/security/AUDIT-TOTAL.md`. J1 must be
approved before promoting to prod; J2/J3 may ship behind the Preview gate.
