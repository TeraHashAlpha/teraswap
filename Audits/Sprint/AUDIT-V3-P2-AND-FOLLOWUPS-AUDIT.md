# AUDIT-V3-P2-AND-FOLLOWUPS — joint gate, two independent verdicts

- **PART A · PR #298 `chore/v3-audit-followups` → ✅ APPROVE-TO-MERGE (0C / 0H / 0M / 0L).**
- **PART B · PR #299 `sprint/v3-p2-signing-keeper` → ✅ APPROVE-TO-MERGE (0C / 0H · 1 bounded M, non-blocking).**
  **HARD pre-deploy prerequisite for V3-P4: v3 `cancelOrder` + `invalidateUnorderedNonces` support must land
  before any v3 executor address is configured on any chain.**

Base: `origin/main` @ `a81cb4c` (includes the merged & approved V3 base #296 @ `954c415`). Both branches branch
cleanly from it; all 8 commits **SSH-signed** (TeraHash noreply). Sandbox: `forge`/`slither` absent → adversarial
source read; CI (`test-contracts` 119/0, vitest 2653/2653, keeper `node:test` 180/180) treated as authoritative
for the mechanical pass. Independent verifications performed: EIP-712 v3 typestring byte-compare, keeper
routing `node --test` (7/7), on-chain-decimals trust trace.

---

## PART A — #298 (delta pass only; base already approved on 954c415)

Audited SHA `7b39478` (3 commits). Diff = **6 contract lines + tests + spec doc only** — verified no
forge-std/OZ submodule files staged, and constants / nonces / routerDataHash / events /
`MAX_ORDER_SLIPPAGE_BPS` all untouched (the `.sol` diff is exactly two hunks).

1. **Guard fires ONLY on `hasFeed && fairOut==0`.** The new `if (fairOut == 0) revert OracleValueZero();`
   sits **inside** the `if (hasFeed)` block, before `oracleFloor` is derived. `_fairValueOut` returns
   `hasFeed=false` for genuine no-feed / stale / incomplete-round / sequencer-down/grace, which skip the block
   entirely → the scaled signed min still applies verbatim. **Approved semantics unchanged**; the guard only
   converts the L-01 silent-downgrade into a no-fill (funds stay). Stricter, never looser — no legitimate order
   is newly reverted (only sub-1-raw-unit dust output, economically meaningless).
2. **Diff hygiene:** exactly the guard + `OracleValueZero` error + tests; agent's "6 contract lines" claim
   confirmed; no submodules.
3. **L-02 adequacy — genuinely end-to-end through `executeOrder`:** 4 sequencer scenarios
   (`down` / `within-grace` / `invalid-round startedAt==0` / `up-past-grace`) each drive a full fill and assert
   the floor CONSEQUENCE (down/grace/invalid → signed-min fallback fills at 500e18; up-past-grace → same output
   reverts `InsufficientOutput`, at-floor clears). Decimals fuzz (`testFuzz_executeOrder_decimalsEnforceFloor`,
   6/8/18 × 8/18) drives a full fill per combo, asserting sub-floor reverts + at-floor delivered to owner. The
   `fairOut==0` test forces a LIVE feed to zero ($1 in / $100k out, dust input, both legs fresh) and expects
   `OracleValueZero`. All three claims hold.

**#298 verdict: APPROVE-TO-MERGE. 0C/0H/0M/0L.** No remediation prompt required.

---

## PART B — #299 (full fund-flow pass)

Audited SHA `689e70f` (5 commits). Files in scope: `src/lib/order-engine/{config,types,v3-min-derivation}.ts`,
`src/app/api/orders/route.ts`, `src/hooks/useOrderEngine.ts`, `src/components/DCAPanel.tsx`,
`contracts/order-engine/executor/{executor-routing,executor}.js`.

**1. EIP-712 v3 module — VERIFIED (not trusted).** `ORDER_V3_TYPE_STRING` (types.ts) and the client
`ORDER_V3_TYPEHASH` (useOrderEngine.ts) are **byte-for-byte identical** to the `.sol` `ORDER_TYPEHASH` (compared
programmatically). Domain = `version "3"` (vs v2 "2"), per-chain `chainId` + per-chain `verifyingContract`;
`getOrderExecutorV3Domain` **throws** when the chain has no v3 address (`ORDER_EXECUTOR_V3_BY_CHAIN` null on all
chains unless env set) → v3 signing UNREACHABLE while null. A v2-vs-v3 cross-sign fails on-chain recovery
(different domain + typehash → recovered ≠ owner → revert). Module-load invariant rejects the same v3 address on
two chains.

**2. `deriveSigningMinAmountOut` — no dust/1-wei path; server re-validation fail-closed.**
No branch yields a 1-wei min: priced legs → `fairOut × (1−bps)/10000` (returns null → falls through if it rounds
to 0); no-feed fallback = `10^max(dstDec−4, 0)` (≈0.0001 token for dstDec≥4, ≥1 raw unit otherwise) — strictly
positive, decimals-scaled, never the 10⁻¹⁸ footgun, and always accompanied by the `hasFeed=false` decay warning
(surfaced in DCAPanel). Server `/api/orders` re-validation is INDEPENDENT of client intent: `isV3Order` = numeric
top-level `maxSlippageBps`; caps it to `(0, 500]`; resolves the v3 executor (unwired chain → 400, fail-closed);
recovers the signer under the branched domain+types and rejects on `recovered ≠ wallet` (line 267); re-checks
`maxSlippageBps` in the order_data mismatch guard (M-07); USD dust floor prices tokenOut via DefiLlama + server
Chainlink and **fails CLOSED to 422 when both are unpriceable**. All run on POST before insert — not bypassable
by a direct API call. **→ M-01 below is the one gap in this guard.**

**3. Keeper `executor-routing.js` / `executor.js` — never mis-routes.** Per-order v2/v3 selection by
`order_data.maxSlippageBps` presence; a v3 order with no `ORDER_EXECUTOR_V3_ADDRESS` on this keeper's chain →
`ok:false` → SKIP + `alertOps` + leave `active` (retried), **never** falls back to v2. v2 tuple stays
byte-identical (maxSlippageBps spread only for v3); all call sites (`canExecute`, floor ref, `writeContract`,
`decodeOrderExecuted`) use the per-order `execAddress/execAbi`. DB-spoofing the discriminator is caught by the
contract's own on-chain signature recovery (the terminal backstop). `order-floor.js` + `submission-policy.js`
are **byte-identical** to main (verified). No new key path; `signer-guard.js`/`kms-signer.js` untouched; KMS only,
no `ALLOW_PLAINTEXT_KEY`. Routing logic independently re-run: **7/7 node:test pass.**

**4. Flagged deviation (v3 cancel/invalidate out of scope) — ACCEPT, with a hard prerequisite.** Both client
paths fail SAFE: single `cancelOrder` refuses a v3 order with an explicit error (never sends a v2-ABI cancel that
would mark the Supabase row cancelled while the on-chain order stays live); cancel-all `invalidateNonces` filters
v3 orders out of `affectedOrders`. Currently UNREACHABLE (no v3 order can exist — `signV3` is false everywhere
and the server rejects v3 creation). No fund loss (refusing to cancel is safe; a live v3 order still executes
only within its signed floor). **But deploying a v3 executor without this wiring would strand users with
uncancellable v3 orders** (materially bad for a stop-loss). → stated as a HARD pre-deploy prerequisite for V3-P4.

**5. Standing checks:** `NEXT_PUBLIC_DCA_ENABLED` untouched; no wagmi-v3 (only test mocks); no secrets in code
(the `0x2222…` is a test fixture key); SC-04/R1 untouched; recipient/whitelist/on-chain gates unchanged.

### Findings

- **M-01 (MEDIUM · bounded · non-blocking) · `src/app/api/orders/route.ts:311-320`.** The v3 USD dust-floor
  scales the DefiLlama leg by an **unsigned, unvalidated** `body.tokenOutDecimals` (`minOutFloat =
  Number(body.minAmountOut) / 10**dstDecimals`) and combines the two legs with **`Math.max()`** — the permissive
  direction for a *floor* gate. The Chainlink leg (`computeTokenAmountUsd`) fetches decimals on-chain (robust)
  but returns null for non-Chainlink tokens. **Exploit:** for a tokenOut that DefiLlama prices but the v3
  contract has NO on-chain USD feed for (exactly the no-feed case where the signed min is the *sole* on-chain
  floor), a malicious/compromised client can spoof a high `tokenOutDecimals` to inflate the DefiLlama-leg USD;
  `max()` lets it satisfy the $5 floor while the real signed min is dust → a compromised keeper can then drain
  that chunk. **Bounds (why not H):** needs BOTH a compromised signer-side client (the victim's own wallet
  signs the dust min — self-harm otherwise) AND a compromised keeper to realise loss; the on-chain oracle floor
  fully protects every on-chain-fed pair regardless; and it is latent (v3 undeployed). Off-chain defense-in-depth
  weakening, not a single-compromise fund path → does not block merge. Remediation prompt below; fold into the
  V3-P2 hardening and close **before V3-P4 deploy**.

### Remediation prompt (M-01) — Code-Agent-ready

**Context:** `/api/orders` POST derives the v3 dust-floor USD from a client-supplied `body.tokenOutDecimals` on
the DefiLlama leg and takes `Math.max()` of the DefiLlama and Chainlink legs — an unsigned field on a security
floor, combined in the permissive direction. **Objective:** make the dust floor un-spoofable and conservative.
**Requirements:** (1) fetch tokenOut decimals authoritatively on-chain server-side (reuse
`fetchErc20Decimals(tokenOut, chainId)`, same path the Chainlink leg uses) — never trust `body.tokenOutDecimals`
for the USD computation; (2) for a *floor* check use the conservative estimate — the lower of the available
priced legs (or require the on-chain-decimals-consistent leg), not `max`; (3) when the ONLY available price is
the DefiLlama leg for a tokenOut that has no on-chain v3 USD feed, keep the fail-closed posture rather than
accepting a single spoofable estimate. **Do NOT:** relax the existing unpriceable-both → 422 branch, or change
the v2 path. **Files:** `src/app/api/orders/route.ts` (the `isV3Order` dust-floor block). **Tests:** extend
`src/app/api/orders/orders-v3.test.ts` — a spoofed-high `tokenOutDecimals` with a dust `minAmountOut` on a
DefiLlama-only token must be REJECTED; an honest priceable order still passes. **Quality:** the dust floor
cannot be bypassed by any unsigned client field; fail-closed on single-source no-on-chain-feed tokens.

_Read-only; no source edited. Report + AUDIT-TOTAL block left for the owner's SSH-signed batch (rule #12)._
