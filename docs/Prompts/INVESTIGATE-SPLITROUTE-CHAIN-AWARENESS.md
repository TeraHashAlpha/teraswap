# INVESTIGATE-SPLITROUTE-CHAIN-AWARENESS — does `useSplitRoute` price sub-legs on the wrong chain? (READ-ONLY)

> **Source:** flagged in **PR #261 FEEDBACK** (pre-existing, out of scope of the Sushi fix). `useSplitRoute`'s
> sub-amount quote fetch / split analysis appears to **price the sub-legs on mainnet regardless of the active chain**.
> This is the **chain-awareness class** — same family as the historical *"Base priced off mainnet"* root cause
> (`getRpcUrl()` / adapter URLs not chain-aware, fixed in **SPRINT-9C, commit `c8ca8b1`**); likely a call site that
> fix missed. **READ-ONLY triage: confirm, locate, size the blast radius, classify severity, recommend a scoped fix.
> No code changes, no behaviour change.** SSH-signed report commit only.

## Objective
Prove or disprove the bug, find exactly where the `chainId` is dropped/hardcoded, quantify **who is affected and how
badly** (which chains; display-only vs execution-affecting), classify severity, and recommend a scoped, correctly
gated fix. Change nothing.

## Requirements
1. **Locate** `useSplitRoute` (hook) + the split-analysis **sub-quote fetch** path. Identify precisely where the
   sub-leg quote requests get their `chainId` — and where it is **dropped, defaulted, or hardcoded to mainnet (1)**
   (e.g. a `getRpcUrl()`/adapter-URL/quote-API call that doesn't thread the active chain). Give `file:line`.
2. **Reproduce (read-only):** on **Base (chainId 8453)**, trigger a split-route computation and confirm whether the
   sub-leg quotes are fetched with **8453** or fall back to **mainnet** (wrong prices / liquidity / token addresses).
   Show the observed vs expected chain on the sub-quote calls.
3. **Blast radius:**
   - Is split routing **enabled** on Base (and any other non-mainnet chain), or mainnet-only? (If mainnet-only, the
     bug is latent → severity drops.)
   - Does the mis-priced sub-leg feed the **displayed** best quote / the *"you save X by splitting"* analysis, or the
     **executed** transaction? Trace both.
   - **Critical fork:** are split routes ever **executed on-chain** (multi-leg settlement), or is the split purely
     **analysis/informational** and a **single** source actually settles? If executed, could a mainnet-priced sub-leg
     mis-set `minOutput` / recipient / routing on Base → escalate as fund-flow. If analysis-only, it's a display
     correctness bug (user shown wrong savings).
4. **Cross-check vs `c8ca8b1`:** is this the **same** `getRpcUrl()`/adapter-URL mechanism (a missed call site) or a
   **distinct** path? Note whether the #261 `executable-sources` scoping interacts with it.
5. **Classify severity** (display-mislead vs execution-affecting) and **recommend a scoped fix** (thread the active
   `chainId` through the sub-quote fetch), stating whether the fix needs an **Auditor pass** (only if it turns out to
   be execution / fund-flow-affecting).

## Do NOT
- No code change, no execution-path change — **diagnose only**. If the triage finds it **is** execution/fund-flow
  affecting, **escalate** (flag for the contract/fund-flow gate + Auditor) — do **not** fix it in this pass.

## Files / areas (verify on main)
- `useSplitRoute` (hook) + the split-analysis / sub-quote fetch; the quote-API `chainId` plumbing; `getRpcUrl()` /
  adapter-URL chain-awareness (the `c8ca8b1` fix); the `executable-sources` scoping (#261). Read-only.

## Expected output
- Branch `audit/splitroute-chain-awareness` off latest `origin/main`; SSH-signed; the report committed. No behaviour
  change. Report: the `chainId`-drop `file:line`, the Base reproduction (observed vs expected chain), the blast-radius
  table (chain × display-vs-execution × enabled?), the severity class, the cross-check vs `c8ca8b1`, and a scoped fix
  recommendation with its correct gate. FEEDBACK: severity + whether a follow-up fix prompt is warranted.

## Quality criteria
Root cause located with `file:line`; the Base reproduction is shown; blast radius (which chains, display vs execution,
enabled or latent) is explicit; severity is classified; the fix is scoped and correctly gated (Auditor only if
execution-affecting); **zero** code / behaviour / execution change.

---

### `/goal` paste for the Code Agent (≤4000)
```
INVESTIGATE-SPLITROUTE-CHAIN-AWARENESS per docs/Prompts/INVESTIGATE-SPLITROUTE-
CHAIN-AWARENESS.md. READ-ONLY triage — no code changes, no behaviour change.
Branch audit/splitroute-chain-awareness off origin/main, SSH-signed; commit the
report only.

Context: PR #261 FEEDBACK flagged a pre-existing bug — useSplitRoute's sub-amount
quote fetch / split analysis prices the sub-legs on MAINNET regardless of the
active chain. Chain-awareness class — same family as the historical "Base priced
off mainnet" root cause (getRpcUrl()/adapter URLs not chain-aware, fixed SPRINT-9C
commit c8ca8b1); likely a call site that fix missed.

Do:
1. Locate useSplitRoute (hook) + the split-analysis sub-quote fetch. Find exactly
   where the sub-leg quote requests get their chainId — and where it's dropped/
   defaulted/hardcoded to mainnet (1). Give file:line.
2. Reproduce (read-only) on Base (8453): trigger a split-route computation; confirm
   whether sub-leg quotes are fetched with 8453 or fall back to mainnet (wrong
   prices/liquidity/token addresses). Show observed vs expected chain.
3. Blast radius: is split routing enabled on Base (and other non-mainnet chains) or
   mainnet-only? Does the mis-priced sub-leg feed the DISPLAYED best quote / the
   "you save X by splitting" analysis, or the EXECUTED tx? Critical fork: are split
   routes ever EXECUTED on-chain (multi-leg settlement) or is the split analysis-
   only with a single source settling? If executed -> a mainnet-priced sub-leg on
   Base could mis-set minOutput/recipient/routing -> escalate as fund-flow. If
   analysis-only -> display-correctness bug (wrong savings shown).
4. Cross-check vs c8ca8b1: same getRpcUrl()/adapter-URL mechanism (missed call
   site) or a distinct path? Note interaction with the #261 executable-sources
   scoping.
5. Classify severity (display-mislead vs execution-affecting) + recommend a scoped
   fix (thread the active chainId through the sub-quote fetch); state whether it
   needs an Auditor pass (only if execution/fund-flow-affecting).

Do NOT: change any code or the execution path — diagnose only. If it IS execution/
fund-flow-affecting, ESCALATE (flag for the contract/fund-flow gate + Auditor), do
not fix here.

Deliver the report: chainId-drop file:line, the Base reproduction (observed vs
expected chain), the blast-radius table (chain x display-vs-execution x enabled?),
severity class, cross-check vs c8ca8b1, and a scoped fix rec with its gate.
FEEDBACK: severity + whether a follow-up fix prompt is warranted. No behaviour
change.
```
