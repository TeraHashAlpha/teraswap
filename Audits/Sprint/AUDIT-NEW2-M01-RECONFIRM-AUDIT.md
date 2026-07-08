# AUDIT — NEW2-M-01 re-confirm: reference-confirmed demotion (PR #275)

**Branch:** `chore/quorum-reference-confirmed-demotion`. **Audited SHA:** **`0b6264d19c45d1316ca8b59284f3cec191f99594`** (1 commit, SSH-signed).
**Prompt:** `docs/Prompts/AUDIT-NEW2-M01-RECONFIRM.md`. **Auditor:** independent (Opus 4.8), read-only.
**Follows:** #272 (approved with **NEW2-M-01 MEDIUM** tracked). **Diff:** 5 files, +902/−89 — `quote-quorum.ts`
(+288, the Option-2 rewrite), `quote-quorum.test.ts` (+479), `api.ts` (+27 wiring), FEEDBACK + CHORE prompt.

## Verdict: **NEW2-M-01 CLOSED — 0C / 0H.** PR #275 APPROVED to merge.
#275 implements the agreed **Option 2** (reference-confirmed demotion + flag-without-reorder fallback)
correctly. The one-way low-ball gap is **eliminated in every regime**; the mis-scale defence is preserved;
the residual is bounded with no fund-loss path. **Item A** (the two-simultaneously-defective edge) is
**ACCEPTED as bounded** for closure, with an **optional LOW defense-in-depth prompt** (NEW2-L-01,
non-blocking). **Item B** (ref-confirmed ⇒ `lowConfidence` false) is **correct/safe — ACCEPTED**.

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | **Gap CLOSED — attack defeated** | ✅ Band trip no longer demotes by itself: only an external reference may authorize it. **Referenced pair + attacker >5% under an honest winner + reference confirms the winner** → `refDeviationBps ∈ [−band, +band]` → **winner KEPT, `lowConfidence` false** (the former `(a) FLAGGED GAP` test, now `quote-quorum.test.ts:296` "The former FLAGGED GAP, closed… reference-confirmed ⇒ cross-validated", asserts the honest winner keeps the slot). |
| 1b | **Mis-scale defence preserved** | ✅ A garbage-/mis-scaled-high winner (`refDeviationBps > band`) → **still demoted**, sane runner-up presented (`:250` `(b)`, `:319` +10%-over-ref demotes). |
| 1c | **No-reference → flag-without-reorder** | ✅ Oracle-less + DefiLlama-less pair with a tripped band → `{sorted, demoted:[], lowConfidence:true}` — **no demotion**; the honest winner keeps the slot (`:317` `(a-fallback)`: `quotes[0]==='kyberswap'`, `demoted:0`). The low-baller "achieves nothing." |
| 2 | **Item A — double-defect edge (adjudicated)** | ✅ bounded → **ACCEPT**. Winner >band **above** ref while runner-up >band **below** ref: shipped `refDeviationBps > band` demotes the winner and presents the (too-low) runner-up, flagged. On a **referenced** pair the SAME reference that marked the runner-up too-low **gates it at execution** — Chainlink consent (block ≥3% / ceiling 25%) or non-overridable DefiLlama **422** (−8% below fair) + on-chain `minimumOutput` → the egregiously-low fill **cannot execute**. **No fund loss.** Optional extra clause below. |
| 3 | **Item B — ref-confirmed ⇒ lowConfidence false (adjudicated)** | ✅ **Correct/safe — ACCEPT**. An oracle-cross-validated winner is **strictly stronger** than an un-cross-checked quorum, so not flagging it is right (upgraded, not downgraded, signal). It does **not** hide a genuine low-confidence case: 1-responder, no-reference, demotion, both-below, unusable runner-up **all still flag `true`** (`:161/:272/:316/:326`). `false` fires **only** on a positive external confirmation. |
| 4 | **Bounds / gates terminal** | ✅ Display-selection only; **SC-04 + R1 + on-chain `minimumOutput` untouched** — whatever is presented is gated at execution (W2). Worst case = display/price, never misroute or sub-floor fill. |
| 4b | **Composition** | ✅ Reuses #18 `fetchChainlinkPriceRaw` (integrity-gated) + #248 `fetchDefiLlamaPrice` **plumbing** — never builds its own oracle path; **no gate conflict** (#248's keeper-side deviation guard is a different layer). #261 executable-sources unchanged (quote-only still can't be the executable winner). |
| 4c | **Reference integrity + laziness** | ✅ `applyLowQuorumSanityWithReference` resolves the reference **lazily** — `lowQuorumBandTripped(sorted) ? resolveQuorumReference : null` (healthy paths pay no oracle lookup). `resolveQuorumReference` requires **both legs from the SAME methodology** (no Chainlink×DefiLlama mix), Chainlink-first-else-DefiLlama. `fetchChainlinkPriceRaw` applies `validateRoundData` (staleness / `answeredInRound<roundId` / `answer<=0`) → **a stale round ⇒ null ⇒ flag-without-reorder**, so the reference **cannot be stale-wrong**. |
| 4d | **Deterministic; no new gaming** | ✅ `deterministic and side-effect-free in BOTH regimes` (`:358`) + tie-stable (`:386`). The reference is **external + integrity-gated + attacker-immovable**; the only residual lever (force no-reference) yields flag-without-reorder (**no demotion to game**). No new gaming direction. |

## Adjudications
- **Item A → ACCEPT the shipped rule for CLOSE (residual bounded), + OPTIONAL hardening (NEW2-L-01, LOW,
  non-blocking).** The double-defect (winner too-high AND runner-up too-low) is a rare opposite-direction
  double-defect on a 2-responder pair; the presented too-low runner-up is caught by the very reference that
  flagged it, at execution. It never reaches funds. The Code Agent's offered extra clause (only demote when the
  runner-up is *also* within band of the reference; else flag-without-reorder) is a cheap defense-in-depth that
  avoids steering the display to a quote we already know the execution gate will block. Worth doing, not required.
- **Item B → ACCEPT.** `lowConfidence:false` on a reference-confirmed winner is correct; it strengthens, never
  weakens, the signal, and every genuine low-confidence case still flags.

## Remediation prompt (OPTIONAL — NEW2-L-01, non-blocking) — Item A extra clause
> **Context:** `quote-quorum.ts applyLowQuorumSanity` — in the `refDeviationBps > band` branch (winner confirmed
> too-high) it demotes to the runner-up **without confirming the runner-up is itself sane**. On the rare
> double-defect (winner >band above ref AND runner-up >band below ref) this presents a confirmed-too-low quote
> (bounded: the reference gate blocks it at execution — no fund loss, NEW2-L-01).
> **Objective (defense-in-depth):** before demoting the winner to the runner-up, confirm the runner-up is within
> `±band` of the reference; if the runner-up is ALSO an outlier (`|runnerUp−ref|/ref > band`), do **not** present
> it — fall back to flag-without-reorder (keep the sorted order, `lowConfidence:true`, demote nothing).
> **Requirements:** ~1 guard line in the `refDeviationBps > band` branch; keep the fn pure (reference passed in);
> do NOT touch SC-04/R1/minimumOutput or the other regimes. **Tests:** add a double-defect case asserting
> flag-without-reorder (no demotion, `lowConfidence:true`); keep all existing quorum tests green (determinism,
> boundary, mis-scale, no-reference). Frontend/lib only — re-audit not required (LOW, no fund path).

## Coverage
- Reviewed on `0b6264d`: `quote-quorum.ts` (full rewrite — decision tree + `resolveQuorumReference` +
  `computeReferenceToAmount` + lazy wrapper), `quote-quorum.test.ts` (479-line expansion — all regimes), `api.ts`
  wiring, and the #18/#248/#261 plumbing it reuses. `fetchChainlinkPriceRaw` integrity re-confirmed.
- Not run in-sandbox: live vitest (CI is green per the trigger) / live oracle fetch — the decision logic is a pure
  function verified against the committed tests; the reference fetch reuses W3-verified integrity-gated plumbing.

## Boundaries
Read-only on `origin/chore/quorum-reference-confirmed-demotion`; no edits. **Sign-off: NEW2-M-01 CLOSED; PR #275
may merge.** Optional Item-A hardening tracked as NEW2-L-01 (non-blocking).
