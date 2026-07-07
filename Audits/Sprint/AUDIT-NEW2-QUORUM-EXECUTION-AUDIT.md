# AUDIT — NEW-2: Low-quorum demotion / execution-selection (PR #272)

**Branch:** `chore/quorum-lowconfidence-fix` (**UNMERGED** — this sign-off gates it).
**Audited SHA:** **`8514b6817317ea55bcdce734f56cfcb970d845ab`** (1 commit, SSH-signed).
**Prompt:** `docs/Prompts/AUDIT-NEW2-QUORUM-EXECUTION.md`. **Auditor:** independent (Opus 4.8), read-only.
**Diff:** 8 files, +392/−21 — `quote-quorum.ts` (+58), `quote-quorum.test.ts` (+100), `QuoteBreakdown.tsx`
(+17), `QuoteBreakdown.test.tsx` (+46), `api.ts` (+11), `adapters/types.ts` (+4), FEEDBACK + CHORE prompt.

## Verdict: APPROVED — cleared to merge. Flagged gap = **MEDIUM (NEW2-M-01)**, bounds HOLD (no fund-loss path).
Per the verdict rule, a flagged **M with bounds holding + a remediation prompt produced does NOT block
merge**. This PR **improves** the state: it renders a previously-dead safety cue (`lowConfidence`),
corrects the inaccurate "display-only" characterization, and adds honest adversarial tests that pin the
gap. The one-way gap **pre-exists** from #260; this PR does not worsen it and is bounded + flagged +
slated for the Option-2 fix below. **0 Critical / 0 High.**

## Checks-run
| # | Check | Result |
|---|-------|--------|
| 1 | Confirm + classify the flagged one-way gap | ✅ **Independently confirmed.** `applyLowQuorumSanity` (n=2) computes ONE pairwise spread `(winner−runnerUp)/runnerUp` and always demotes the **winner** if `> 500 bps`. A low-ball attacker quoting **>5% UNDER** an honest winner forces the honest quote demoted and the attacker's low quote presented as best. Test `(a) FLAGGED GAP (Auditor)` (`quote-quorum.test.ts:186`) asserts exactly this (honest `kyberswap` demoted). **Severity: MEDIUM** — execution-selection manipulation / price-degradation (griefing); **not theft**. |
| 1b | Hunt other gaming / rounding / ordering edges | ✅ No worse direction found. The **high-liar** direction is correctly demoted (intended catch, `(b)`). The **within-band** residual (`(b-residual)`) is the designed limit of any pairwise band. **Rounding is safe-direction**: BigInt `deviationBps` truncates toward *passthrough* (fewer false demotions); boundary is inclusive (exactly 500 bps kept). A **both-mis-scaled-by-same-factor** pair is uncatchable by any pairwise band (documented; needs #248/#18) — not a new gap. Ties are stable (`:220`). |
| 2 | Bounds hold — no fund-loss path | ✅ (full chain below) Residual = **ONLY oracle-less AND DefiLlama-less pairs**, exactly 2 responders, one >5% under, **capped <$10k** (`UNVERIFIED_SWAP_BLOCK_USD`), `minimumOutput`-bound, `lowConfidence`-cued. Nothing worse. |
| 3 | Execution gates terminal | ✅ The module touches display only. Whatever it presents, **SC-04** (`isKnownSwapSelector`) + **R1** (`validateCallDataRecipient`) + **on-chain `minimumOutput`** still bind the executed quote (untouched, W2-verified) → worst case display/price, never misroute or sub-floor fill. |
| 4 | Characterization accurate + composition | ✅ Header **corrected** ("the old 'display-only' characterization was inaccurate… execution-SELECTION-adjacent") and **names the gates**. Composes cleanly: **#248** DCA deviation guard is keeper-side, different layer, no shared state (documented); **#18** Chainlink consent gate is a named mitigation; **#261** `executable-sources` + SC-04 ensure a **quote-only source can't be the executable winner** ("SC-04 remains the terminal backstop"). Band runs before the 3×-median filter → **no double-demotion**. |
| 4b | Tests deterministic (NEW-1 flake) | ✅ Explicit `demotion and lowConfidence are deterministic and side-effect-free (frozen input, repeated calls)` (`:204`) + `exact 2-source tie is kept, unflagged, and stable (no order-dependent demotion)` (`:220`). Flake reconciled. |
| 5 | lowConfidence renders (no XSS) | ✅ `QuoteBreakdown.tsx:188+` renders the cue via React `{expr}` (escaped; `meta.all.length` is numeric), **non-alarmist** (calm cream styling, "Informational by design, NOT an alarm"), names the `minimum-output` guarantee. Fixes the dead flag. |

## The gap — severity & evidence (NEW2-M-01, MEDIUM)
- **Mechanism:** pairwise band can't tell "winner too high" from "runner-up too low", yet always demotes the
  winner (`quote-quorum.ts` — `deviationBps > bandBps ⇒ demote winner`). A griefing source quoting >5% below
  the honest best steers the display to its own low quote.
- **Impact:** the user is presented a **worse** price (opportunity cost = the demoted honest spread); they still
  receive ≥ the presented amount (on-chain `minimumOutput`), so **no theft, no funds to the attacker** beyond a
  normal worse swap. It is a display-integrity/execution-selection issue, hence MEDIUM (not H — no fund path).
- **Preconditions (all required):** exactly **2** responders (thin market — 3+ is owned by the 3×-median filter)
  **AND** the pair is **oracle-less (no Chainlink)** **AND** **DefiLlama-less** (else the gates below fire).

## Bounds verification — the full gate chain → fund-loss? **NO**
| Layer | On the residual gap | Verified |
|-------|---------------------|----------|
| `lowConfidence` cue | fires on every demotion + renders (QuoteBreakdown) | ✅ this PR |
| Chainlink consent gate (`price-gate.ts`, #18) | ≥2% deviation → informed consent; **≥3% hard block** (`PRICE_DEVIATION_BLOCK=0.03`); extreme → block at `PRICE_IMPACT_CONSENT_CEILING=0.25` | ✅ (W3) — catches the low quote on **feeded** pairs |
| DefiLlama server guard (`defillama.ts`) | **non-overridable** 422 when output >8% below fair value | ✅ (W3) — catches it on **DefiLlama** pairs |
| Tiered USD limits (`SwapBox`) | oracle-less swap **>$10k blocked** (`UNVERIFIED_SWAP_BLOCK_USD`), >$1k warned | ✅ — caps residual exposure |
| On-chain `minimumOutput` (V2 + OE) | binds the fill to the presented quote; no sub-floor fill | ✅ (W1/W2) |
| SC-04 + R1 + executable-sources (#261) | executed source is executable + recipient=user; quote-only can't win execution | ✅ (W2/W7) |

**Conclusion:** every off-chain steering terminates at the on-chain guards; the residual is **price
degradation on oracle-less+DefiLlama-less thin pairs under $10k, minOut-protected and cued** — exactly the
claimed bound. **No fund-loss path.**

## Options assessment + recommendation
| Option | Eliminates the one-way gap? | Keeps mis-scale catch? | Assessment |
|--------|-----------------------------|------------------------|------------|
| 1. `flag-without-reorder` (never demote <3; just flag) | ✅ (no demotion to game) | ✗ — a 10^n-inflated winner is shown as best (relies fully on the consent gate + minOut) | Simple, but re-opens the original #260 problem on feeded pairs |
| **2. external-reference-confirmed demotion** (demote ONLY when Chainlink/DefiLlama confirms the winner is the outlier) + `flag-without-reorder` fallback for oracle-less+DefiLlama-less | ✅ (attacker can't force demotion — the oracle vouches for the honest winner) | ✅ (external ref confirms the mis-scale) | **RECOMMENDED** — the only option that closes the gaming in both regimes while preserving the defense; ties to #18's existing quote-time oracle read |
| 3. `accept-as-is` | ✗ (gap remains) | ✅ | Lowest effort; leaves NEW2-M-01 open |

**Independent recommendation: Option 2** (concurs with the Architect's lean). Reasoning: a low-ball attacker
can only force a demotion if the band trusts the pairwise spread; deferring the demote decision to an
**external reference** (the same Chainlink/DefiLlama the consent/price gates already consult) means the band
demotes the *true* outlier, not "whichever side the attacker chose". For pairs with **no** external reference,
`flag-without-reorder` (show both, flag `lowConfidence`, demote nothing) removes the gameable lever entirely —
the user sees both quotes + the cue, and minOut still binds. This eliminates NEW2-M-01 with no new fund path.

## Remediation prompt (Code-Agent-ready) — NEW2-M-01 → Option 2
> **Context:** `src/lib/quote-quorum.ts` `applyLowQuorumSanity` demotes the n=2 winner on a >500 bps pairwise
> spread, but a pairwise band can't tell which side lies — a low-ball source >5% under an honest winner forces
> the honest quote demoted (griefing; test `(a) FLAGGED GAP`). Bounded (no fund loss) but a real
> execution-selection integrity gap (NEW2-M-01, MEDIUM).
> **Objective:** make the demotion **external-reference-confirmed**. Only demote the winner when an external
> price (Chainlink feed via the existing #18 path, else DefiLlama) **confirms the winner is the outlier**
> (i.e. the winner deviates from the reference beyond the band AND the runner-up agrees with the reference).
> For pairs with **no** external reference (oracle-less AND DefiLlama-less), **do not demote** — fall back to
> `flag-without-reorder`: keep both quotes, set `lowConfidence`, demote nothing.
> **Requirements:** keep `applyLowQuorumSanity` pure by passing the reference price(s) in as an argument
> (resolved by the caller in `api.ts`/#18, not fetched inside the pure fn); preserve the mis-scale catch on
> feeded pairs; keep `lowConfidence` firing in every <3 case; do NOT touch SC-04/R1/minimumOutput. **Tests:**
> convert the pinned `(a) FLAGGED GAP` test to assert the honest winner is **kept** (not demoted) once a
> reference confirms it; add an oracle-less case asserting flag-without-reorder (no demotion); keep the
> mis-scale + boundary + determinism + tie tests green. Frontend/lib only — no contract/gate change; re-audit
> not required (MEDIUM, no fund path) but re-run the quote-quorum suite + the CI `minimum-output`/oracle guards.

## Boundaries
Read-only on `origin/chore/quorum-lowconfidence-fix`; no edits. `forge`/live-quote fuzz deferred to CI; the
gate chain reasoned from the code + W1/W2/W3 on-chain/source verification. **Sign-off: this PR may merge**
with NEW2-M-01 tracked to the Option-2 remediation prompt.
