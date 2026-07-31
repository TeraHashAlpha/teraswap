# AUDIT-V3-P1-EXECUTOR — fund-flow / merge gate for OrderExecutor v3

**VERDICT: APPROVE-TO-MERGE — 0C / 0H / 0M / 2L / 2I.** PR `sprint/v3-p1-executor-contract` may merge.
Deploy authorization is **NOT** granted here (that is the separate gated V3-P4: 48h timelock + migration +
runbook + on-chain per-chain router/feed verification).

- **Audited SHA:** `954c4150bb0a503f84786032ed253b1b49e01038` (branch tip), 6 commits `0240d7f..954c415`, all
  **SSH-signed** (committer `TeraHash <256859133+TeraHashAlpha@users.noreply.github.com>`).
- **Base:** `origin/main` merge-base `8927f8f` (branch is 6 commits ahead, no drift under the audited files).
- **Scope (read-only):** `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (1174 L) +
  `contracts/order-engine/test/TeraSwapOrderExecutorV3.t.sol` (980 L, **45 tests**); reference: v2
  `TeraSwapOrderExecutor.sol`, ADR-013, SPRINT-V3-P1 spec, threat model P1a/b/c. Phase-0 `order-floor.js`
  NOT re-audited (signed off 2026-07-07). Sandbox: `forge`/`slither` unavailable → adversarial source read;
  CI `test-contracts` (forge 113/0) treated as authoritative for compilation/execution.

---

## Per-deviation adjudication

**1. `fairOut == 0` falls through to the signed min — ACCEPT-with-note (→ L-01, non-blocking FIX recommended).**
`_fairValueOut` returns `(fairOut, hasFeed)` together; the sole `hasFeed=true` return
(`TeraSwapOrderExecutorV3.sol:1089-1090`) can yield `fairOut == 0` by `Math.mulDiv` truncation when the fill's
entire output is worth **< 1 raw unit of tokenOut** (low-decimal, high-price tokenOut × a tiny `netAmount`).
When that happens `oracleFloor = mulDiv(0,…) = 0` and `floorOut = max(scaledMin, 0) = scaledMin` — the oracle
bound silently disappears and the signed min becomes the sole floor.
**Negative-path proof it is not a fund path:** the keeper/API/route controls **none** of the inputs that drive
truncation — `amountIn`, token decimals and the token pair are all EIP-712-signed by the owner; `netAmount` is
derived (`amountIn/dcaTotal − fee`), not keeper-supplied. So on any order whose output is worth ≥ 1 raw
tokenOut unit, `fairOut > 0` and the oracle floor binds; truncation is reachable **only** on economically-dust
output, and even there `scaledMin == 0` already reverts `InvalidMinOutput` (`:529`), so the floor is the user's
own real signed min — **never the v2 1-wei no-op**. Bounded, no keeper-forceable drain on a real order.
**Note:** ADR-013 N4 / SPRINT §2 explicitly asked to *revert rather than compute a 0 floor*. The safer semantic
(`if (hasFeed && fairOut == 0) revert`) treats a feeded-pair-returns-0 as an integrity failure (no-fill, funds
stay) instead of a silent downgrade. Recommend as a defense-in-depth hardening — does not block merge.

**2. Fair-value measured on `netAmount` — ACCEPT.** Fee (0.1%) is taken in tokenIn and sent to `feeRecipient`
(`:554`) **before** the swap; only `netAmount` is approved+routed (`:557`) and priced
(`_fairValueOut(…, netAmount)`, `:539`). Fee is counted exactly once. Floor on `netAmount` is the *looser*
(correct) basis — pricing on gross would over-tighten and strand legitimate fills. Owner's realised loss =
0.1% fee + ≤ `maxSlippageBps` of the remainder; no fee↔slippage stacking, no double-count. Verified numerically
(1000e18 → net 999e18 → floor 949.05e18 at 5%).

**3. DCA outside the bitmap — ACCEPT.** `cancelledOrders[orderHash]` is checked on **every** execution path
(`:452`) *before* the DCA branch, so a cancelled DCA can never fill again. DCA never touches `nonceBitmap`
(gates on `dcaExecutions`/`dcaLastExecution`); `invalidateUnorderedNonces` and `_useUnorderedNonce` both key on
`msg.sender` / `order.owner` respectively — no cross-owner griefing, no DCA/non-DCA nonce collision
(`test_dca_doesNotConsumeBitmap`). ADR §3-conform.

**4. EIP-712 domain version "3" — ACCEPT.** `EIP712("TeraSwapOrderExecutor","3")` (`:329`) vs v2's "2". Domain
separator binds name+version+chainId+verifyingContract, and the `ORDER_TYPEHASH` itself changed (added
`maxSlippageBps`) — triple isolation from v2. Per-chain `chainId` + a new per-chain `verifyingContract` means no
cross-chain replay; the "no two chains share a verifyingContract" rule is a V3-P4 deploy invariant the domain
construction supports.

**5. Timelocked oracle config (48h) + Base sequencer 1h grace — ACCEPT-with-note.** The **fair-value floor**
feed (`tokenUsdFeeds`) is written **only** by `executeTokenUsdFeed`, gated by `TIMELOCK_ORACLE_CHANGE = 48h` +
grace (`test_oracleConfig_isTimelocked`) — P6 closed for the floor, no instant path. `_sequencerUp` forces
`hasFeed=false` when the sequencer is down / within the 1h grace / round invalid (`:1025-1034`); stale / bad /
incomplete-round feed reads also return NO-FEED (`:1050-1053`) → floor falls to the signed min (>0), **never a
zero/blind floor**. Feed swaps take 48h and `cancelOrder` is always available → user cancel window exists.
**Note (I-02):** the *trigger*-condition feed setter `setOracleConfig` (`:917`) stays **instant** — this is v2
parity and affects only *when* an order triggers, not the output floor (which reads `tokenUsdFeeds`); worst case
admin (trusted, EOA→Safe pending) mistimes a trigger, output still bounded by the floor. Acceptable per spec
("keeps the v2 behaviour for the price-condition check only").

---

## Standing checks (v2 parity + regressions)

| Check | Result |
|-------|--------|
| 1-wei clamp removed; no `minOut==1` path anywhere | ✅ v2 `if(minOut==0)minOut=1` GONE; `minAmountOut==0`→revert (`:442`), `scaledMin==0`→revert (`:529`) |
| `maxSlippageBps <= 500` enforced | ✅ `:439` revert `SlippageTooHigh`; tests 501 + 65535 |
| Effective floor = `max(oracleFloor, scaledMin)`, revert on breach | ✅ `:540-547`, `:584/604`; oracle-dominates + signed-min-dominates both tested |
| Decimals-safe math (6/8/18 × feed 8/18) | ✅ `Math.mulDiv`, 18-dec price normalise (`:1082-1089`); `testFuzz_fairValue_decimals` |
| `recipient == order.owner` (R1) | ✅ all 4 delivery branches → `order.owner`; `test_parity_recipientAlwaysOwner` |
| Balance-delta measurement parity | ✅ `tokenOutBalance = balanceOf − tokenOutBefore` (`:573`) |
| Router whitelist (default-deny) | ✅ `:456`; chain-correct V5/V6 is a **V3-P4 deploy-bootstrap** duty (contract has no hardcoded router — correct) |
| Reentrancy | ✅ `nonReentrant`; non-DCA nonce consumed pre-swap (CEI, `:498`); `test_reentrancy_blocked` proves reentrant nonce-1 not consumed |
| Bitmap: no cross-word/mask replay | ✅ canonical Permit2 xor-then-check (`:662-667`); out-of-order / invalidation / replay / whole-word / word-256 all tested |
| `invalidateUnorderedNonces` only `msg.sender` | ✅ `:644` |
| Non-DCA ZeroHash rejected (P1c) | ✅ `:463` `RouterDataRequired`; `test_nonDCA_zeroHash_reverts` |
| Out-of-order execution safe (P1b) | ✅ `test_bitmap_outOfOrderExecution` |
| No new admin surface beyond timelocked floor config | ✅ v3 admin fns = v2 set + `queue/executeTokenUsdFeed` (timelocked) only |

## Untested claims (coverage gaps — informational, non-blocking)

- **L-02 (coverage):** `testFuzz_fairValue_decimals` and all four sequencer tests exercise only the
  `_fairValueOut` **helper**, not `executeOrder` end-to-end. The floor's decimals-normalisation with a 6/8-dec
  token *through a full fill* and the sequencer-down→signed-min *fill* are not asserted at the execution layer
  (the equivalent no-feed/stale-feed fills ARE — `test_noFeed_absoluteMin_path`, `test_staleFeed_*`). Low risk;
  add an executeOrder-level decimals + sequencer case.
- **L-02b:** the `hasFeed && fairOut==0` branch (deviation 1) has **no test** — add one asserting the chosen
  semantic (currently: falls to signed min; recommended: revert).
- **I-01:** `MIN_ORDER_AMOUNT = 10_000` is a **raw-unit** floor, USD-agnostic — it is what makes the dust
  `fairOut==0` case reachable at all. The signing-side USD-min derivation + `/api/orders` dust rejection are
  already scoped to **V3-P2**; flag them as the closure for I-01/L-01.

## Findings

- **L-01 · `TeraSwapOrderExecutorV3.sol:1089` / `:539-548` · ACCEPT-with-note.** `hasFeed=true, fairOut=0`
  silently downgrades the oracle floor to the signed min. Bounded (dust-value output only; not keeper-forceable;
  signed min >0 always binds). Remediation prompt below.
- **L-02 · test file · coverage.** Floor decimals + sequencer paths and the `fairOut==0` branch untested at the
  `executeOrder` layer (see above).
- **I-01 · `:140` (`MIN_ORDER_AMOUNT`) · informational.** Raw-unit min → no USD floor; closed by V3-P2.
- **I-02 · `:917` (`setOracleConfig`) · informational.** Instant trigger-feed setter (v2 parity, trigger-only,
  not the output floor).

---

### Remediation prompt (L-01) — Code-Agent-ready

**Context:** `TeraSwapOrderExecutorV3._fairValueOut` can return `(0, true)` via `Math.mulDiv` truncation for a
fill whose output is worth < 1 raw unit of tokenOut. `executeOrder` then computes `oracleFloor = 0` and the
effective floor collapses to `scaledMin`. ADR-013 N4 requires "revert rather than compute a 0 floor."
**Objective:** on a *feeded* pair, treat `fairOut == 0` as an integrity failure (no-fill), not a NO-FEED
downgrade.
**Requirements:** in `executeOrder`, where `hasFeed` is true, `if (fairOut == 0) revert InvalidMinOutput();`
(or a dedicated `ZeroFairValue` error) **before** deriving `oracleFloor`. Do not alter the genuine NO-FEED path
(`hasFeed == false` → scaled signed min stays the sole floor).
**Do NOT:** change the NO-FEED semantics, the `max(oracleFloor, scaledMin)` rule, or any signature/domain.
**Files:** `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (execution floor block ~`:539-548`).
**Tests:** add `test_feeded_fairOutZero_reverts` (register feeds; craft a low-dec/high-price tokenOut so
`fairValueOut` returns `(0,true)`; assert `executeOrder` reverts). Extend `testFuzz_fairValue_decimals` with a
route through `executeOrder`.
**Quality:** a feeded pair can never fill on a 0 oracle floor; NO-FEED signed-min path unchanged; forge green.

_Audited read-only; no source edited. Commit of this report + the AUDIT-TOTAL block left for the owner's
SSH-signed batch (rule #12)._
