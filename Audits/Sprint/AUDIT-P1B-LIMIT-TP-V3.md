# AUDIT — SPRINT-P1B-LIMIT-TP-V3 — PR #327 (`sprint/p1b-limit-tp-v3`)

**Date:** 2026-07-21 · **Auditor:** independent Auditor (read-only) · **Type:** FULL fund-flow gate (non-DCA signing + keeper execution on the LIVE OE_V3, Base)
**Verdict: APPROVE-TO-MERGE — 0C / 0H (1 M, 1 L, INFO).** Merge authorized. The M and L are bounded, fail-safe (no fund-loss path), and each carries a remediation prompt; neither blocks under rule #2.

**Desync ruling (the headline question):** NO orderType/condition combination can still desync the signed struct from the policy decision. Every gate branches on the enum produced by a strict bijective `Map` parse, the same enum is encoded into the EIP-712 message, and the SL gate runs *after* ECDSA recovery. Independently reproduced: the pre-fix exploit returns `201 Created`; the fixed code returns `400`.

---

## 1. Grounding

| Ref | SHA | Sig |
|---|---|---|
| `origin/sprint/p1b-limit-tp-v3` (tip, merge of main) | `e727dd16e128a5ac6066ad1bc8b9805059330ddc` | SSH ✓ |
| `210ebe5` docs: CodeQL verdicts | signed | SSH ✓ |
| `94a10a2` fix(api): decisions on verified struct | signed | SSH ✓ |
| `6b1c133` test: 3-way invariant + FEEDBACK | signed | SSH ✓ |
| `f853d78` feat(api): pinned integrity + SL deferral | signed | SSH ✓ |
| `7515753` feat(keeper): replay pinned routes | signed | SSH ✓ |
| `a2c4294` feat(orders): Limit + TP panels | signed | SSH ✓ |
| `34dafb1` feat: canonical builder | signed | SSH ✓ |
| `origin/main` (= merge-base) | `868bc2de7ae5618a41d9fc999312f7b529552034` | — |

8 commits, **7/7 authored SSH-signed** + the merge (SSH). Merge-base **is** main's tip, so the effective diff = `git diff main...branch` = **21 files, 2051 insertions / 76 deletions**. The merge-from-main commit and main share `config.ts` as the only overlap file; the branch's `config.ts` additions (canonical-router selectors) are disjoint from main's Arbitrum-slot additions — no silent capture.
**Caveat (I-03):** sandbox cannot reach GitHub (`git fetch` 403); refs are the owner's locally-fetched `origin/*`. Owner: confirm the GitHub PR #327 head = `e727dd1` before merge.

`TeraSwapOrderExecutorV3.sol` is **byte-identical** to main (shasum match) — **no contract change** (adjacency ✓).

## 2. Checks

| # | Check | Result |
|---|---|---|
| 0 | Enum-desync bypass reproduced pre-fix + fix verified | **PASS** — pre-fix `201`, post-fix `400`; reproduced (§3) |
| 1 | Canonical calldata determinism + contract fee/recipient/floor reconciliation | **VERIFIED** (§4) |
| 2 | No-deadline deviation | **ACCEPTED** — no post-expiry execution path (§5) |
| 3 | routerDataHash enforced end-to-end; no rebuild/unhashed path | **VERIFIED** (§6) |
| 4 | 8 CodeQL alerts adjudicated | **All FP — safe to dismiss** with cited invariants (§7) |
| 5 | Nonce CEI non-DCA; cancels; approve==sign==recipient invariant | **PASS** (§8) |
| 6 | Flags/regressions/keeper retry | **PASS** except **M-01** keeper revert routing (§9) |
| 7 | Adjacency (no contract/whitelist-widen/hand-typed hex) | **PASS** (§10) |
| — | On-chain address + whitelist verification | **PASS** (§11) |
| — | Tests re-run (app vitest + keeper node:test) | **PASS** — pre-fix exploit RED, fix GREEN, keeper 200/200 (§12) |

## 3. Claim 0 — enum desync (VERIFIED, fix confirmed)

The pre-fix route derived EIP-712 enums via a lossy default (`=== 'above' ? 0 : 1`, `... : 2`): any unrecognised value fell through to BELOW/DCA while string-keyed policy gates saw the raw text — so `priceCondition:'BELOW'` slipped past the `=== 'below'` SL gate yet encoded `condition=1` into the signed struct.

Fix (`route.ts:47-64,120-141`): `ORDER_TYPE_ENUM`/`PRICE_CONDITION_ENUM` are **`Map`s** (not object literals — inherited keys like `constructor`/`__proto__` cannot match; verified by test), parsed **total-with-rejection** (`typeof !== 'string' || !has()` → 400) *before* any gate. Every gate keys on `orderTypeEnum`/`conditionEnum`; the persisted row uses the enum-derived canonical label; the SL gate (`:355`) is `orderTypeEnum===STOP_LOSS && conditionEnum===BELOW` and sits **after** `recoverTypedDataAddress` (`:326-333`), so it refuses the order the signature actually bound.

- (a) prototype-pollution **closed** — `Map` lookup; test `inherited Object keys cannot match` passes on fix, and the pre-fix exploit set is RED.
- (b) string→enum **bijective**; every gate on enum. ✓
- (c) SL gate **after** ECDSA recovery. ✓ (test: `the SL decision is made AFTER signature verification`).
- (d) an SL-shaped order signed outside the UI: `/api/orders` is the sole write path, and the keeper only executes Supabase rows fetched by chain — so the API rejection (`400 STOP_LOSS_DEFERRED_REASON`) is the **choke point**; no SL row can exist to be picked up. A `limit`+below or `stop_loss`+above (=Take-Profit) order is *not* the deferred SL and is correctly allowed (the contract shares enum 1 for SL/TP; **condition** is the only valid discriminator and it is used). **No residual desync.**

## 4. Claim 1 — canonical calldata (VERIFIED against deployed bytecode)

`exactInputSingle`, selector **`0x04e45aaf`** (I recomputed: `keccak256("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")[:4]` = `0x04e45aaf`; the 8-field deadline variant is `0x414bf389`). 7 static fields ⇒ **224-byte** ABI body (test-pinned), selector+body = 228B.

Reconciliation with `TeraSwapOrderExecutorV3.executeOrder` (contract read, non-DCA branch):
- **recipient = executor** — the contract pulls `executeAmount` from owner (`:517`), sends fee (`:520`), `forceApprove(router, netAmount)` (`:523`), `router.call(routerData)` (`:528`), then measures **its own** `tokenOut` balance delta (`tokenOutBefore` `:526` → delta `:539`) and delivers the delta to `order.owner` (`:592-616`). If recipient were the owner, the executor's delta would read 0 → `InsufficientOutput` revert. **recipient=executor is the only correct value** (fail-safe on any other). ✓
- **amountIn = netAmount = amountIn − amountIn·10/10000** — `FEE_BPS=10`/`BPS_DENOMINATOR=10000` are `constant` (`:131-132`); non-DCA `executeAmount=order.amountIn` (`:500`); the executor approves exactly `netAmount` (`:523`) and the router pulls exactly that. Builder's `computeNetAmountIn` uses BigInt floor = Solidity floor. **Matches bit-for-bit.** ✓
- **amountOutMinimum = signed minAmountOut** — the router enforces this as its own min; the **binding** protection is the executor's `floorOut = max(oracleFloor, minAmountOut)` (`:532-554`), always ≥ the router min. ✓
- **sqrtPriceLimitX96 = 0** — no pool price limit is **safe** because output protection is the executor's balance-delta-vs-floor check, not the pool limit; an unlimited path that returns too little simply reverts. ✓
- **Zero quote/clock bytes** — every field is a pure function of the signed struct + static config; `pickCanonicalFeeTier` is static (stable↔stable ⇒ 100 else 500), no quoter. Determinism asserted by `canonical-route.test.ts` (incl. an 89-day clock-jump identity) + the repo decoder mirror. ✓

## 5. Claim 2 — no-deadline deviation (ACCEPTED)

SwapRouter02's `exactInputSingle` genuinely has **no** deadline field (that is the original SwapRouter, `0x414bf389`). Time is bound solely on-chain by `if (block.timestamp > order.expiry) revert OrderExpired()` (`:454`), evaluated **before** the swap on every execution. The keeper also pre-filters expired orders (`executor.js:1154`) and treats an expiry as its own terminal status. **No path executes a pinned route after expiry**, keeper races included: even if the keeper submits late, the contract reverts `OrderExpired` at mine time. Committing zero clock in the calldata is strictly better for determinism. **Deviation adjudicated: ACCEPT.**

## 6. Claim 3 — hash enforcement (VERIFIED, no unhashed path)

- **API (`route.ts:415-447`, v3 non-DCA only):** ZeroHash → 400 `RouterDataRequired`-mirror; missing `orderData.routerData` → 400; `verifyRouterDataHash(stored, signedHash)` mismatch → 400. All run **after** signature recovery, so they compare stored bytes against the **signed** hash, not two attacker values. `order_data` cross-check (`:372-407`, M-07) rejects a `routerDataHash` that disagrees with the blob. The two latent defects are genuinely fixed: `routerDataHash`/`routerData` are now POSTed end-to-end (`useOrderEngine.ts`, `supabase.ts`, `types.ts`).
- **Keeper (`pinned-route.js` + `executor.js:1300-1345`):** `resolvePinnedRouterData` returns `pinned:true, ok:false` (refuse, stay active — never rebuild) for ZeroHash-on-non-DCA, missing stored data, malformed calldata, or hash mismatch; only an exact keccak match yields the stored bytes for verbatim replay. The old "hash freshly-built calldata" path is **gone** for non-DCA (it survives only as defence-in-depth on the DCA keeper-built branch, where the contract skips the check). The contract re-enforces at `:465` regardless. **No path trusts or rebuilds unhashed calldata for a pinned order.** ✓

## 7. Claim 4 — CodeQL adjudication (all 8 FP; safe to dismiss)

The original scan raised 9 `js/user-controlled-bypass` on `f853d78`; **1 was a genuine true positive** (the `orderType !== 'dca'` raw-string gate) and is **fixed** (now `orderTypeEnum !== ORDER_TYPE_DCA` off the strict parse), not suppressed. The **8 surviving** alerts map to 5 guard sites (the scanner double-counts `||`). I read each on the fixed code and confirmed the trusted value it rests on:

| Guard (fixed-tree line) | Kind | Trusted invariant it actually rests on | Verdict |
|---|---|---|---|
| `~160` `!signature \|\| !orderHash` | presence | ECDSA `recovered==body.wallet` (`:332`) | **FP** |
| `~169` `!amountIn \|\| ==='0'` | fast-fail | EIP-712-bound + on-chain `MIN_ORDER_AMOUNT`/`OrderTooSmall` (`:441`) | **FP** |
| `~251` `priceFeed` format | format | signature-bound + on-chain `_checkPriceCondition` (staleness/round/config) + non-DCA non-zero-feed re-check | **FP** |
| `~419` `!routerDataHash \|\| ==zeroHash` | non-DCA gate | `routerDataHash` is in the **verified** EIP-712 message; contract `RouterDataRequired` `:463` | **FP** |
| `~431` `!storedRouterData` | precondition | feeds `verifyRouterDataHash`, a keccak compare vs the **signed** hash | **FP** |

Every one is a fast-fail/format check whose real trust boundary is the ECDSA recovery or an on-chain re-enforcement. **All 8 are false positives and are safe to dismiss in the UI, each citing the invariant above.** The meaningful lesson — CodeQL *missed* the real desync bug — is already addressed (§3). Process note: inline `// codeql[...]` suppressions are not honoured by every scan config; if the 8 persist after push they need UI dismissal with these citations (the true positive is fixed in code either way, and CI `security-extended` should confirm the TP is gone). I could not run CodeQL locally (no CLI) — CI is authoritative for the "0 net-new high" count.

## 8. Claim 5 — nonce / cancel / three-way invariant (PASS)

Non-DCA consumes the unordered nonce via `_useUnorderedNonce(order.owner, order.nonce)` **before any external call** (`:497-499`) — CEI, one execution per order, independently invalidatable. Single + mass cancel are **not in this diff** (unchanged from PR #301, which covered non-DCA via `invalidateUnorderedNonces`) — adjacency-clean. The BUG-DCA-APPROVE-SPENDER-V3 PASS2 invariant is extended to a **three-way** identity for non-DCA: `canonical-route.test.ts` pins that the encoded `recipient` == `resolveSigningExecutor(chainId, isV3=true)` (the same source approve + signing use), that a substituted recipient changes `routerDataHash` (so it can't be swapped post-signing → `RouterDataMismatch`), and that the owner is never the direct recipient.

## 9. Claim 6 — flags / regressions / keeper (PASS, except M-01)

Fail-closed flag: `isLimitLaunchEnabled` requires the strict literal `'true'`; `isLimitLive` additionally requires Base(8453) + a configured v3 executor + a canonical router — any missing ⇒ "Soon" teaser (verified by 5 `page.test.tsx` gating tests). v2 non-DCA path byte-identical (the pinned API gate and panel route-build are `isV3Order`/`v3Live`-scoped). DCA byte-identical (`resolvePinnedRouterData` returns `pinned:false` for DCA → keeper builds per-chunk as before; the freeze/floor gates are DCA-enum-scoped). `page.test.tsx` guard inversion is intentional and replaced by equivalent live/gated coverage. Phase-0 (`resolveSubmissionPolicy`) and `order-floor.js` (DCA-only) untouched.

### M-01 · MEDIUM · `contracts/order-engine/executor/executor.js:1730` · keeper mis-routes the *common* pinned dislocation revert

The new "pinned-route revert keeps the order ACTIVE until expiry (+alert at 5)" handler is gated on **`swapReason`** — i.e. only a decoded `SwapFailed(bytes)` from the router. But the **expected** dislocation revert for a *triggered Take-Profit* is `InsufficientOutput()` from the **executor's own floor check** (`:614`), which is a distinct custom error: `decodeSwapFailed` returns null → `swapReason` null → the pinned branch is **skipped** → the order flows into `handleExecutionFailure`, where `classifyFailure` finds no permanent signature match (`insufficientoutput` matches none of the allowance/balance/nonce regexes) → **transient** → after `MAX_CYCLE_FAILURES` (8) consecutive cycles the order is marked **`failed` / `no_route_after_retries`** + a `failed-exec` alert.

Why this is the *common* case, not a corner: the router calldata carries `amountOutMinimum = signed minAmountOut` (derived from the user's **target**), while the binding floor is `max(oracleFloor, minAmountOut)` and `oracleFloor` is fair-value **at trigger**. A TP triggers precisely when price rose *above* target, so `oracleFloor > minAmountOut` is the norm — meaning a pool that returns output in the band `[minAmountOut, oracleFloor)` lets the **router succeed** but the **executor revert `InsufficientOutput`** (the mishandled path). Only a *deeper* dislocation (output < `minAmountOut`) reverts at the router as `SwapFailed` and reaches the intended handler.

**Failure scenario:** TP on WETH→USDC, target hit, Uniswap pool momentarily thin so realised out is 1% under the oracle fair value but above the signed min. Executor reverts `InsufficientOutput`. Keeper counts it as a transient no-route miss; after 8 cycles the still-valid TP is marked `failed` and the operator is paged with `no_route_after_retries` — instead of the order staying `active` until expiry and the intended `pinned-route-revert` liveness page at 5. **Impact:** off-chain only — **fail-safe, no funds move, no bad fill** (the revert is atomic; the on-chain floor backstop is intact). It is a liveness/telemetry regression that **contradicts the sprint's own stated invariant** ("a pinned-route revert must NEVER walk the failure ladder to 'failed'") in the common path, and it is untested (the pure `planPinnedRouteRevert` unit tests never exercise the `executor.js` catch-block routing). **Bounded, no fund-loss path ⇒ does not block (rule #2).** Remediation prompt below.

## 10. Claim 7 — adjacency (PASS)

No `.sol` change (`TeraSwapOrderExecutorV3.sol` shasum identical to main). No whitelist widening: `isWhitelistedRouter`/`getCanonicalRouteRouter` only **read** `getWhitelistedRouters` (`CANONICAL_ROUTE_ROUTER_KEY='uniswapV3'` selects from the chain's existing set); no router literal added to a chain map. No hand-typed hex in fund paths — router comes from the registry; the only address literal in the diff is the v3 test constant, which matches the deployed OE_V3.

### L-01 · LOW · `src/lib/order-engine/config.ts:169` · latent chain-pinned residue for a future mainnet Limit enablement

`getCanonicalRouteRouter(1)` resolves the **mainnet** `uniswapV3` entry, which is the **original** Uniswap SwapRouter `0xE592…1564` (8-field `exactInputSingle`, selector `0x414bf389`) — but `buildCanonicalRoute` always emits the **SwapRouter02** 7-field selector `0x04e45aaf`. That calldata sent to the original SwapRouter would be malformed and revert. **Not reachable today** (`isLimitLive` is Base-only; mainnet is gated off), so no current impact — but it is exactly the #1 historical defect class (mainnet assumption on a would-be new chain path) waiting for whoever enables Limit on mainnet. Remediation: pin the canonical builder to SwapRouter02 addresses per chain (or assert the selected router's variant matches the emitted selector) before any non-Base enablement.

## 11. On-chain verification (read 2026-07-21)

| Contract | Address | code | admin() | whitelist |
|---|---|---|---|---|
| Base **OE_V3** (live target) | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` | 18 247 B | `0x9a38…c73c` | SwapRouter02 `0x2626…e481` → **1** ✓; AugustusV6 → 1; orig SwapRouter `0xE592…` → **0** |
| Base OE v2 | `0x135B…2598` | 15 475 B | `0x9a38…c73c` | SwapRouter02 → 1 |

The pinned canonical router (`BASE_ROUTERS.uniswapV3 = 0x2626664c…e481`, SwapRouter02) is **already whitelisted on OE_V3** — no `queueRouterChange` needed, no widening. The 7-field selector matches SwapRouter02's ABI (recomputed above).

## 12. Tests (re-run by the Auditor)

| Suite | Result |
|---|---|
| `canonical-route.test.ts` + `orders-p1b.test.ts` (fix tip) | **36/36 PASS** |
| `orders-create.validation` + `page.test.tsx` + `useOrderApproval.v3` + `OrderReviewModal` (fix tip) | **77/77 PASS** |
| Keeper `node --test` (all `*.test.mjs`, incl. `pinned-route.test.mjs`) | **200/200 PASS**, 36 suites |
| **Exploit tests against PRE-FIX (`6b1c133`, tip exploit suite overlaid)** | **8 FAIL as designed** — `expected 201 to be 400` on the SL-`BELOW`, mixed-case, unknown-condition, DCA-gate, native-ETH-gate, non-string, prototype-key, and post-recovery cases. Bypass independently reproduced; tests are not vacuous. |

Method note: branches extracted via `git archive` into `/tmp` with symlinked `node_modules`; the tip `orders-p1b.test.ts` was overlaid onto the pre-fix tree to prove the exploit set is genuinely RED there. No repo files modified except this report + the AUDIT-TOTAL append.

## 13. Findings

| ID | Sev | Where | Disposition |
|---|---|---|---|
| M-01 | MEDIUM | `executor.js:1730` | Common TP `InsufficientOutput` dislocation revert bypasses the pinned-route-revert handler → marked `failed` after 8 cycles + wrong alert, vs stay-active-till-expiry. Fail-safe, no fund path. **Non-blocking**; prompt §14. |
| L-01 | LOW | `config.ts:169` | Mainnet `uniswapV3`=original SwapRouter (8-field) vs builder's SwapRouter02 selector — latent, unreachable behind the Base-only gate. Prompt §14. |
| I-01 | INFO | CodeQL | 8 surviving alerts all FP, safe to dismiss with §7 citations; the 1 true positive is fixed in code; CI authoritative for "0 net-new high". |
| I-02 | INFO | keeper backoff | `orderRetries`/`pinnedRouteReverts` are in-memory (reset on keeper restart) — a restart re-zeros a revert streak. Documented in FEEDBACK; acceptable. |
| I-03 | INFO | process | Audited against locally-fetched refs; confirm GitHub PR #327 head = `e727dd1` before merge. |

**0C / 0H → APPROVE-TO-MERGE.** No contract change, no gate weakened (gates *strengthened*: enum-desync closed, hash enforced end-to-end), no whitelist widened, all fund-flow backstops (recipient=executor, `max(oracleFloor,minAmountOut)`, nonce CEI, router whitelist, `RouterDataRequired`/`Mismatch`) re-verified intact. The M/L are bounded and fail-safe; fix them in a follow-up, not a merge-blocker.

## 14. Remediation prompts (both non-blocking; M-01 recommended before the P1b go-live smoke)

> **M-01 — route the executor's own `InsufficientOutput` revert through the pinned-route-revert handler.**
> **Context:** For a triggered non-DCA v3 order, the *common* dislocation revert is the executor's `InsufficientOutput()` (router succeeds but output < `max(oracleFloor, minAmountOut)`), not a router `SwapFailed`. `executor.js:1730` gates the "stay-active-till-expiry + alert at 5" handler on `swapReason` (decoded `SwapFailed` only), so `InsufficientOutput` falls through to `handleExecutionFailure` and is marked `failed`/`no_route_after_retries` after `MAX_CYCLE_FAILURES` — defeating the sprint's stated pinned-route liveness invariant in the common case.
> **Objective:** a pinned (non-DCA v3) order that reverts for a *route/market* reason — `SwapFailed` **or** `InsufficientOutput` (and `PriceConditionNotMet` if reachable post-precheck) — must take the `planPinnedRouteRevert` path (stay `active`, `pinned-route-revert` alert at the threshold), never `handleExecutionFailure`'s failure ladder. A genuine *permanent* cause (allowance/balance/nonce) must still fail fast.
> **Requirements:** detect the executor's `InsufficientOutput` selector (and decode it like `SwapFailed`); branch the non-DCA-v3 case on "market/route revert" rather than on `swapReason` truthiness; keep DCA and permanent-cause classification unchanged.
> **Do NOT:** touch the contract; change signing/calldata; alter DCA; widen any gate.
> **Files:** `contracts/order-engine/executor/executor.js`, `pinned-route.js`, `revert-decode.js`, keeper tests.
> **Tests:** a keeper test that an `InsufficientOutput` revert on a non-DCA v3 order leaves it `active` and increments the pinned-revert streak (not `orderRetries`→`failed`); permanent causes still fail fast; DCA unchanged. **Quality:** `node --test` green; one SSH-signed commit.

> **L-01 — pin the canonical builder to SwapRouter02 per chain before any non-Base Limit enablement.**
> **Context:** `getCanonicalRouteRouter(1)` returns the original mainnet SwapRouter (8-field `exactInputSingle`, `0x414bf389`); the builder emits SwapRouter02's 7-field selector `0x04e45aaf`. Unreachable today (Base-only gate) but would break a future mainnet Limit.
> **Objective:** make the canonical router↔selector pairing chain-correct by construction — either register SwapRouter02 as the canonical entry per enabled chain, or assert at build/gate time that the selected canonical router is a SwapRouter02 deployment matching the emitted selector; fail-closed otherwise.
> **Do NOT:** widen the on-chain whitelist; add hand-typed hex outside the registry.
> **Files:** `src/lib/order-engine/config.ts`, `canonical-route.ts`, `limit-launch.ts`, tests.
> **Tests:** a per-chain assertion that `getCanonicalRouteRouter(chainId)` is a SwapRouter02 the executor whitelists and whose ABI matches `0x04e45aaf`. **Quality:** tsc+eslint+vitest green; one SSH-signed commit.

---
*Auditor has no signing key — report + AUDIT-TOTAL append are left for the owner's SSH-signed batch (rule #12). On-chain reads via viem/JSON-RPC (publicnode / mainnet.base.org). Contract line numbers cite `TeraSwapOrderExecutorV3.sol` @ this SHA.*
