# SPRINT-ORDER-ONCHAIN-FLOOR — close P1a: DCA has no on-chain output floor (flagship HIGH)

> **Source:** external threat model (PR #277) **P1a (HIGH, CONFIRMED manual).** `DCAPanel.tsx:431` signs
> `minAmountOut='1'` → `TeraSwapOrderExecutor.sol:508-509` clamps `minOut` to **1 wei**; DCA also sets `routerDataHash=0`
> + `priceFeed=0` → the on-chain `minimumOutput` (`:528`) is a **no-op for DCA**. All DCA slippage/MEV protection is the
> off-chain **0.5% `KEEPER_SLIPPAGE`**, submitted via the **public mempool** when `FLASHBOTS_RPC_URL` is unset (**Base
> has no Flashbots → sandwichable**). **DCA is LIVE on Base.** Live exposure ~0.5%/fill via MEV; a keeper-compromise /
> route-builder bug / loose `/api/swap` calldata drains DCA principal **to dust** (the on-chain backstop the T-SAF
> campaign relied on does not protect DCA). **Fund-flow → Auditor.**

## Objective
**Cut the live DCA MEV exposure NOW** (off-chain, no redeploy) **and DESIGN the proper on-chain per-chunk floor** (an
ADR) that closes the keeper-compromise-to-dust tail — **without deploying an un-audited contract.**

## Phase 0 — interim off-chain mitigation (IMPLEMENT now; keeper only, no redeploy)
1. **Oracle-bounded per-fill floor in the keeper.** Before submitting each DCA fill, compute an expected output from a
   reference price (**Chainlink first, else DefiLlama — reuse the #18/#248 plumbing**) and **reject the fill (or tighten
   the built calldata's minOut) if the built swap's expected output is below `reference × (1 − maxSlippage)`.** Replace
   the flat 0.5% `KEEPER_SLIPPAGE` with this oracle-bounded floor. If **no reference exists** for the pair
   (oracle-less + DefiLlama-less), fall back to a **conservative flat floor + flag** — do **not** fill blind.
2. **Private / MEV-protected submission on Base.** INVESTIGATE whether a **Base private-relay / MEV-protect submission**
   endpoint is available for the keeper; if so, route DCA fills through it, **fail-closed** (never silently fall back to
   the public mempool — mirror the existing key-guard pattern). If none exists on Base, **document that** and rely on
   the oracle-bounded floor as the interim.
3. Off-chain only (keeper). **No contract change.** This is fund-adjacent → **Auditor note.**

## Phase 1 — on-chain floor DESIGN only (write an ADR; do NOT implement/deploy a contract)
Produce **`docs/ADR/ADR-011-order-onchain-floor.md`** (Proposed) designing the proper fix:
- **Real per-chunk output floor:** replace the `if (minOut==0) minOut=1` clamp with a floor **derived from a Chainlink
  read at execution** within a **signed max-slippage bound** — **revert** if the received output is below it (the
  on-chain terminal backstop DCA currently lacks).
- **Resolve `routerDataHash`:** either lock the route at signing, or back dynamic calldata with the oracle floor — so
  the on-chain check is no longer a no-op.
- **(For the FUTURE Limit/SL/TP re-wire — P1b/P1c, latent):** note the **unordered/bitmap nonce** (Permit2-style) so each
  conditional order is independently executable/invalidatable, and that non-DCA orders must carry a real
  `routerDataHash`. Flag these as prerequisites to re-wiring the parked panels.
- This is an OrderExecutor **v3** (the deployed executor is not upgradeable) → the ADR must cover **deploy + 48h
  timelock + keeper/frontend migration + the Auditor pass + a deploy runbook.** **Do NOT implement or deploy the
  contract in this sprint** — the ADR goes to Architect + Auditor for approval, then a separate gated deploy sprint.

## Do NOT
- Do **not** deploy or change a contract in this sprint (Phase 1 = ADR/design only). Do **not** silently fall back to
  the public mempool on Base. Do **not** fill a DCA chunk with no floor when a reference exists. Keep the
  recipient/router/on-chain gates intact. No `ALLOW_PLAINTEXT_KEY`, no wagmi-v3.

## Files affected (verify on main)
- Phase 0: the keeper (`executor.js` / route-builder / KMS submission path) + the reference plumbing (#18/#248). Phase
  1: a new `docs/ADR/ADR-011-order-onchain-floor.md`; read-only reference `TeraSwapOrderExecutor.sol` :508-509 /
  :420-423 / :528, `DCAPanel.tsx:431`, `useOrderEngine.ts`.

## Expected output
- Branch `sprint/order-onchain-floor` off latest `origin/main`; SSH-signed; CI green. **Phase 0 implemented** (keeper
  oracle-bounded floor + Base private-submission-or-documented, fail-closed); **Phase 1 ADR written** (on-chain floor +
  routerDataHash + bitmap-nonce, with the deploy/migration/Auditor plan). Tests: a DCA fill below the oracle floor is
  rejected; a no-reference pair uses the conservative floor + flag; the submission fail-closes if the private relay is
  configured-but-unavailable. FEEDBACK: the Phase-0 mechanism, the Base MEV-protect finding, and the ADR summary.
  **Flag for Auditor (fund-flow).**

## Quality criteria
Live DCA fills are **oracle-bounded** (no blind sub-reference fill) and **MEV-protected-or-documented** on Base; the
on-chain floor is **fully designed in an ADR** (not deployed); the keeper-compromise-to-dust tail is closed by the
ADR's design; recipient/router/on-chain gates intact; Auditor-gated.

---

### `/goal` paste for the Code Agent (≤4000)
```
SPRINT-ORDER-ONCHAIN-FLOOR per docs/Prompts/SPRINT-ORDER-ONCHAIN-FLOOR.md. Branch
sprint/order-onchain-floor off origin/main, SSH-signed (noreply committer), CI
green. FUND-FLOW -> flag for Auditor. Phase 0 = implement (off-chain keeper, NO
redeploy); Phase 1 = an ADR only (NO contract deploy/change this sprint).

Context (threat model PR #277, P1a HIGH confirmed): DCA signs minAmountOut=1 ->
OrderExecutor clamps minOut to 1 wei (:508-509), routerDataHash=0, priceFeed=0 ->
the on-chain minimumOutput is a NO-OP for DCA. All DCA protection is the off-chain
0.5% KEEPER_SLIPPAGE via public mempool when FLASHBOTS_RPC_URL unset (Base has no
Flashbots -> sandwichable). DCA is LIVE on Base; keeper-compromise/route-bug drains
principal to dust.

Phase 0 (IMPLEMENT now, keeper only):
1. Oracle-bounded per-fill floor: before each DCA fill, compute expected output
   from a reference (Chainlink first, else DefiLlama — reuse #18/#248) and
   reject/tighten if the built swap's expected output < reference*(1-maxSlippage).
   Replace the flat 0.5% KEEPER_SLIPPAGE. No reference for the pair -> conservative
   flat floor + flag, do NOT fill blind.
2. Base private/MEV-protected submission: investigate if a Base private-relay
   endpoint exists for the keeper; if so route DCA fills through it FAIL-CLOSED
   (never silently use the public mempool — mirror the key-guard). If none exists,
   document it + rely on the oracle floor.
   Off-chain only, no contract change.

Phase 1 (ADR ONLY — docs/ADR/ADR-011-order-onchain-floor.md, Proposed; do NOT
implement/deploy a contract): design the real per-chunk on-chain floor (Chainlink
read at execution within a SIGNED max-slippage bound; replace the 1-wei clamp with
a REVERT); resolve routerDataHash (lock route at signing OR back dynamic calldata
with the oracle floor); note the unordered/bitmap nonce (Permit2-style) + real
routerDataHash as prerequisites for the future Limit/SL/TP re-wire (P1b/P1c). It's
an OrderExecutor v3 (not upgradeable) -> ADR covers deploy + 48h timelock + keeper/
frontend migration + Auditor pass + deploy runbook. Do NOT deploy here.

Do NOT: deploy/change a contract this sprint; silently use the public mempool on
Base; fill a DCA chunk with no floor when a reference exists; touch the recipient/
router/on-chain gates; ALLOW_PLAINTEXT_KEY; wagmi-v3.

Files: Phase 0 = keeper (executor.js / route-builder / KMS submission) + #18/#248
plumbing; Phase 1 = docs/ADR/ADR-011...; read-only TeraSwapOrderExecutor.sol
:508-509/:420-423/:528, DCAPanel.tsx:431, useOrderEngine.ts. Tests: sub-floor DCA
fill rejected; no-reference pair uses conservative floor+flag; submission
fail-closes if the relay is configured-but-unavailable. FEEDBACK: Phase-0
mechanism + Base MEV-protect finding + ADR summary. Flag for Auditor.
```
