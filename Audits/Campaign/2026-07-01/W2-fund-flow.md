# SEC-1 · Wave 2 — Fund-flow integrity (the money invariant) — entry packet  ⚠ rules #2/#3

> **Campaign:** 2026-07-01. **Sprint:** SEC-1 (ordered — consumes W1 facts). **Runner:** Auditor (read-only).
> **Grounded on:** `W0-recon.md` §1/§2 + `W1-contracts.md` REPORT. **Source of truth:** T-SAF v1 §5-W2 + §6 INV-1/2/3
> + §9 G1. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12. **Bar:** 0C/0H = APPROVED.

## W1 facts this wave MUST carry (do not re-assume)
- **FeeCollector V2 has NO on-chain `minimumOutput` (W1-I-02).** The deployed V2 `0x47f2…` does not enforce output;
  **slippage protection on the swap path = the router calldata's `amountOutMin` + recipient gating + whitelist** —
  NOT a FeeCollector minOutput. (P68 would add it; not deployed.) Only the **OrderExecutor** (mainnet `0xeFC3`)
  enforces minOut + recipient=owner on-chain.
- **Router whitelist is chain-specific (W0):** mainnet OrderExecutor = AugustusV5/1inchV6 (V6=false); Base = V6.
- **No Base OrderExecutor in the frontend path (W1-I-03):** Base orders are keeper-executed (→ W8). The frontend
  swap/fund-flow path on Base runs through the **Base FeeCollector `0xeFC3…`** (swap fns), not an OrderExecutor.

## Objective
Prove the money invariant: **output always lands with the user, the 0.1% fee applies exactly once, and unrecognized
routers/selectors are refused** — across all 12 sources × both chains — given V2 has no on-chain minOutput.

## In-scope (§2.1 fund-flow slice)
`api/swap`, `v1/swap` (build path) · FeeCollector routing (V2 mainnet `0x47f2`, Base `0xeFC3`) ·
`calldata-recipient.ts` · `calldata-decoder.ts` · adapters' recipient/selector handling ·
`partner-fee-invariant.ts` · `swap-build-retry.ts`.

## Attacker goal (§5-W2, §9-G1)
Make output land anywhere but the user (G1.1); apply the fee twice or zero (G1.3); sneak an unrecognized
router/selector through (G1.4); **downgrade `amountOutMin`** so a bad-price fill settles (since the FeeCollector
won't catch it — the corrected G1.2 for the swap path).

## Must-verify invariants (INV-1/2/3; negative-path first)
1. **Recipient gating:** `validateCallDataRecipient` forces output → the user on **every** adapter's decoded
   calldata, both chains (INV-1).
2. **Router/selector allowlist:** unrecognized router or selector is **refused**; the committed router is
   chain-correct per W0's on-chain whitelist (INV-3).
3. **`amountOutMin` is the slippage floor (KEY — V2 has no minOutput):** the swap calldata's `amountOutMin`
   reflects the user's slippage/min-output, is **enforced by the router**, and is **NOT downgradable** server-side
   or by a hostile source. Client min-output must be honored server-side (ties to W6/W9 INV-1).
4. **Fee-once:** 0.1% applied **exactly once**, never doubled/skipped, across all sources
   (`partner-fee-invariant`), ETH + ERC-20, incl. fee-on-transfer via balance-delta (INV-2).
5. **FeeCollector routing + FEE_INCOMPATIBLE handling + partner fees** correct; no path bypasses the FeeCollector.

## Method & tools (§7.5)
Trace **each of the 12 adapters'** calldata through `validateCallDataRecipient` on **both chains**; unit + the
`partner-fee-invariant` test; **property-test "fee applied once"** across sources; **fuzz malformed calldata**
(recipient/selector/amount tamper); explicitly trace how `amountOutMin` is derived, threaded into the calldata, and
whether any server path can lower it. On-chain re-confirm FeeCollector routing addrs (viem/node, reuse W0).

## Negative-path battery (each must be refused)
Calldata recipient=attacker · double-fee calldata · selector swap · FeeCollector bypass · per-chain router mismatch
(V6-on-mainnet / V5-on-Base) · **`amountOutMin` downgraded to ~0**.

## Exit criteria
The money invariant holds on every source × both chains; unrecognized routers/selectors refused; fee-once proven;
`amountOutMin` is a non-downgradable slippage floor (compensating for V2's absent minOutput). Findings → §4 evidence
bundle → remediation prompts (RICE). ⚠ Any C/H on fund-flow blocks prod (#2/#3).

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 2 (Fund-flow integrity) per Audits/Campaign/2026-07-01/
W2-fund-flow.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W2. READ-ONLY, no code edits.
Ground on W0-recon.md §1/§2 + W1-contracts.md REPORT.

CARRY THESE W1 FACTS (do not re-assume):
- FeeCollector V2 (0x47f2) has NO on-chain minOutput (W1-I-02) -> swap-path
  slippage protection = router calldata amountOutMin + recipient gating +
  whitelist, NOT a FeeCollector minOutput. Only the mainnet OrderExecutor
  (0xeFC3) enforces minOut + recipient=owner on-chain.
- Router whitelist chain-specific (W0): mainnet=AugustusV5/1inchV6 (V6=false);
  Base=V6.
- No Base OrderExecutor in the frontend path (W1-I-03); Base swap fund-flow
  goes through the Base FeeCollector 0xeFC3.

Scope: api/swap, v1/swap, FeeCollector routing (V2 mainnet 0x47f2, Base 0xeFC3),
calldata-recipient.ts, calldata-decoder.ts, the 12 adapters' recipient/selector
handling, partner-fee-invariant.ts, swap-build-retry.ts.

Prove (negative-path FIRST — each must be refused):
1. Recipient gating: validateCallDataRecipient forces output->user on EVERY
   adapter's decoded calldata, both chains.
2. Router/selector allowlist: unrecognized refused; committed router
   chain-correct per W0.
3. amountOutMin is the slippage floor (V2 has no minOutput): reflects the
   user's min-output, enforced by the router, NOT downgradable server-side or
   by a hostile source. Client min-output honored server-side.
4. Fee-once: 0.1% exactly once, never doubled/skipped, all sources, ETH +
   ERC-20 (fee-on-transfer via balance-delta).
5. FeeCollector routing + FEE_INCOMPATIBLE + partner fees correct; no bypass.

Tools: trace each of the 12 adapters' calldata through validateCallDataRecipient
(both chains); partner-fee-invariant test; property-test fee-applied-once; fuzz
malformed calldata (recipient/selector/amount); trace amountOutMin derivation ->
calldata -> can any server path lower it? On-chain re-confirm FeeCollector addrs
via viem/node.

Deliver into Audits/Campaign/2026-07-01/W2-fund-flow.md (report section):
checks-run table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the fund-flow slice, verdict
(0C/0H bar; any C/H blocks prod #2/#3), remediation-prompt list. SSH-signed
commit left for owner if no key in sandbox.
```

---

# WAVE 2 — REPORT (executed 2026-07-01, Auditor, read-only)

## Verdict: APPROVED — 0C / 0H / 1M / 2L / 2I
The money invariant **holds on every FeeCollector-routed source × both chains**, and is in fact
**stronger than the packet assumed**: the deployed FeeCollector V2 enforces `minimumOutput` **on the
user's own balance delta** on-chain (mainnet `0x47f2` + Base `0xeFC3`, selector-verified this run) — so
output that doesn't reach the user reverts. Recipient gating is fail-closed + chain-aware; the 0.1% fee
is provably applied exactly once (partner XOR FeeCollector, tests green). No Critical/High. **0C/0H ⇒ the
live fund-flow is APPROVED.** One MEDIUM is a **repo/deployment-integrity** issue (stale, misnamed
contract source), not a live-contract defect.

## ⚠ W1 GROUNDING CORRECTION (this wave supersedes three W1 items)
W1 read `contracts/TeraSwapFeeCollectorV2_flat.sol` and concluded V2 had **no** on-chain minOutput. That
file is **NOT the deployed V2.** On-chain selector proof (this run) — deployed set implements the
`minimumOutput` variants and **not** the old ones:

| Signature | selector | mainnet `0x47f2` | Base `0xeFC3` |
|-----------|----------|------------------|---------------|
| `swapTokenWithFee(address,uint256,address,bytes,address,uint256)` (H-04, +minOut) | `0x7f7663d4` | **PRESENT** | **PRESENT** |
| `swapETHWithFee(address,bytes,address,uint256)` (H-04, +minOut) | `0x7739563c` | **PRESENT** | **PRESENT** |
| `swapTokenWithFee(address,uint256,address,bytes)` (old, no minOut) | `0x33178294` | absent | absent |
| `setAllowedSelector(address,bytes4,bool)` (flat-only) | — | absent | absent |
| `sweep(address)` / `admin()` | — | PRESENT | PRESENT |

The deployed V2 matches **`contracts/TeraSwapFeeCollector.sol`** (has `minimumOutput` + `InsufficientOutput(actual,minimum)` + `SwapWithFee(…,tokenOut,outputAmount)`; `sweep`→feeRecipient; no `allowedSelectors`). Consequences:
- **W1-I-02 (V2 has no minOutput) — REFUTED.** Deployed V2 enforces `minimumOutput` against
  `IERC20(tokenOut).balanceOf(msg.sender)` before/after (`TeraSwapFeeCollector.sol:195-227, 253-298`) →
  `InsufficientOutput` revert.
- **W1-I-04 (no on-chain recipient binding) — LARGELY RESOLVED.** When `minimumOutput>0` the user's own
  balance must rise ≥ minOut, so a router directing output elsewhere reverts — on-chain output binding.
- **W1-L-01 (transferAdmin/setAllowedSelector not timelocked) — MOOT for the deployed contract**: those
  functions do not exist on `0x47f2`/`0xeFC3` (flat-file only). W1's findings table should be annotated.
- **New W2-M-01:** the misnamed non-deployed `_flat` file is itself the finding (below).

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | Recipient gating forces output→user, every adapter, both chains | ✅ `validateCallDataRecipient` (`calldata-recipient.ts`) is **fail-closed**: unknown selector `:518`, decode error `:526`, nested multicall `:376` all → `valid:false`. Per-chain FeeCollector resolved from registry `:150-159`. Groups A/B/C/D/E/F cover 1inch/0x/Uni-V2-V3/ParaSwap-Velora/Odos/Kyber. 26/26 recipient tests green. |
| 2 | Router/selector allowlist; unrecognized refused; chain-correct | ✅ Layers: SC-04 `isKnownSwapSelector` (server `route.ts:174`) + R1 `VALIDATED_SELECTORS` + `ROUTER_WHITELIST`/`ROUTER_WHITELIST_BY_CHAIN` + **on-chain `minimumOutput`**. Unknown selector/router → 400. Committed router chain-correct (W0: mainnet V5/1inchV6, Base V6). |
| 3 | `minimumOutput` is a non-downgradable floor | ✅ **On-chain (deployed V2, both chains)** on user balance delta + client-derived `minimumOutput = toAmount*(10000-slippageBps)/10000` (`useSwap.ts:458`, `swap-simulation.ts:89`) passed as the contract arg (`useSwap.ts:528`). Server returns routerData+toAmount but cannot set minOut independently; DefiLlama >$10k gate cross-checks. Router `amountOutMin` in calldata is a second floor. ⚠ malformed `toAmount`→minOut=0 fallback (`10-L-01`) → W2-L-01. |
| 4 | Fee-once (0.1%, ETH+ERC-20, all sources) | ✅ Partner XOR FeeCollector: `FEE_INCOMPATIBLE_SOURCES=[0x,cowswap,bebop]` take native partner fee; all others route the FeeCollector; `usesFeeCollector()` gates it. ERC-20 uses received-balance-delta (fee-on-transfer safe). **partner-fee-invariant 4/4 green**; single `FEE_BPS=10` source of truth. |
| 5 | FeeCollector routing + FEE_INCOMPATIBLE + partner fees; no bypass | ✅ `fetchApproveSpender` approves the chain FeeCollector for routed sources; Bebop→JAM Balance Manager; 0x→Permit2; CoW→VaultRelayer. No path both partner-fees AND FeeCollector-fees. |

## Findings
| ID | Sev | file:line | Disposition | Evidence & reasoning |
|----|-----|-----------|-------------|----------------------|
| W2-M-01 | MED | `contracts/TeraSwapFeeCollectorV2_flat.sol` (whole file) | REMEDIATION-PROMPT | The repo's `…V2_flat.sol` does **not** match the deployed V2 (selector-verified: it lacks the deployed `minimumOutput` swap fns and adds `setAllowedSelector`/`transferAdmin` that are **absent** on-chain). The actual deployed V2 is `TeraSwapFeeCollector.sol`. **Deployment/audit-integrity risk:** a reviewer (W1 did) or a re-deploy could take the wrong, *weaker* (no-minOutput) source. Not a live fund-flow defect (the deployed contract is sound). Fix: remove/rename the stale flat; add a `DEPLOYED-SOURCES.md` pinning each address→exact source file + compiler settings + on-chain code hash. **Does NOT block prod** (repo/process, not the live contract). |
| W2-L-01 | LOW | `useSwap.ts` / `useSplitSwap.ts:355-356` (minOut=0 fallback) | REPORT (10-L-01 family) | A malformed/zero `toAmount` makes the client pass `minimumOutput=0`, disabling the on-chain output check for that (leg of the) swap → protection falls back to R1 recipient gate + router `amountOutMin` + DefiLlama gate. Combined with FeeCollector-as-valid-recipient, a hostile source + malformed quote could **strand** output (griefing, recoverable only via admin sweep→feeRecipient) — **not theft** (a wrong recipient with minOut=0 still needs the R1 gate to pass, which requires user/FeeCollector). Mitigated; already tracked as 10-L-01. Recommend: floor `minimumOutput` to a non-zero derived value or refuse a swap whose `toAmount` is unusable. |
| W2-I-01 | INFO | `swap-selectors.ts` + `calldata-recipient.ts` (allowlists) | REPORT → W7 | Balancer (Vault), OpenOcean, and native Curve (CurveRouterNG) selectors are **absent** from both SC-04 and R1 allowlists, though those routers are chain-whitelisted. Their execution calldata is therefore **fail-closed (refused)** — safe for the money invariant, but implies these are quote-only / non-executable on the swap path. W7 to confirm (add recipient-extraction support if execution is intended; do not add to the trusted set blindly). |
| W2-I-02 | INFO | `calldata-recipient.ts:52-65` (Group F) | REPORT | Group F (Odos/Kyber/ParaSwap) recipients are **not extracted** — trusted to deliver to msg.sender by design. Previously an unverified trust; now **compensated on-chain** by the deployed V2 `minimumOutput` on the user's balance (a Group-F router not delivering to the user → revert). Acceptable. |

## Negative-path battery (each refused ✅)
recipient=attacker → R1 `valid:false` (400) ✅ · unknown/tampered selector → SC-04 400 + R1 fail-closed ✅ ·
nested multicall → SEC-04 reject ✅ · double-fee (partner+FeeCollector) → structurally impossible
(`usesFeeCollector` XOR) ✅ · per-chain router mismatch (V6-on-mainnet) → not in mainnet whitelist ✅ ·
`amountOutMin`/minOut downgrade → on-chain `minimumOutput` reverts + client derives from user slippage ✅
(residual minOut=0-on-malformed → W2-L-01).

## Coverage (fund-flow slice)
- Recipient gate: **all 6 decode groups** reviewed + 26/26 tests; **fail-closed** default proven.
- Fee-once: partner-fee-invariant 4/4 + `usesFeeCollector` logic.
- On-chain: FeeCollector V2 minimumOutput **selector-verified on BOTH chains** (deployed==`TeraSwapFeeCollector.sol`, not the flat).
- Adapters: FeeCollector-routed set (1inch/velora/odos/kyber/uni-v3/sushi + curve/balancer/openocean) mapped to selector groups; 3 (balancer/openocean/native-curve) are fail-closed (W2-I-01, → W7). FEE_INCOMPATIBLE (0x/cow/bebop) verified partner-fee only.
- Not run in-sandbox: full malformed-calldata fuzz corpus + `forge` (deferred to CI); reasoned negative-paths above.

## Remediation prompts (Code-Agent-ready)
1. **W2-M-01 — resolve FeeCollector source-of-truth drift.** Remove or clearly mark
   `TeraSwapFeeCollectorV2_flat.sol` as non-deployed/experimental; confirm `TeraSwapFeeCollector.sol` is
   the canonical V2; add `docs/security/DEPLOYED-SOURCES.md` mapping each on-chain address → source file →
   solc version/optimizer → verified code hash (mainnet `0x47f2`, Base `0xeFC3`, OrderExecutor `0xeFC3`,
   V1 `0x4dAE`). Docs/repo change (no contract logic) → normal review; Auditor confirms the mapping
   against on-chain. Update the W1 report's findings table (annotate I-02/I-04/L-01 as superseded).
2. **W2-L-01 — remove the minOut=0 fallback on malformed quotes.** In `useSwap.ts`/`useSplitSwap.ts`,
   when `toAmount` is unusable, **refuse the swap** (or derive a conservative non-zero `minimumOutput`)
   rather than passing `0` (which disables the on-chain check). Add tests: malformed leg toAmount ⇒ swap
   refused / minOut>0. Frontend-only (no contract/gate change) → safe branch + CI green.

## Boundaries
No mainnet writes/sims/deploys; `forge`/full fuzz deferred to CI. W1 correction handed back (annotate its
table). W3 (gates) + W7 (adapters) consume: on-chain minimumOutput IS live (both chains); Balancer/
OpenOcean/native-Curve are fail-closed on execution; Group-F trust is now minOut-compensated.

---
## RE-BASELINE DELTA (2026-07-01, vs `origin/main` @ cb0748d) — per W3-H-01
W2's frontend/API reads were on the stale branch. Re-confirmed on production:
- **W2-L-01 — STANDS on main.** `useSwap.ts:457-461` (and `useSplitSwap.ts:355-360`) still set
  `minimumOutput = 0n` when `safeBigInt(swapData.toAmount)===null` (malformed adapter `toAmount`), disabling
  the on-chain `InsufficientOutput` check for that swap/leg. Remains a real LOW → remediation prompt stands.
- **W2-M-01 (stale `_flat` source) / on-chain `minimumOutput`** — branch-independent (deployed bytecode).
  Unchanged: deployed V2 (`0x47f2` + Base `0xeFC3`) enforces `minimumOutput` on the user's balance delta.
- **Recipient gate wiring** — confirmed on main (`api/swap/route.ts:216-217`, chain-aware `Number(chainId)`,
  fail-closed) — identical to the stale-branch shape; no delta.

---
## CORRECTION (2026-07-02, per W10) — W2-L-01 + W2-M-01 REMEDIATED on `main`
Default-skepticism applied to my own W4/RB.1 pass — the RB.1 delta above ("W2-L-01 STANDS on main") was
**WRONG**. Verified on `origin/main` @ cb0748d during W10:
- **W2-L-01 → FIXED.** `useSwap.ts:458` calls `deriveMinimumOutput(swapData.toAmount, slippage)`
  (`src/lib/minimum-output.ts`), which **throws `UnusableQuoteError`** on a malformed/≤0 `toAmount` → the
  swap is **refused** (→ 9O fallback), NOT set to `minimumOutput = 0n`. Tagged `[AUDIT-W2 / W2-L-01]`,
  pinned by the CI `minimum-output-guard`. The RB.1 note is superseded.
- **W2-M-01 → FIXED.** `docs/security/DEPLOYED-SOURCES.md` pins the canonical addr→source→compiler→code-hash
  map (re-verified on-chain 2026-07-02); the stale `…V2_flat.sol` is deprecation-bannered + unreferenced;
  `deployed-sources-guard` (`ci.yml:191`) + `scripts/check-deployed-sources.mjs` enforce it. Exactly the
  recommended remediation.
Net W2 open findings on `main`: **W2-I-01 (Balancer/OpenOcean/native-Curve quote-only, → W7-L-02)** remains
INFO; W2-L-01/M-01 closed.
