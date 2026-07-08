# ADR-013 — On-chain per-chunk output floor for conditional orders (OrderExecutor v3)

- **Status:** Proposed
- **Date:** 2026-07-08
- **Related:** threat model `Audits/Reviews/THREAT-MODEL-2026-07-07.md` (P1a HIGH, P1b/P1c latent), `docs/Prompts/SPRINT-ORDER-ONCHAIN-FLOOR.md`, `contracts/order-engine/TeraSwapOrderExecutor.sol` (:419-423 DCA routerDataHash bypass, :505-509 minOut clamp, :528 output check, :460/:524 sequential nonce), `contracts/order-engine/executor/order-floor.js` + `submission-policy.js` (the Phase-0 keeper mitigation this ADR is the terminal fix for), ADR-011 (FeeCollector/Augustus whitelist — the on-chain gate model), the `#248` deviation guard and `#18` oracle-less advisory (price plumbing reused keeper-side).
- **Supersedes/deploy target:** a new **OrderExecutor v3** (the deployed executor is **not upgradeable**).
- **NOTE on numbering:** SPRINT-ORDER-ONCHAIN-FLOOR proposed "ADR-011"; that number is already taken by `ADR-011-feecollector-augustus-whitelist.md` (and 012 by the copyleft ADR), so this is **ADR-013**. Flagged in FEEDBACK.

## Context
DCA orders sign `minAmountOut = 1` (`DCAPanel.tsx:431`, to clear the contract's `InvalidMinOutput` `== 0` guard). In `executeOrder` the per-chunk floor is scaled `minOut = (minAmountOut × executeAmount) / amountIn` and then **clamped `if (minOut == 0) minOut = 1`** (`TeraSwapOrderExecutor.sol:505-509`), so the on-chain output check `if (tokenOutBalance >= minOut)` (`:528`) is a **1-wei no-op** for every DCA fill. DCA also sets `routerDataHash = 0` (the C-01 calldata commitment is intentionally bypassed for DCA, `:419-423`) and `priceFeed = 0`. Net: the on-chain contract enforces **no meaningful output or price bound on DCA fills**. Every protection is off-chain in the single keeper plus the `/api/swap`-built calldata (a flat 0.5% `KEEPER_SLIPPAGE`, self-referential to the aggregator's own quote), historically submitted via the public mempool when `FLASHBOTS_RPC_URL` was unset.

**Consequence (P1a, HIGH):** a keeper key compromise, a route-builder bug, or `/api/swap` returning loose/zero-slippage or self-consistent-manipulated calldata can extract a chunk's output **down to dust**, and the on-chain backstop the whole T-SAF campaign relies on does not catch it. DCA is **live on Base**.

**Phase 0 (shipped in this sprint, keeper-only, no redeploy):** an oracle-bounded per-fill floor (`order-floor.js`) rejects a DCA fill whose built output is below an independent fair-value reference × (1 − maxSlippage), and a fail-closed submission policy (`submission-policy.js`) stops the silent public-mempool fallback. That cuts the *live* exposure but is **not terminal**: it lives in the same keeper that a compromise would control, and it cannot bind what a malicious keeper submits. The terminal fix must be **on-chain**.

Two adjacent latent gaps (P1b/P1c) block re-wiring the parked Limit/SL/TP panels and are in scope for the same v3:
- **P1b — sequential nonce (`:460`, `:524`):** non-DCA execution requires `nonces[owner] == order.nonce` and advances a single per-owner counter, so a never-triggering low-nonce order **permanently blocks** a higher-nonce stop-loss.
- **P1c — non-DCA `routerDataHash`:** the Limit/SL/TP signing flow omits `routerDataHash` (defaults to `ZeroHash`), which `executeOrder` rejects for non-DCA (`RouterDataMismatch`, `:419`) — those orders are structurally unexecutable as coded.

## Decision (design — NOT deployed in this sprint)

### 1. Real per-chunk on-chain output floor (replaces the 1-wei clamp with a revert)
- Add a **signed max-slippage bound** to the order struct: `maxSlippageBps` (uint16), included in the EIP-712 type hash. The user signs the maximum output shortfall they will accept per fill.
- At execution, derive the floor from a **Chainlink read at execution time** for the pair (or each leg vs USD), not from keeper-supplied calldata:
  `floor = fairValueOut(tokenIn, tokenOut, executeAmount, chainlink) × (10_000 − order.maxSlippageBps) / 10_000`.
- **Revert** (`InsufficientOutput`) when `tokenOutBalance < floor` — remove the `if (minOut == 0) minOut = 1` clamp entirely. There is no dust path: a fill that cannot clear the signed floor does not execute.
- **No-feed pairs:** if no Chainlink feed exists for a leg, fall back to a **signed absolute `minAmountOut`** the user provides per order (a real value, not 1), enforced verbatim. The contract never fills a no-floor order.
- Mirrors the FeeCollector's balance-delta measurement (output is measured as the contract's own `tokenOut` balance delta and delivered to `order.owner`, unchanged) so recipient safety (R1) is untouched.

### 2. Resolve `routerDataHash` (make the on-chain check non-vacuous)
Two options; the ADR recommends (b):
- **(a) Lock the route at signing** — commit `keccak256(routerData)` for each chunk. Rejected for DCA: the route isn't known at signing and stale-route liveness would break recurring fills.
- **(b) Back dynamic calldata with the oracle floor (recommended).** Keep calldata dynamic (keeper-built per chunk) but make the **oracle-derived floor from §1 the binding constraint**, so the absence of a hash commitment no longer means "no bound". For non-DCA (Limit/SL/TP) where the route *can* be pinned at trigger, require a real `routerDataHash`. This removes the P1c landmine: non-DCA orders carry a real hash; DCA relies on the oracle floor.

### 3. Unordered / bitmap nonce (prerequisite for re-wiring Limit/SL/TP — P1b)
Replace the single sequential `nonces[owner]` counter with a **Permit2-style unordered nonce bitmap** (`mapping(address => mapping(uint256 => uint256)) nonceBitmap`), so each conditional order is independently executable and independently invalidatable in any order. Keep a mass-cancel (`invalidateUnorderedNonces(wordPos, mask)`). DCA continues to track per-`orderHash` execution counters (`dcaExecutions[orderHash]`), unaffected. This is a **hard prerequisite** to re-wiring the parked panels — without it, a stop-loss can be permanently blocked behind an unfilled limit order.

### 4. MEV-protected submission remains policy-enforced
The Phase-0 `submission-policy.js` (fail-closed on public-mempool chains; Base's private sequencer mempool documented as sufficient) stays the keeper contract. v3 does not add on-chain MEV protection beyond the per-chunk floor (which bounds realised sandwich loss to `maxSlippageBps`).

## Deploy plan (a SEPARATE, gated sprint — do not execute here)
1. **Implement** OrderExecutor v3 with §1–§3 + full Foundry coverage (per-chunk floor revert, no-feed absolute-min path, bitmap nonce invalidation, DCA `orderHash` counters, R1/recipient parity, reentrancy).
2. **Auditor pass** (fund-flow / execution-selection) — mandatory before any deploy (0C/0H).
3. **Deploy behind the 48h timelock**, per-chain (Base first, since DCA is live there; mainnet if/when DCA activates).
4. **Migration:** the deployed executor is immutable, so v3 is a new address. Migrate the frontend EIP-712 domain (`verifyingContract`), the keeper's `CONTRACT_ADDRESS`/`ORDER_EXECUTOR_ABI`, and the router allowlist; keep v2 executing existing signed orders until they drain/cancel; new orders sign against v3. Reuse the "no two chains share a `verifyingContract`" invariant.
5. **Deploy runbook:** extend `docs/Runbooks/` with the v3 deploy + timelock-queue + keeper-cutover + rollback steps (mirror the Base deploy/KMS runbooks).
6. **Keep the Phase-0 keeper floor** running until v3 is live on every DCA chain — it is the interim, not a replacement.

## Consequences
- **Positive:** the drain-to-dust tail (P1a) is closed by a terminal on-chain revert independent of keeper honesty; re-wiring Limit/SL/TP becomes safe (P1b/P1c resolved); the on-chain model regains the guarantee the T-SAF campaign assumed.
- **Costs / risks:** a new non-upgradeable contract + migration; a Chainlink dependency at execution for feeded pairs (staleness/round-integrity must be enforced on-chain, reusing the existing feed-validation pattern — a stale feed must fail safe, not fill blind); `maxSlippageBps` and the no-feed absolute-min UX must be added to signing; tuning the floor to avoid false reverts on thin Base pairs (the Phase-0 3% keeper band informs this).
- **Do NOT** deploy or change a contract on this ADR alone: it goes to Architect + Auditor for approval, then the gated deploy sprint above.
