# SEC-1 · Wave 1 — Smart contracts (on-chain trust root) — entry packet  ⚠ rules #2/#3

> **Campaign:** 2026-07-01. **Sprint:** SEC-1 (ordered W1 → W2). **Runner:** Auditor (read-only; never edits code).
> **Grounded on:** `W0-recon.md` §1 inventory + §2 on-chain snapshot (this run, not memory). **Source of truth:**
> T-SAF v1 §5-W1 + §6 INV-1/2/3/6/7 + §9 G1/G4/G7/G10. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12.
> **Bar:** 0C/0H = APPROVED; any C/H blocks prod. Contract changes require Auditor re-pass + on-chain verify (#2/#3).

## Objective
Prove the on-chain trust root is sound: every value-moving path is access-controlled, reentrancy-safe, replay-safe,
and fee-exact — on **both chains** — and that the **source constants match the on-chain reality W0 verified**.

## In-scope (W0-confirmed set)
- `contracts/TeraSwapFeeCollector.sol` (V1) + `TeraSwapFeeCollectorV2_flat.sol` (V2, `minimumOutput`).
- `contracts/order-engine/TeraSwapOrderExecutor.sol` (EIP-712 orders; nonce; router/selector whitelist; admin timelock).
- Deployed set from W0 §2 (verify on the correct chain RPC, never by name):
  - Mainnet: FeeCollector V2 `0x47f2…7459`, FeeCollector V1 `0x4dAE…58eD`, OrderExecutor `0xeFC3…f130`.
  - Base: OrderExecutor `0x135B…2598`, FeeCollector `0xeFC3…f130` (Base bytecode ≠ mainnet).

## Attacker goals (§5-W1 + §9)
Drain via reentrancy (G1.5); bypass access control (G7.1); forge/replay an order same-chain (G4.1) or cross-chain
(G4.2); skip on-chain `minimumOutput` (G1.2); sweep to a non-admin (G1.6); whitelist/route a hostile router or
selector (G1.4); double-execute via nonce reuse (G10.1); land an order's output at recipient ≠ owner (G1.8).

## Must-verify invariants (prove each; negative-path first)
1. **Router/selector whitelist is CHAIN-AWARE and matches on-chain (⚠ the #2 lesson).** W0 proved **mainnet
   OrderExecutor whitelists AugustusV5=true, V6=false, 1inchV6=true**; Base whitelists Augustus V6 (confirm from W0
   §2 Base table). Prove the source's router selection (`getDefaultRouter`/`getWhitelistedRouters` / order.router)
   is chain-scoped and **commits only a router whitelisted on THAT chain** — a name-based "V5→V6" change would break
   mainnet orders. Unrecognized router/selector → **revert** (INV-3). Selector allowlist enforced.
2. **Access control via `admin()` (owner() reverts).** Every state-changing fn is admin-gated; admin rotation = the
   7-day `queueAdminChange`→`executeAdminChange` TimelockAction; executor change = 48h; router/sweep timelocks.
   Unauthorized caller → revert (INV-7). Sweep destination = admin/owner only (G1.6).
3. **EIP-712 replay-safe.** Domain separator **pins chainId** (mainnet executor `0xeFC3…` vs Base `0x135B…`) → no
   cross-chain replay (G4.2); **nonce** prevents same-chain replay (G4.1); typehash correct (INV-6). No double-exec
   via nonce reuse (G10.1).
4. **On-chain `minimumOutput`** (FeeCollector V2) enforced; a violated minOutput reverts (INV-1, G1.2).
5. **Fee-once:** the 0.1% fee applies **exactly once**, never doubled/skipped, across ETH and ERC-20 paths (INV-2).
6. **Reentrancy:** `nonReentrant` (or checks-effects-interactions) on every path where value moves; a reentrant
   token cannot re-enter settle (G1.5).
7. **Recipient binding:** an executed order's output lands with the **owner**, never an attacker recipient (INV-1, G1.8).

## Method & tools (§7.5, with W0's env caveats)
- **`forge test`** is the real gate (must stay green) + `forge coverage` + Foundry **invariant/fuzz** (fee-once,
  minOutput). ⚠ If Foundry isn't in the sandbox (W0 found `cast`/forge absent), do the adversarial source read and
  treat **CI `test-contracts` (linux-x64) as authoritative** (§7.4) — flag the caveat, don't skip the gate.
- **Slither** (reentrancy, access, tx-origin, uninitialized).
- **On-chain proof** (viem/node if `cast` absent, as W0): re-use W0's snapshot; spot-confirm `whitelistedRouters`,
  `admin()`, and `latestRoundData` freshness; prove `cast code` hash == source build.
- **Sub-reviewer panel (§7.1):** ≥3 framings (theft, replay, chain-confusion). A finding stands only if it survives
  a second reviewer's refutation; first-pass noise → `REFUTED` with reason.

## Negative-path battery (each must revert / be refused)
Unauthorized caller · replayed signature · **wrong-chain signature** · selector not in allowlist · **router not
whitelisted on that chain** · minOutput violated · reentrant token · sweep to non-admin · nonce reuse.

## Exit criteria
0C/0H on contracts; every value-moving path proven access-controlled + reentrancy-safe + fee-once + replay-safe;
router/selector selection chain-aware and matching the on-chain whitelist per chain; `minimumOutput` enforced;
on-chain addresses == source. Findings (if any) → §4 evidence bundle → remediation prompts (RICE). W2 (fund-flow)
consumes this wave's contract facts.

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 1 (Smart contracts) per Audits/Campaign/2026-07-01/W1-contracts.md
+ TERASWAP-AUDIT-FRAMEWORK.md §5-W1. READ-ONLY, no code edits. Ground on
W0-recon.md §1/§2 (do NOT re-derive addresses from memory).

Scope: TeraSwapFeeCollector.sol (V1) + TeraSwapFeeCollectorV2_flat.sol (V2) +
order-engine/TeraSwapOrderExecutor.sol; deployed set per W0 §2 (mainnet
FeeCollector V2 0x47f2, V1 0x4dAE, OrderExecutor 0xeFC3; Base OrderExecutor
0x135B, FeeCollector 0xeFC3).

Prove (negative-path FIRST — each must revert/refuse):
1. Router/selector whitelist is CHAIN-AWARE and matches on-chain: W0 showed
   mainnet whitelists AugustusV5=true/V6=false/1inchV6=true; Base whitelists
   Augustus V6. Prove the source commits ONLY a router whitelisted on THAT
   chain; a name-based V5->V6 change would break mainnet. Unrecognized
   router/selector reverts.
2. Access control via admin() (owner() reverts): every state-changing fn
   admin-gated; admin rotation = 7-day queueAdminChange->executeAdminChange;
   executor=48h; router/sweep timelocks; sweep dest=admin only; unauth caller
   reverts.
3. EIP-712 replay-safe: domain pins chainId (mainnet 0xeFC3 vs Base 0x135B) ->
   no cross-chain replay; nonce -> no same-chain replay/double-exec; typehash
   correct.
4. On-chain minimumOutput (V2) enforced; violation reverts.
5. Fee-once: 0.1% applied exactly once, never doubled/skipped, ETH + ERC-20.
6. Reentrancy: nonReentrant/CEI on every value-moving path.
7. Recipient binding: executed order output lands with the owner only.

Tools: forge test/coverage + Foundry invariant/fuzz (fee-once, minOutput) if
Foundry present; else adversarial source read + treat CI test-contracts
(linux-x64) as authoritative, flag the caveat. Slither. On-chain via viem/node
if cast absent (reuse W0 snapshot; spot-confirm whitelistedRouters/admin()/
feed freshness; prove code-hash==source). Spin a >=3-framing sub-reviewer panel
on OrderExecutor + FeeCollector; a finding stands only if it survives a second
reviewer's refutation (mark first-pass noise REFUTED + reason).

Deliver into Audits/Campaign/2026-07-01/W1-contracts.md (report section):
checks-run table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the contracts slice, verdict
(0C/0H bar), remediation-prompt list. Contract fixes need on-chain verify +
re-pass (#2/#3). SSH-signed commit left for owner if no key in sandbox.
```

---

# WAVE 1 — REPORT (executed 2026-07-01, Auditor, read-only)

## Verdict: APPROVED — 0C / 0H / 0M / 2L / 4I
The on-chain trust root is sound on the verified deployed set: every value-moving path is
access-controlled (`admin()` model), reentrancy-safe, replay-safe (EIP-712 domain pins chainId), and
fee-exact (0.1% once); the OrderExecutor enforces on-chain `minOut` + recipient=owner; sweeps are
timelocked + destination-locked. No Critical/High. Two LOW (FeeCollector admin-timelock inconsistency;
single-EOA admin) + four INFO (incl. two packet-premise corrections). **0C/0H ⇒ contract slice APPROVED**;
the LOW remediation touches contract source → Auditor re-pass + on-chain verify before any deploy (#2/#3).

## Environment / method caveats
- **`forge` and `slither` are absent in this sandbox** → Wave 1 is an **adversarial source read + live
  on-chain verification (viem)**; the executable **CI `test-contracts` gate (linux-x64) remains
  authoritative** for `forge test`/coverage (§7.4). Dynamic fuzz/invariant (fee-once, minOut) NOT run
  in-sandbox — recommend confirming the CI run is green before promote.
- On-chain reads: mainnet `ethereum-rpc.publicnode.com`, Base `mainnet.base.org` (viem), this run.
- Commit: SSH-signing is a human step (no key here) — left for the owner's signed batch.

## Checks-run (negative-path first; each must revert/refuse)
| # | Check | Result |
|---|-------|--------|
| 1 | Router whitelist chain-aware & matches on-chain | ✅ `whitelistedRouters` is **per-deployment on-chain state**; mainnet OE re-confirmed **V5=true, V6=false, 1inchV6=true**. Contract is chain-agnostic (whitelist = per-deploy state) → no chain-pinned residue *in the contract*. Off-chain source mirror (`routers.ts`) drift risk is W2/W4. `RouterNotWhitelisted` reverts unknown routers. |
| 1b | Selector allowlist | ✅ FeeCollector **V2** enforces per-router `allowedSelectors[router][selector]` (`swapETHWithFee:228`, `swapTokenWithFee:271`) → `SelectorNotWhitelisted` reverts. OrderExecutor binds the **entire** calldata via `routerDataHash` (non-DCA mandatory). |
| 2 | Access control via `admin()` (owner reverts) | ✅ Every state-changing fn `if(msg.sender!=admin) revert NotAdmin/NotAuthorized`. On-chain `admin()`=**0x9A38…C73C** on OE + FeeCollector V2 (mainnet) + FeeCollector (Base); `owner()` reverts (non-Ownable). |
| 2b | Timelocks + sweep destination | ✅ OE: admin **7d** (`TIMELOCK_ADMIN_TRANSFER`, `queueAdminChange:652`→`executeAdminChange`), router/executor/sweep **48h**, grace 7d; sweep dest = **admin only** (`executeSweep:220/225`). FeeCollector V2 sweep = **48h + feeRecipient-locked** (`requestSweep:330 recipient:feeRecipient`). ⚠ V2 `transferAdmin`/`setAllowedSelector` **not** timelocked → W1-L-01. |
| 3 | EIP-712 replay-safe | ✅ OZ `_domainSeparatorV4()` pins `block.chainid` + `verifyingContract`; on-chain `domainSeparator()` returns a value (OE mainnet). Cross-chain replay impossible (diff chainId + diff addr). Nonce: non-DCA `nonces[owner]==order.nonce`→`++` (no double-exec); DCA `dcaExecutions`+interval+`dcaTotal` cap; `invalidatedNonces` mass-cancel. `ORDER_TYPEHASH:107` matches struct. |
| 4 | On-chain `minimumOutput` | **OE: ✅ enforced** (`minOut` via balance-delta, `InsufficientOutput` reverts, DCA proportional). **FeeCollector V2: ✗ none** (no minOut param/check anywhere) → delegated to router `amountOutMin` → **W1-I-02 (packet-premise correction)**. |
| 5 | Fee-once (0.1%, ETH + ERC-20) | ✅ OE + FeeCollector V1/V2: `fee = amt*10/10000` computed once; ERC-20 uses **balance-delta** (fee-on-transfer safe); V2 `RouterTookTooMuch` bounds router pull to `netAmount+1`. Never doubled/skipped. |
| 6 | Reentrancy | ✅ OE `executeOrder` `nonReentrant` + CEI (nonce/DCA counters set **before** output transfers) + `_inExecution` guards `receive()`; FeeCollector V1/V2 swaps `nonReentrant` + CEI (CRITICAL-002). |
| 7 | Recipient binding | ✅ **OE: output force-delivered to `order.owner`** by the contract (balance-delta transfer), never a calldata recipient. FeeCollector: recipient delegated to routerData (msg.sender-initiated) → off-chain R1 gate → **W1-I-04**, verified in W2. |

## Findings (Sev · file:line · disposition · evidence)
| ID | Sev | file:line | Disposition | Evidence & reasoning |
|----|-----|-----------|-------------|----------------------|
| W1-L-01 | LOW | `TeraSwapFeeCollectorV2_flat.sol:385` (`transferAdmin`), `:191` (`setAllowedSelector`) | REMEDIATION-PROMPT | Both are `onlyAdmin` with **no timelock**, unlike OrderExecutor's 7d admin / 48h router timelocks. Vector: admin-key compromise → instant admin lockout + `pause()` DoS + instant selector authorization. **Bounded** (FeeCollector holds only transient 0.1% fees; swaps are `msg.sender`-funded so standing approvals aren't admin-drainable; sweep stays 48h + feeRecipient-locked) → LOW, not H. Fix: timelock admin transfer + selector changes; move admin to a Safe. Contract change ⇒ Auditor re-pass + on-chain verify (#2/#3). |
| W1-L-02 | LOW | on-chain admin `0x9A38…C73C` (EOA, no code) | REPORT | Single EOA admin controls admin on FeeCollector V1/V2 + OrderExecutor, **both chains**. Centralization/key-mgmt risk; mitigated by OE timelocks + the documented Admin→HW plan ([Key Hardening]). Recommend multisig/Safe + HW. |
| W1-I-01 | INFO | `TeraSwapFeeCollector.sol` (V1, deployed `0x4dAE…58eD`) | REPORT | Legacy V1 lacks V2's selector allowlist (CRITICAL-001) and the 48h sweep timelock (V1 `sweep:307` is instant, to feeRecipient). Superseded by V2. Confirm no active routing/standing approvals to V1; consider pausing/deprecating on-chain. |
| W1-I-02 | INFO | `TeraSwapFeeCollectorV2_flat.sol` (no minOut) | REPORT | **Packet-premise correction:** V2 does **not** implement on-chain `minimumOutput` (grep: none; both swap fns delegate slippage to the router's `amountOutMin`). Consistent with CLAUDE.md "FeeCollector V2 minimumOutput — P68 deploy pending" (not yet shipped). Not a defect (router enforces slippage + off-chain price gate + wallet review); but an independent on-chain minOut would be a *feature*, and W2/W3 must not assume the FeeCollector self-checks output. OrderExecutor DOES enforce on-chain minOut. |
| W1-I-03 | INFO | Base OrderExecutor `0x135B…2598` (packet) | REPORT | **Grounding gap:** not found in source (`grep` none), registry wires no Base `orderExecutor`, order-engine config pins only mainnet `0xeFC3`; not verified on-chain this run. Consistent with Base conditional orders gated off (DCA-on-Base pending). **W1 cannot attest any Base OrderExecutor.** Architect to confirm the deployed Base address (or that none exists) before W2/W8 rely on it. |
| W1-I-04 | INFO | `TeraSwapFeeCollectorV2_flat.sol` swap fns | REPORT | FeeCollector does not bind swap-output recipient on-chain (delegated to routerData); integrity is enforced off-chain (API `validateCallDataRecipient` R1 + wallet review). Not a contract defect (swap is `msg.sender`-initiated & -funded). Verified end-to-end in **W2**. |

## Refuted (first-pass noise — recorded so it isn't re-reported)
- **"DCA `routerDataHash==0` ⇒ arbitrary-calldata theft"** → REFUTED. Non-DCA forbids the bypass
  (`:419` MEDIUM-006). For DCA, output is **contract-delivered to `order.owner`** by balance-delta with
  `minOut` enforced; a swap routing output elsewhere yields delta < minOut → `InsufficientOutput` revert.
  Router must be whitelisted; `nonReentrant`; approval scoped to `netAmount` then revoked.
- **"Sweep to arbitrary recipient"** → REFUTED. OE sweep → `admin`; V2 sweep → `feeRecipient` (hardcoded);
  both 48h-timelocked.
- **"Cross-chain / same-chain replay"** → REFUTED. OZ EIP-712 domain pins chainid + verifyingContract;
  nonce/DCA-counter prevent same-chain double-exec.
- **"Reentrancy on settle"** → REFUTED. `executeOrder` `nonReentrant` + CEI; FeeCollector swaps
  `nonReentrant` + `RouterTookTooMuch` bound + CEI.

## Coverage (contracts slice)
- **Static + on-chain: 3/3 own contracts** fully source-reviewed + live-verified (mainnet FeeCollector
  V2 `0x47f2`, V1 `0x4dAE`, OrderExecutor `0xeFC3`; Base FeeCollector `0xeFC3`). Base OrderExecutor
  **unverifiable** (not deployed/wired — W1-I-03).
- **Dynamic (forge/slither): 0% in-sandbox** (tools absent) → **CI `test-contracts` (linux-x64) is the
  authoritative executable gate**; confirm green before promote.

## Remediation prompts (Code-Agent-ready)
1. **W1-L-01 — timelock FeeCollector V2 admin transfer + selector changes.** Context: `transferAdmin`
   (`:385`) and `setAllowedSelector` (`:191`) are instant, inconsistent with OrderExecutor's timelock
   discipline. Objective: add a queue→execute timelock (align with OE: admin 7d, selector 48h) and/or
   restrict admin to a Safe. Do NOT change fee math, selector semantics, or the sweep path. Files:
   `TeraSwapFeeCollectorV2_flat.sol` (+ its non-flat source of truth). Tests: Foundry — instant
   transfer/selector now reverts pre-timelock; post-timelock succeeds; existing suite green. **Contract
   change ⇒ Auditor re-pass + on-chain verify + redeploy (rules #2/#3); do NOT deploy without 0C/0H.**
2. **W1-L-02 — migrate contract admin `0x9A38` (EOA) to a multisig/Safe + HW** (aligns with [Key
   Hardening]). Ops/governance change; document in a runbook; on-chain `queueAdminChange`→
   `executeAdminChange` (7d) for the OrderExecutor and `transferAdmin` for FeeCollector (after W1-L-01
   adds its timelock). Human/governance boundary — Auditor verifies the new admin on-chain post-change.

## Boundaries
No deploys, no live signatures, no `pause()`/admin txs exercised (human-only). Foundry/Slither dynamic
runs deferred to CI. W2 (fund-flow) consumes: on-chain minOut is OE-only (not FeeCollector); recipient
binding is OE-on-chain vs FeeCollector-off-chain; the V5-not-V6 on-chain whitelist; no Base OrderExecutor.

---
## RE-BASELINE DELTA (2026-07-01, vs `origin/main` @ cb0748d) — per W3-H-01
W1 audited the stale branch. Re-confirmed on production:
- **W1-I-03 (no Base OrderExecutor) — REFUTED on main.** `order-engine/config.ts:18` wires
  `ORDER_EXECUTOR_BY_CHAIN[8453]=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` (CHORE-BASE-ORDER-EXECUTOR-WIRE).
  **On-chain-verified this run:** code 15475b, `admin=0x9A38…C73C`, own `domainSeparator` (per-chain EIP-712,
  distinct from mainnet → no cross-chain replay), `whitelistedRouters` **AugustusV6=true / V5=false /
  1inch=true** — the exact mirror of mainnet (V5=true/V6=false). Chain-specific whitelist invariant holds on
  BOTH chains.
- **W1-I-02 / W1-I-04 / W1-L-01** — already corrected in W2 (deployed V2 = `TeraSwapFeeCollector.sol` with
  on-chain `minimumOutput`; the `_flat` file W1 read is non-deployed). Branch-independent; unchanged.
