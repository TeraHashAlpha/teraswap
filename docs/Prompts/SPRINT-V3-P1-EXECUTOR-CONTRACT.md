# SPRINT-V3-P1-EXECUTOR-CONTRACT — OrderExecutor v3: on-chain per-chunk floor + routerDataHash + bitmap nonce (ADR-013 §1–§3)

> **Source:** `docs/ADR/ADR-013-order-onchain-floor.md` (Auditor **APPROVED-TO-IMPLEMENT** 2026-07-07, combined pass
> 0C/0H/0M/0L) — terminal fix for threat-model **P1a (HIGH)** (DCA minOut clamped to 1 wei → on-chain `minimumOutput`
> is a no-op) + latent **P1b** (sequential nonce blocks SL/TP) + **P1c** (non-DCA `routerDataHash=0` structurally
> unexecutable). Integrates the Auditor's v3 design notes **N1–N4**. Owner decisions 2026-07-09: **scope = full
> ADR-013 §1–§3** (option B — one immutable deploy closes P1a and unblocks P1b/P1c); **no-feed pairs ALLOWED** with a
> signed absolute `minAmountOut` backstop (decay mitigations below); **`MAX_ORDER_SLIPPAGE_BPS = 500` immutable
> constant, no setter.** **Fund-flow/contract → Auditor-gated: PR stays UNMERGED until 0C/0H.** **NO deploy in this
> sprint** — deploy + 48h timelock + migration + runbook are the separate gated V3-P4/deploy step (ADR-013 plan).
> SSH-signed (noreply committer); branch `sprint/v3-p1-executor-contract` off latest `origin/main` in a **dedicated
> worktree**; 6 droppable commits.

## Objective
Implement **TeraSwapOrderExecutorV3.sol** (new contract — the deployed v2 is not upgradeable) with the real per-chunk
output floor, resolved `routerDataHash` semantics, and the Permit2-style unordered nonce bitmap, with full Foundry
coverage. Implementation + tests ONLY: no deploy, no migration, no frontend/keeper/API changes (V3-P2).

## Requirements (per-commit)

### 1. Order struct / EIP-712 + kill the 1-wei footgun
- Add **`maxSlippageBps` (uint16)** to the order struct and EIP-712 typehash (new domain — v3 is a new
  `verifyingContract`; keep the "no two chains share a verifyingContract" invariant).
- **N3:** validate `order.maxSlippageBps <= MAX_ORDER_SLIPPAGE_BPS = 500` (immutable constant, **no setter**) at
  execution; revert otherwise (uint16 would allow 655%).
- **Remove the `if (minOut == 0) minOut = 1` clamp** (v2 `:505-509`). If the per-chunk scaled `minAmountOut` rounds
  to 0 → **revert `InvalidMinOutput`** — a 1-wei total min becomes structurally unexecutable instead of silently
  unprotected (N2, contract side).

### 2. Chainlink fair-value at execution (N4 + N1 read-validation)
- `fairValueOut(tokenIn, tokenOut, executeAmount)` derived from **Chainlink reads at execution** — each leg vs USD
  from the on-chain oracle config (direct pair feed when configured).
- **N4 decimals-safe math:** OZ `Math.mulDiv` full-precision; normalize token decimals (6/8/18) and feed decimals;
  no intermediate overflow; no rounding-to-zero on small chunks (revert `InvalidMinOutput`-class error rather than
  compute a 0 floor).
- **Feed integrity (N1):** enforce staleness window + round integrity (`answer > 0`, `updatedAt` fresh,
  `answeredInRound >= roundId`) reusing the existing feed-validation pattern; on Base validate the **L2 sequencer
  uptime feed + grace period** before trusting a read. **Stale/invalid ⇒ treated as NO-FEED** — never fill blind.
- Oracle-config setter (token → feed) must be **gated by the timelock-owner** (closes the P6 `setOracleConfig`
  finding for v3; do not add any other admin surface).

### 3. Floor enforcement (§1)
- Feeded pair: `floor = fairValueOut × (10_000 − order.maxSlippageBps) / 10_000`; effective floor =
  `max(oracleFloor, scaledMinAmountOut)`; `tokenOut` balance-delta `< floor` → **revert `InsufficientOutput`**. No
  dust path.
- **No-feed or stale pair (N1/N2, owner decision):** enforce the **scaled signed `minAmountOut` verbatim** as the
  sole floor. (Signing-side derivation of a real min from a reference price, dust rejection in `/api/orders`, and
  the long-DCA decay warning are **V3-P2**; the keeper Phase-0 `order-floor.js` stays live as the off-chain
  reference for no-feed pairs until then and beyond.)
- Output measured as the contract's own `tokenOut` balance delta and delivered to `order.owner` — the recipient
  model (R1) and `recipient == order.owner` guard are **UNCHANGED**.

### 4. `routerDataHash` resolution (§2, option b — P1c)
- **Non-DCA (Limit/SL/TP): require a real `routerDataHash`** — revert on `ZeroHash` (orders will pin the route at
  trigger; re-wire is a later sprint).
- **DCA:** keeper-built dynamic calldata remains allowed; the §1 oracle floor is the binding constraint.

### 5. Unordered nonce bitmap (§3 — P1b)
- Replace sequential `nonces[owner]` with a **Permit2-style bitmap**
  (`mapping(address => mapping(uint256 => uint256)) nonceBitmap`) so each conditional order is independently
  executable/invalidatable in any order; add `invalidateUnorderedNonces(uint256 wordPos, uint256 mask)` mass-cancel.
- DCA keeps per-`orderHash` execution counters (`dcaExecutions`), unaffected.

### 6. Foundry coverage (full)
Sub-floor fill reverts; stale feed → absolute-min path; no-feed path; sequencer-down on Base → no-feed semantics;
fuzz decimals (6/8/18 legs × 8/18 feed decimals); `maxSlippageBps` 501 and 65535 rejected; scaled-min-rounds-to-0
reverts; bitmap: out-of-order execution, invalidation, replay rejected; DCA `orderHash` counters; parity with v2 on
`recipient == owner` + chain-correct router whitelist (mainnet Augustus V5 / Base V6); reentrancy.

## Do NOT
- Do **not** deploy, and do not touch the deployed v2 executor or FeeCollector.
- Do **not** add any admin setter beyond the timelock-gated oracle config (the slippage cap is a constant).
- Do **not** modify frontend/keeper/API (V3-P2), weaken `recipient == owner`, the router whitelist, or SC-04/R1.
- No `ALLOW_PLAINTEXT_KEY`; no wagmi-v3.

## Files affected (read ONLY these + the new files)
- **New:** `contracts/order-engine/TeraSwapOrderExecutorV3.sol`, its Foundry tests under `contracts/order-engine/test/`.
- **Edit:** `docs/ADR/ADR-013-order-onchain-floor.md` (status **Proposed → Accepted**, note the 2026-07-07 Auditor
  sign-off + the three 2026-07-09 owner decisions), `docs/Prompts/SPRINT-V3-P1-EXECUTOR-CONTRACT.md` (commit this spec).
- **Read-only reference:** `contracts/order-engine/TeraSwapOrderExecutor.sol` (`:419-423`, `:460`, `:505-509`,
  `:524-528`), `DCAPanel.tsx:431`, `useOrderEngine.ts`, `contracts/order-engine/executor/order-floor.js`,
  `submission-policy.js`, ADR-011 (whitelist gate model).

## Expected output
Branch `sprint/v3-p1-executor-contract` (dedicated worktree), SSH-signed, PR open with CI green; push + report — do
NOT watch/poll CI. Spec + ADR status flip committed in the PR. FEEDBACK ≤1 screen in the PR body: floor mechanism,
no-feed/stale semantics, bitmap design, any deviation from ADR-013. **Flag for Auditor (fund-flow) — do NOT merge.**

## Quality criteria
The 1-wei clamp is gone (revert path only); every fill is bounded by a signed cap ≤5% or a real signed absolute min;
non-DCA can no longer carry `ZeroHash` router data; nonces are order-independent with mass-cancel; math is
decimals-safe under fuzz; feed reads fail safe (stale/sequencer-down ⇒ no-feed semantics); R1/recipient/whitelist
parity with v2 proven by tests; Auditor-gated.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Opus · effort high · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

SPRINT-V3-P1-EXECUTOR-CONTRACT per docs/Prompts/SPRINT-V3-P1-EXECUTOR-CONTRACT.md (commit the spec in this PR). Branch sprint/v3-p1-executor-contract off origin/main in a DEDICATED worktree, SSH-signed, CI green. FUND-FLOW/CONTRACT -> Auditor-gated: PR UNMERGED until 0C/0H. Implement + test ONLY: NO deploy/migration/frontend/keeper/API (later prompts).

Context: ADR-013 approved-to-implement (Auditor 2026-07-07). v2 NOT upgradeable -> new TeraSwapOrderExecutorV3.sol (Solidity 0.8.28, Foundry). P1a: DCA signs minAmountOut=1 -> v2 clamps minOut to 1 wei -> on-chain minimumOutput is a NO-OP for DCA; P1b: sequential nonce can block a stop-loss; P1c: non-DCA ZeroHash routerDataHash always reverts. Owner decisions: full ADR-013 s1-s3; no-feed pairs allowed w/ signed absolute min; MAX_ORDER_SLIPPAGE_BPS=500 immutable constant (NO setter).

Commits (droppable, in order):
1. EIP-712/struct: add maxSlippageBps (uint16) to the typehash (new domain; keep "no two chains share a verifyingContract"). Enforce maxSlippageBps <= 500 at execution (uint16 allows 655%). REMOVE the `if (minOut==0) minOut=1` clamp; per-chunk scaled minAmountOut rounding to 0 -> revert InvalidMinOutput (kills the 1-wei footgun).
2. fairValueOut(tokenIn, tokenOut, executeAmount) from Chainlink AT EXECUTION (each leg vs USD via on-chain oracle config; direct feed when configured). Decimals-safe: OZ Math.mulDiv, normalize token (6/8/18) + feed decimals, no overflow, no rounding-to-zero floors. Feed integrity: answer>0, staleness window, answeredInRound>=roundId (reuse existing pattern); on Base check the L2 sequencer uptime feed + grace. Stale/invalid => treat as NO-FEED, never fill blind. Oracle-config setter gated by the timelock-owner (closes P6/setOracleConfig for v3); no other admin surface.
3. Floor: fairValueOut*(10000-maxSlippageBps)/10000; effective = max(oracleFloor, scaledMinAmountOut); tokenOut balance-delta < floor -> revert InsufficientOutput (no dust path). No-feed/stale: enforce the scaled signed minAmountOut VERBATIM as sole floor (signing-side derivation + API dust rejection = V3-P2). Output = contract's own tokenOut balance delta to order.owner — recipient model (R1) UNCHANGED.
4. routerDataHash (s2b): non-DCA REQUIRES a real routerDataHash (revert on ZeroHash); DCA keeps dynamic keeper calldata, oracle floor = binding constraint.
5. Nonces: Permit2-style unordered bitmap (mapping(address=>mapping(uint256=>uint256)) nonceBitmap) + invalidateUnorderedNonces(wordPos, mask) mass-cancel, replacing sequential nonces[owner]. DCA keeps per-orderHash dcaExecutions counters.
6. Foundry: sub-floor fill reverts; stale-feed -> absolute-min path; no-feed path; Base sequencer-down => no-feed; fuzz decimals 6/8/18 legs x 8/18 feed; maxSlippageBps 501 + 65535 rejected; scaled-min-0 reverts; bitmap out-of-order + invalidation + replay rejected; DCA counters; v2 parity on recipient==owner + chain-correct router whitelist (mainnet Augustus V5 / Base V6); reentrancy.

Also: flip ADR-013 Proposed->Accepted (note the Auditor sign-off + owner decisions).

Do NOT: deploy or touch deployed v2/FeeCollector; add admin setters beyond the timelock-gated oracle config; modify frontend/keeper/API; weaken recipient==owner, router whitelist or SC-04/R1; ALLOW_PLAINTEXT_KEY; wagmi-v3.

Files: NEW contracts/order-engine/TeraSwapOrderExecutorV3.sol + tests in contracts/order-engine/test/; EDIT docs/ADR/ADR-013-order-onchain-floor.md + docs/Prompts/SPRINT-V3-P1-EXECUTOR-CONTRACT.md. Read-only: TeraSwapOrderExecutor.sol (:419-423,:460,:505-509,:524-528), DCAPanel.tsx:431, useOrderEngine.ts, executor/order-floor.js, submission-policy.js, ADR-011.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen in the PR body: floor mechanism, no-feed/stale semantics, bitmap design, deviations from ADR-013. Flag for Auditor (fund-flow) — do NOT merge.
```
