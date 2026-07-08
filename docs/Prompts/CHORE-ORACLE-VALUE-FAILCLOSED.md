# CHORE-ORACLE-VALUE-FAILCLOSED — P2: the >$10k oracle block fails open for exotic tokens

> **Source:** external threat model (PR #277) **P2 (MED, CONFIRMED adversarial).** The high-value >$10k oracle block
> estimates trade value from the **input token only** — server `src/app/api/swap/route.ts:252-261` via DefiLlama;
> client `SwapBox.tsx:554-566` via Chainlink+stable+ETH. A token that **neither source prices** → estimate `0` → **the
> >$10k block never fires on either layer.** The post-aToken-incident control is bypassable by choosing an uncovered
> token (exactly the thin/manipulable ones). **No on-chain / contract change. Gate-adjacent → Auditor note.** Branch
> **after #278 merges** (it also edits `SwapBox.tsx`). SSH-signed (noreply committer).

## Objective
Make the high-value estimate **fail-CLOSED**: value = **`max(inputUsd, outputUsd)`** across **both** DefiLlama **and**
the server Chainlink path; if **neither side prices on either source**, treat the trade as **high-risk** (conservative
block / size ceiling) — **never estimate 0**.

## Requirements
1. **Server (`api/swap/route.ts:252-261`).** Compute the trade value as **`max(inputUsd, outputUsd)`** using **both**
   DefiLlama **and** the server Chainlink `computeTokenAmountUsd` (reuse the existing plumbing — do NOT build a new
   oracle). If **neither the input nor the output** prices on **either** source → do **not** return `0`; treat as
   **high-risk** and apply the conservative policy (block the >$10k trade, or clamp to a safe size ceiling) — the gate
   must **fire**, not silently pass.
2. **Client (`SwapBox.tsx:554-566`).** Mirror it — `max(inputUsd, outputUsd)` via the client's Chainlink+stable+ETH +
   DefiLlama where available; neither prices → the same **high-risk** treatment + a clear (non-alarmist) warning.
   Server remains the binding gate; the client mirror is UX.
3. **Explicit policy + threshold.** Make the "neither-priced → high-risk" branch explicit and documented (what it does
   at >$10k vs below). Do not loosen the existing >$10k threshold.
4. **Note (do NOT fix here):** the report also flags that `minimumOutput` derives from the quote's own `toAmount`, so
   it doesn't bound a **self-consistent** bad quote — that is the **P1a on-chain-floor class**
   (`SPRINT-ORDER-ONCHAIN-FLOOR`); reference it in FEEDBACK, don't try to solve it here.

## Do NOT
- No on-chain / contract change. Don't loosen the >$10k gate. Don't let an **unpriceable high-value** trade pass with
  an estimate of 0. Don't build a new oracle source (reuse DefiLlama + the server Chainlink path). Don't make the
  client warning alarmist.

## Files affected (verify on main)
- `src/app/api/swap/route.ts` (~:252-261, the value estimate + the >$10k gate); `SwapBox.tsx` (~:554-566, the client
  estimate); the price plumbing (DefiLlama + `computeTokenAmountUsd`) — read-only reuse. + a test.

## Expected output
- Branch `chore/oracle-value-failclosed` off latest `origin/main` (**after #278**); SSH-signed; CI green. Value is
  `max(in,out)` across both sources both layers; an **uncovered token at >$10k is BLOCKED** (not passed with 0). Tests:
  uncovered-token >$10k → blocked; covered token → correct `max(in,out)`; the neither-priced policy is asserted.
  FEEDBACK: the policy + threshold + the P1a `minimumOutput` cross-reference. **Flag for Auditor (gate-adjacent).**

## Quality criteria
The >$10k block can no longer be bypassed by an unpriceable token; value = `max(in,out)` across DefiLlama + Chainlink
on both layers; neither-priced fails **closed** (never 0); threshold unchanged; no contract/on-chain change; no new
oracle source.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-ORACLE-VALUE-FAILCLOSED per docs/Prompts/CHORE-ORACLE-VALUE-FAILCLOSED.md.
Branch chore/oracle-value-failclosed off origin/main (AFTER #278 merges — it also
edits SwapBox.tsx), SSH-signed (noreply committer), CI green. No on-chain/contract
change. Gate-adjacent -> flag for Auditor.

Context (threat model PR #277, P2 MED confirmed): the high-value >$10k oracle block
estimates value from the INPUT token only (server api/swap/route.ts:252-261 via
DefiLlama; client SwapBox.tsx:554-566 via Chainlink+stable+ETH). A token neither
source prices -> estimate 0 -> the >$10k block never fires on either layer (the
aToken-incident bypass via an uncovered thin/manipulable token).

Do:
1. Server (api/swap/route.ts:252-261): value = max(inputUsd, outputUsd) using BOTH
   DefiLlama AND the server Chainlink computeTokenAmountUsd (reuse existing
   plumbing, no new oracle). If NEITHER input nor output prices on EITHER source ->
   do NOT return 0; treat as HIGH-RISK -> the gate must FIRE (block the >$10k trade
   or clamp to a safe size ceiling), never silently pass.
2. Client (SwapBox.tsx:554-566): mirror max(inputUsd, outputUsd) via Chainlink+
   stable+ETH + DefiLlama where available; neither prices -> same high-risk
   treatment + a clear non-alarmist warning. Server stays the binding gate.
3. Make the neither-priced -> high-risk branch explicit + documented; do NOT loosen
   the >$10k threshold.
4. NOTE (do NOT fix here): minimumOutput derives from the quote's own toAmount, so
   it doesn't bound a self-consistent bad quote — that's the P1a on-chain-floor
   class (SPRINT-ORDER-ONCHAIN-FLOOR); reference it in FEEDBACK, don't solve here.

Do NOT: on-chain/contract change; loosen the >$10k gate; let an unpriceable
high-value trade pass with estimate 0; build a new oracle source; alarmist client
warning.

Files: api/swap/route.ts (~:252-261), SwapBox.tsx (~:554-566), the price plumbing
(reuse) + a test. Tests: uncovered-token >$10k blocked; covered token -> correct
max(in,out); neither-priced policy asserted. FEEDBACK: policy + threshold + the P1a
minimumOutput cross-reference. Flag for Auditor.
```
