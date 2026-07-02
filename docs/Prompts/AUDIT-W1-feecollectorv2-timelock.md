> 🛑 **SUPERSEDED / WITHDRAWN (2026-07-01, Wave 2).** W2 proved on-chain (by selector) that the DEPLOYED FeeCollector
> (`0x47f2` mainnet + `0xeFC3` Base) is **`TeraSwapFeeCollector.sol`, NOT `..._flat.sol`** — the `transferAdmin`/
> `setAllowedSelector`-without-timelock functions this prompt targeted **do not exist on-chain** (they live only in
> the stale flat file). W1-L-01 is therefore MOOT. The real issue is the stale/misnamed source → **AUDIT-W2-source-integrity.md**
> (W2-M-01). **Do NOT implement this prompt.** Kept for the record per rule #4.

# AUDIT-W1-feecollectorv2-timelock — timelock FeeCollector V2 admin/selector changes (W1-L-01, LOW) — SUPERSEDED

> **Source:** T-SAF campaign 2026-07-01, Wave 1 finding **W1-L-01 (LOW)**. **⚠ Contract change** → rules #2/#3:
> Auditor re-pass + on-chain verification required; **never deploy without 0C/0H** and CI `test-contracts` green.
> **RICE:** LOW impact × near-zero marginal effort **if bundled with the pending P68 deploy** → do the bundle.

## Context
Wave 1 confirmed the OrderExecutor is well-guarded (admin change = 7-day timelock; router/executor/sweep = 48h).
But the **FeeCollector V2** (`TeraSwapFeeCollectorV2_flat.sol`, deployed mainnet `0x47f2…7459`) exposes
**`transferAdmin` and `setAllowedSelector` with NO timelock** — an instant admin swap or selector change (the same
"instant `transferAdmin`, zero-addr-guarded only" behaviour noted in the HW-wallet Fase-4 analysis). Impact is
**LOW**: swaps are `msg.sender`-funded (permanent approvals are not admin-drainable), `sweep` is still 48h +
fixed `feeRecipient`, and only transient in-contract fees are exposed. It is a **defense-in-depth** gap, not a
loss path — hence LOW, not a blocker.

Separately, **P68** (the FeeCollector V2 `minimumOutput` deploy) is already pending (CLAUDE.md; Wave 1 W1-I-02
confirmed the deployed V2 has no on-chain minOutput). **Both are FeeCollector V2 contract changes not yet
deployed** → ship them as ONE deploy, not two.

## Objective
Add a timelock to the FeeCollector V2's privileged admin/selector mutations (consistent with the OrderExecutor's
pattern), and **land it together with P68's `minimumOutput`** in a single audited V2 contract + deploy.

## Requirements
1. **Timelock `transferAdmin`** on FeeCollector V2 — a two-step or delayed admin change (mirror the OrderExecutor's
   `queueAdminChange`→wait→`executeAdminChange` semantics, or the project's established admin-timelock pattern).
   Keep the zero-address guard.
2. **Timelock (or bound) `setAllowedSelector`** — a selector-allowlist change should not be instantaneous; apply
   the same delay class as the OrderExecutor's router/selector timelock (48h) or a documented equivalent.
3. **Bundle with P68:** land these changes in the SAME FeeCollector V2 source + deploy that adds `minimumOutput`
   (do not schedule a separate contract deploy for a LOW fix).
4. **Tests (the real gate):** `forge test` covering — admin change enforces the delay (early `execute` reverts);
   selector change enforces the delay; zero-address still rejected; `sweep`/`feeRecipient` invariants unchanged;
   fee-once + msg.sender-funded invariants preserved. Foundry invariant/fuzz where it adds rigor.
5. **On-chain verification (#2/#3):** after the (test/fork) build, prove the new bytecode's admin/selector paths
   behave as specified; the mainnet deploy itself is a **human-only step** (do not deploy — produce the audited
   contract + tests; deploy is owner-gated after the Auditor re-pass).

## Do NOT
- Do NOT deploy (human-only; owner + Auditor pass first). Do NOT change the `sweep` 48h timelock or the fixed
  `feeRecipient` (they're correct). Do NOT alter the `msg.sender`-funded swap model or the fee-once math. Do NOT
  ship this separately from P68 if P68 is still unshipped (bundle). Commit SSH-signed (noreply committer).

## Files affected (verify on main)
- `contracts/TeraSwapFeeCollectorV2_flat.sol` (+ the non-flat V2 source if separate) + its Foundry tests.
  Coordinate with the pending P68 `minimumOutput` change.

## Expected output
- Branch off latest `origin/main`; SSH-signed; CI green incl. **`test-contracts`**. The V2 admin + selector
  mutations are timelocked; P68 `minimumOutput` included in the same contract; tests prove the delays + preserved
  invariants. FEEDBACK notes the bundle. **Auditor re-pass required before any deploy (#2/#3); 0C/0H bar.**

## Quality criteria
FeeCollector V2 `transferAdmin`/`setAllowedSelector` are timelocked (no instant privileged change), landed together
with P68's `minimumOutput`, fully forge-tested, zero-address + sweep + fee-once invariants preserved, and gated
behind an Auditor re-pass + owner-only deploy.
