# ADR-014 — Execution model for non-DCA conditional orders (Limit / SL·TP) on OrderExecutor v3

- **Status:** Proposed (design gate for P1b/P1c — Architect adjudicates before any implementation sprint)
- **Date:** 2026-07-21
- **Context:** owner greenlight to start P1b (Limit on v3) surfaced an open design question that blocks
  implementation. **No code, contract, runbook or live config is changed by this ADR.**
- **Related:** [ADR-013](ADR-013-order-onchain-floor.md) §1–§3 (the v3 on-chain floor this builds on),
  `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (ground truth, cited by line below),
  `Audits/Reviews/THREAT-MODEL-2026-07-07.md` (P1a/P1b/P1c), PR #296 (`595e6ab` — the routerDataHash
  split), PR #299 (dual-executor keeper routing), PR #301 (v3 cancel + mass-cancel),
  `docs/Runbooks/V3-EXECUTOR-DEPLOY.md`.

## Context — what the deployed bytecode allows and forbids for non-DCA

v3 is **deployed and live on Base** (Foundry broadcast `DeployOrderExecutorV3.s.sol/8453`, cutover smoke
2026-07-21 over real v3 DCA orders). ADR-013 §46's "not yet executed" text is stale. The executor is
**immutable** — every constraint below is fixed bytecode with no setter.

For an order with `orderType != DCA`, `executeOrder` enforces, in order:

| Gate | Line | Effect on non-DCA |
|---|---|---|
| `routerDataHash == 0` → `RouterDataRequired` | `:463-465` | **ZeroHash is forbidden.** The P1c fix; no admin bypass. |
| `keccak256(routerData) != routerDataHash` → `RouterDataMismatch` | `:465` | The keeper may submit **only** the exact calldata whose hash was signed. |
| `_useUnorderedNonce` (CEI, before any external call) | `:497-499` | One execution per order; independently invalidatable (ADR-013 §3). |
| `executeAmount = order.amountIn` | `:500` | Whole notional in one shot — **no chunking, no partial fill**. |
| `_checkPriceCondition` → `PriceConditionNotMet` | `:504-509` | Trigger is enforced **on-chain**… but `priceFeed == address(0)` returns `true` unconditionally (`:1105-1108`), so a non-DCA order only has a real trigger if it carries a live feed. |
| `floorOut = max(oracleFloor, minAmountOut)` | `:521-554` | `scaledMin = order.minAmountOut` verbatim for non-DCA (`:528`); `oracleFloor = fairValue(netAmount) × (10_000 − maxSlippageBps)/10_000` when both legs have registered USD feeds (`_fairValueOut`, `:1072-1097`), else the signed absolute min is the sole floor. |
| `maxSlippageBps <= MAX_ORDER_SLIPPAGE_BPS = 500` | `:144`, `:440` | Immutable cap, no setter. |
| whitelisted router / executor, `nonReentrant`, output → `order.owner` | `:434`, `:457`, `:432`, `:592-616` | R1 recipient safety unchanged. |

**The blocking tension.** A Limit/SL·TP route is only knowable *at trigger*, but the deployed bytecode
demands a real `routerDataHash` *at signing*. ZeroHash reverts; re-signing at trigger destroys autonomy.

**The fact that dissolves most of the tension.** `FEE_BPS = 10` and `BPS_DENOMINATOR = 10_000` are
`constant` (`:131-132`), and non-DCA sets `executeAmount = order.amountIn` (`:500`). Therefore
`netAmount = amountIn × 9990 / 10_000` — the exact amount the router is approved for (`:563`) and called
with (`:570`) — is **fully deterministic at signing time**. Route-pinning is mechanically possible; what
breaks it is not the amount but *quote-derived content inside the calldata*.

## Options

### (a) Route-pin at signing, restricted to **quote-free** calldata — works on deployed bytecode
Pinning fails for aggregator calldata (Augustus V6, 0x, Kyber, Bebop/CoW) because it embeds quoted
amounts, deadlines and — for RFQ — maker signatures with expiry. Worse, a limit order triggers *precisely
because the price moved*, so a pinned aggregator quote is evaluated under conditions guaranteed to differ
from signing. That path is dead on arrival.

But a **canonical DEX route is durable**: `exactInputSingle`/`exactInput` on the Uniswap V3 SwapRouter —
which `config.ts:165-169` records as *already whitelisted on the OrderExecutor* — encodes only
`(tokenIn, tokenOut, feeTier, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96)`.
Set `deadline = type(uint256).max`,
`amountOutMinimum = 1`, `recipient = executor`, `amountIn = netAmount` (deterministic above) — and the
calldata embeds **no quote and no clock**. It stays valid indefinitely. Output protection does not come
from the router's own minOut but from the contract's `max(oracleFloor, minAmountOut)` (`:532-554`), which
is already binding in deployed bytecode.

- **Cost:** meta-aggregation is given up for conditional orders — one pinned pool instead of best-of-11.
  Bounded by the oracle floor to ≤ `maxSlippageBps`; on deep major pairs the realised gap is small bps.
- **Residual risk:** the pinned pool can be thin/dislocated at trigger → output < floor → **revert**. The
  order silently fails to fill *although its condition was met*. This is fail-**safe** (no bad fill) but
  not fail-**live**, and for a stop-loss "did not fill during a crash" is a capital-protection failure —
  the same flavour as threat-model P7b.
- **UX honesty requirement:** the user signs a *specific pool route*, not "best execution at trigger". The
  review modal must say exactly that, and must not promise aggregator-quality fills.

### (b) Contract vNext — allow ZeroHash for non-DCA when both legs have a registered feed
Mirror of the DCA bypass rationale (`:467-471`): oracle floor binding + recipient == owner + whitelisted
router + `nonReentrant`. The mirror is **structurally sound and in fact strictly stronger for non-DCA**,
which additionally passes `_checkPriceCondition` — a gate DCA does not have (`priceFeed = 0`).

Two genuine deltas the DCA argument does *not* carry over:
1. **Magnitude.** DCA risks one chunk per interval, with a time-gate between fills for monitoring to
   react. Non-DCA risks the **entire notional in a single tx** (`:500`). Same ≤5% bound, N× the exposure.
2. **Volatility correlation — the sharp one.** DCA fires on a *clock*, uncorrelated with volatility. A
   Limit/SL fires on a *price boundary*, i.e. exactly when Chainlink lags spot most (feeds move on
   deviation thresholds + heartbeat). A keeper with route freedom can select the moment of maximum
   oracle lag; the effective extraction window becomes *(oracle lag) + maxSlippageBps*. A **stop-loss is
   the worst case** — it is guaranteed to execute during a fast move.
   *Mitigation available without new invention:* require a tighter `maxSlippageBps` (e.g. ≤100 bps) on the
   ZeroHash non-DCA path specifically.
- **Deploy/migration cost is now high, and rising.** v3 is live with real user orders, so this is a v4:
  new immutable deploy + 48h timelock + a fresh fund-flow Auditor pass + **triple**-executor routing
  (v2 draining, v3 live, v4 new) in keeper + frontend + a runbook revision. This cost would have been
  near-zero before 2026-07-18; it is not recoverable now.

### (c) Bounded delegation signed at creation — **not expressible without a contract change**
The signed struct carries one router address and one exact-calldata commitment; `ORDER_TYPEHASH`
(`:121-124`) is fixed and `getOrderHash` is `pure` (`:1149`). There is no field meaning "any calldata
satisfying constraints X". Note that `maxSlippageBps` *is* already exactly this primitive — but v3 only
lets it govern the output floor, and only lets it substitute for calldata commitment on the DCA branch.
So (c) is "extend the existing delegation primitive to the non-DCA branch" — it **collapses into (b)**.

### (d) Considered and rejected
Cancel + re-sign to refresh a stale route (kills autonomy; burns a nonce and a wallet prompt per refresh —
defensible only as an optional manual affordance); short-expiry limit orders on pinned aggregator calldata
(a "limit order" expiring in minutes is not the product); CoW-style off-chain auction (needs a different
settlement contract entirely).

## Scoring

| | security | autonomy/UX | time-to-ship | deploy cost | audit surface | keeper cx | **RICE** |
|---|---|---|---|---|---|---|---|
| **(a) quote-free pin** | ✅ unchanged bytecode | ⚠️ no best-exec; may not fill | ✅ days | ✅ none | ✅ none (no contract) | ✅ submit exact calldata | 8×2×0.9/1.5 ≈ **9.6** |
| **(b) v4 ZeroHash+feed** | ⚠️ new keeper route freedom on triggered orders | ✅ best exec at trigger | ❌ weeks | ❌ v4 + timelock + drain | ❌ full re-audit | ⚠️ route builder at trigger | 8×2.5×0.5/8 ≈ **1.25** |
| **(c)** | — | — | — | — | — | — | folds into (b) |

## Decision (recommended)

**Ship P1b on option (a), and cut the product by failure mode rather than shipping everything on the
weaker model:**

- **P1b (now, no contract change):** **Limit + Take-Profit** on the deployed v3, using quote-free pinned
  canonical Uniswap V3 routes. These are *opportunistic* orders — "did not fill" is an acceptable
  outcome (the user simply does not get the trade), which is exactly the failure mode (a) has. Requires:
  frontend derives a real `routerDataHash` at signing (removing the ZeroHash default at
  `useOrderEngine.ts:695`/`:387` for non-DCA), keeper submits the pinned calldata verbatim, review-modal
  copy states the pinned-route semantics, and the UniV3 SwapRouter whitelist entry is re-confirmed
  **on Base** (mainnet is already recorded as whitelisted; 48h `queueRouterChange` if Base is not).
- **P1c (deferred, gated on (b)):** **Stop-Loss**. Its failure mode is inverted — not filling during a
  crash *is* the loss — so SL should not ride a route that can revert on pinned-pool dislocation. SL waits
  for the (b) contract change and should **ride the next executor deployment rather than forcing one**.
- **Contract change now? — NO.** v3 went live 3 days ago; forcing a v4 immediately would burn the deploy
  budget and a full audit round on a feature (a) already unblocks for two of the three order types.

## Consequences

- **Positive:** Limit/TP ship on audited, already-deployed bytecode with zero new contract risk; P1c is
  descoped to a single well-defined contract delta instead of blocking all of P1b; the (b) delta gets
  batched into whatever the next executor deployment is, amortising the timelock + drain cost.
- **Costs / risks:** conditional orders lose meta-aggregation (bounded by the oracle floor, disclosed in
  UX); a pinned route may fail to fill at trigger (acceptable for Limit/TP, *not* for SL — hence the cut);
  Stop-Loss stays parked until (b) lands, which must be stated honestly and not shipped as "coming soon"
  next to a live Limit panel.
- **Open for the Architect:** whether SL ships on (a) with a documented liveness caveat rather than
  waiting for (b) — this ADR recommends waiting, but it is a product call, not a security one.
- **Do NOT** implement on this ADR alone: it goes to Architect adjudication, and any (b) work needs a
  fund-flow Auditor pass (0C/0H) before deploy.
