# ADR-015 — Order execution economics: user-pays-gas (estimate-with-cap), per-type fees, and the v4 cut

- **Status:** Proposed (records owner decisions fixed 2026-07-23; the contract work needs a fund-flow Auditor
  pass 0C/0H before any deploy). **No code, contract, runbook or live config is changed by this ADR.**
- **Date:** 2026-07-22
- **Context:** the first production v3 DCA fills each cost the keeper ~0.002 ETH (~$4) in gas — dominated by
  L1 data fees on fat aggregator calldata — against $0.01–0.02 of protocol fee. DCA is structurally
  loss-making per fill. This ADR fixes the economics for **v4**.
- **Related:** [ADR-013](ADR-013-order-onchain-floor.md) (the v3 oracle floor this builds on),
  [ADR-014](ADR-014-nondca-execution-model.md) (its option (b) consolidates here),
  `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (deployed, immutable — cited by line),
  `docs/Prompts/SPRINT-KEEPER-FILL-ECONOMICS.md` (keeper half),
  `src/lib/order-engine/budget-slippage.ts` + `DCAPanel` wiring (UI half, **already shipped**),
  `docs/Reports/FILL-ECONOMICS-CALIBRATION.md` (**pending** — supplies every number left open in §7).

## Owner decisions (fixed — recorded, not re-litigated)

| # | Decision |
|---|---|
| **D1** | **Standing scope rule:** small controlled increments; several small audited deploys over one big one. v4 scope is driven by the **live DCA product**; SL/TP/Limit ride along only at ~zero marginal cost ("perfect DCA first, then the rest"). **Batching is OUT of v4 core** — §6 study only. |
| **D2** | **User pays gas**, deducted from the posted order value, capped on-chain by the signed "Max execution cost" budget. Mechanism = **estimate-with-cap**, not perfect metering; every input is a constant, a consensus value or a system-contract read — **never keeper-self-reported**. Gas above the cap ⇒ **defer, never execute**. Fee charged per execution on each chunk's value. |
| **D3** | **Fees:** simple swap 0.1% (FeeCollector, unchanged); DCA / Limit / SL·TP = **0.20%**. **Transparency is a product invariant:** a full receipt per execution, and **no "free"/"gasless" claim, ever**. Fee rises are stated publicly and owned. |
| **D4** | **Attack gas, not fees.** Compact canonical routes + net-cost routing (maximise the *user's* net **including gas** — a direct pool beats the aggregator when cheaper all-in) ship **keeper-side, before v4**. |
| **D5** | **Fees UI** = **dated** best-effort estimates, ours vs competitors' *effective* cost (EVM only; implied, never named). **New requirement — settlement receipt:** on DCA completion/cancellation the user gets the **exact realised** costs (fee + gas per fill, totals, vs the upfront estimate). Read-only; **v4-independent**, shippable on v3 data now. |
| **D6** | Contract-side changes consolidate with Stop-Loss (ADR-014 option b) into **one v4** — cut so the **DCA slice leads and SL cannot delay it**. DCA stays flag-off until v4. |

## 1. v4 mechanism — user pays gas, estimate-with-cap

**Where the charge is taken: input-side, before the swap.** v3 already deducts the fee from `tokenIn` before
routing (`:518-519`, `:560`) and prices the floor on the routed amount (`:540`). Putting the gas charge in the
same place leaves the delicate parts untouched — the balance-delta measurement (`:579`), the three output
branches (`:590-611`), the dust refund (`:614-617`). An output-side deduction would have to be threaded
through all three delivery branches: a much larger audit surface on the most sensitive code in the contract,
for no user-visible difference.

**The estimate (no keeper input anywhere):**

```
gasWei      = L2_GAS_UNITS[orderType] × min(block.basefee + PRIORITY_ALLOWANCE_WEI, tx.gasprice)
            + l1DataFeeWei(msg.data.length)        // chain gas-oracle predeploy; 0 when gasOracle == 0
gasInTokenIn = gasWei  →  USD via ETH/USD feed  →  tokenIn units via tokenIn/USD feed
budgetIn     = executeAmount × maxExecCostBps / 10_000
gasCharge    = min(gasInTokenIn, budgetIn > fee ? budgetIn − fee : 0)
netAmount    = executeAmount − fee − gasCharge
floorOut     = max(scaledMin, fairValueOut(executeAmount) × (10_000 − maxExecCostBps) / 10_000)
```

- `L2_GAS_UNITS[orderType]` is a **compile-time constant**, calibrated (§7) and deliberately biased *low* —
  the protocol eats the residual rather than over-charging the user (D3).
- `tx.gasprice` appears only as an **upper clamp**: a keeper that overpays eats the excess and can never
  profit by inflating gas price. `block.basefee` is consensus-set.
- The dominant cost driver — the **L1 data fee** — is metered from `msg.data.length`, a real observable
  available at function entry. This makes **D4 self-enforcing**: fat aggregator calldata charges more, so
  compact canonical routes win on the user's net without any extra policy.
- **Conversion reuses `_fairValueOut`'s discipline** (`:1046-1097`): registered feeds only, `answer > 0`,
  staleness, `answeredInRound >= roundId`, sequencer-up + grace. Needs **ETH/USD + tokenIn/USD** — a
  *strictly weaker* requirement than the oracle floor, which needs both legs. Gas metering therefore covers
  more pairs than the floor does.

**Cap enforcement is oracle-free.** `budgetIn` is pure arithmetic in `tokenIn` units, so the cap binds even
when the oracle is degraded. `maxExecCostBps` (uint16, signed, new `ORDER_TYPEHASH`, domain version "4")
**replaces `maxSlippageBps` and becomes all-in**: the floor is repriced on the **gross** `executeAmount`
(v3 prices it on `netAmount`, `:540`), so fee + gas + slippage surface as one gap against fair value. That is
*strictly stronger* than v3, where the fee sits outside the signed bound — and it matches the already-shipped
`budget-slippage.ts` math exactly: **`budgetUsdToBps` becomes the v4 signing path with zero change to its
arithmetic**, and the shipped DCAPanel copy ("up to $B total — includes the $F protocol fee") becomes
literally true rather than a display convention.

**No-feed fallback (D2's noted constraint).** If ETH/USD or tokenIn/USD is unregistered, stale, or the
sequencer is down, `gasInTokenIn = 0` — the fill still executes, protocol absorbing gas. No new revert path,
no new liveness failure. The economics are protected one layer up: the **keeper's gate defers** a fill whose
gas it cannot recover, and the **frontend refuses to create** v4 orders on an unmetered `tokenIn`. Registering
a feed (48h timelock) restores coverage. Rejected alternatives: silent protocol-absorb is a ~$4/fill griefing
vector; a keeper-supplied conversion rate violates D2.

**Defer semantics.** The keeper simulates before submitting; projected output below `floorOut` ⇒ **do not
submit**. Deferral has **zero on-chain side effect** — no nonce consumed, `dcaExecutions` /
`dcaLastExecution` (`:584-587`) untouched — so the DCA schedule slips rather than the order failing. Retry
each poll cycle within a tolerance window (gas oscillates); on expiry, `alertOps` + policy flag, default
**skip and keep the order active — never execute at unbounded loss**. Repeated deferral against the 90-day
expiry can leave chunks unfilled: that must surface in the UI and the §5 receipt, not silently.

**Reimbursement flow + dust treasury.** The charge goes to an immutable **`gasVault`, separate from
`feeRecipient`** (the receipt needs the revenue/reimbursement split; mixing them makes D3 unauditable) and
**external to the executor**, preserving the invariant that the executor holds no user funds between
transactions. The vault accrues arbitrary `tokenIn` dust while the keeper's real cost is native ETH, so a
**periodic treasury sweep** (sell to ETH, top up the KMS hot wallet) is an **ops runbook step, not on-chain
automation** — an in-transaction auto-swap would add gas, MEV and audit surface to the hot path. Sweep above a
per-token USD threshold, write off below (§7). The keeper always **fronts** gas, so a float must be sized and
monitored (§7).

**The punchline — why D4 must land before v4.** With a 500 bps all-in cap and a 20 bps fee, a chunk is
fillable only if `gas ≤ chunk × 4.8%`:

| gas per fill | minimum viable DCA chunk (zero slippage headroom) | with 100 bps headroom |
|---|---|---|
| $4.00 (observed today, aggregator calldata) | **~$83** | ~$105 |
| $0.30 (target, compact route) | ~$6.25 | ~$7.9 |

`DCA_MIN_CHUNK_USD_DEFAULT = 5` is **already below the viable floor even at the target gas**. So: compact
routes + net-cost routing are a hard prerequisite (D4), and the minimum chunk must rise — raising the chunk
floor is preferred to raising the cap, because the cap is the user's protection.

## 2. Fee-constant structure — recommendation: per-orderType compile-time constants, **no setter**

`FEE_BPS = 10` is `constant` today (`:131`). v4 replaces it with `_feeBpsFor(orderType)` — a pure internal
selector over `FEE_BPS_DCA / FEE_BPS_LIMIT / FEE_BPS_STOP_LOSS`, all `20` at deploy, **no setter, no
timelocked action**.

**Rejected: timelock-configurable fees.** A DCA order signs once and executes for up to 90 days. A
configurable fee — *even behind a 48h timelock* — lets the economics of an already-signed order change
without the user's consent; the timelock bounds the *speed*, not the *fact*. A constant means what you
signed is what you pay, forever: D3's transparency invariant expressed in bytecode, following the existing
precedent that `MAX_ORDER_SLIPPAGE_BPS` is already a no-setter constant for exactly this reason (ADR-013
§1/N3). It also adds zero admin surface, zero new key-compromise vector, zero new audit surface.

**Accepted cost:** retuning fees requires a new deploy. Under D1 that is aligned rather than burdensome, and
under D3 a deploy + migration is the most public, most owned mechanism available — **the friction is the
feature**. The per-type structure lets a future deploy retune each type independently. `feeRecipient` stays
immutable. **The 20 bps number itself must be validated by the calibration report before v4 deploys** (§7).

## 3. v3 → v4 migration and the day-one cut

v4 is a **new immutable address** (the executor is not upgradeable), new EIP-712 domain version `"4"`. The
keeper becomes **triple-executor** (v2 draining, v3 draining, v4 live) — the cost ADR-014 flagged;
`executor-routing.js` discriminates v4 by the presence of `maxExecCostBps`, as it already discriminates v3
by `maxSlippageBps`.

- **Drain rule:** v3 keeps executing every order already signed against it until filled, cancelled or expired
  (`MAX_EXPIRY_DAYS = 90` ⇒ worst case ~90 days of triple operation). New orders sign against v4 the moment
  the frontend env is set. **Rollback = unset the frontend env only**; the keeper's v4 config is never unset
  while a v4 order can exist (the `V3-EXECUTOR-DEPLOY.md` §6 invariant, restated).
- **Day one:** **DCA on v4** — the lead slice, plus the fee and gas changes. Limit/TP stay on v3 option (a)
  per ADR-014 and migrate opportunistically; they are not a v4 gate.
- **How SL rides without delaying DCA (D6):** the ADR-014 option (b) capability — ZeroHash `routerDataHash`
  permitted for non-DCA **only when both legs carry registered feeds**, with a tighter bound on that path —
  ships **in the v4 bytecode from day one but gated OFF at the frontend**. If SL is not product-ready, v4
  deploys anyway and SL is enabled later by a flag. **No second deploy, no schedule coupling.**
- **Sequence:** D4 keeper work (compact routes + net-cost routing) → §7 calibration → v4 implement + Auditor
  0C/0H → deploy + 48h oracle/router timelocks → DCA public (flag on).

## 4. Invariants preserved (must be re-proved by the Auditor, not assumed)

1. **`recipient == order.owner`** (R1). Output goes only to the owner; the gas charge is taken from
   **input**, never from delivered output.
2. **Oracle floor remains binding** — `max(scaledMin, oracleFloor)`, now priced on the **gross** amount:
   strictly stronger than v3.
3. **Router whitelist and executor whitelist**, both 48h-timelocked, unchanged.
4. **Exact approvals** — `forceApprove(router, netAmount)` → call → `forceApprove(router, 0)` (`:563`,
   `:575`). Unchanged; `netAmount` is merely smaller.
5. **The executor holds no user funds between transactions** — gas charges leave to an external vault; they
   are never accumulated in-contract.
6. **`nonReentrant` + CEI ordering** (nonce consumed / DCA counters updated before delivery) unchanged.
7. **The all-in cap stays a no-setter immutable constant.** Its *value* must be re-examined: 500 bps was
   generous for pure slippage and may bind once fee + gas are inside the budget (§1 table).
8. **Nothing keeper-self-reported** — every gas input is a constant, a consensus value, an observable
   calldata length, or a system predeploy read. Predeploy addresses (OP-stack `GasPriceOracle`; Arbitrum
   `ArbGasInfo`) are **constructor immutables, verified on-chain at deploy time**, never trusted from a doc
   citation (the Sprint-46 "labels lie" rule); `address(0)` ⇒ no L1 component, mirroring how
   `sequencerUptimeFeed` already handles mainnet.
9. **No "free" or "gasless" claim, anywhere, ever** (D3).

## 5. Settlement receipt — a v4-independent increment (D5)

Read-only over the `OrderExecuted` event plus Supabase; ships **now on v3 data**, before v4. Per fill: tx
hash, block, amount in, output delivered, fee charged, gas (v3: *paid by the protocol* — stated honestly; v4:
the charged amount), effective price vs fair value; plus totals and variance against the upfront estimate. v4
must extend `OrderExecuted` with the gas charge — **that event-schema change is part of v4 scope**. The
receipt is what makes D3 enforceable: you cannot claim "free" when every user gets an itemised bill.

## 6. Batching — v4.1 **study only**, explicitly out of v4 core (D1)

- **Feasibility.** The saving is not the intrinsic 21 000 gas; it is paying the **fat router calldata once**
  for the summed amount instead of N times, plus one set of oracle reads. On OP-stack the per-order
  signatures and structs are *not* amortised — the win scales with route-calldata size, not N. Measure it.
- **Fairness.** Routing the summed amount as one swap and splitting output **pro-rata by input share** gives
  every participant the same blended price — better than sequential fills (no ordering advantage), mildly
  favourable to small participants at the large one's expense. The rule must be explicit and disclosed.
- **Failure isolation — the crux.** The floor is *per order* but the swap is *shared*, so a member whose
  floor is unmet after the fact cannot be "refunded a price". Options: all-or-nothing (liveness hit; revoking
  an allowance griefs the whole batch), or **off-chain pre-flight filter + a shared on-chain floor = max over
  members' per-share floors** (safe for every member; the batch simply fails more often). Start from the
  latter; include a DoS analysis of the filter's race window.
- **Interaction with §1:** a batched fill's per-order gas charge falls to roughly `batchGas / N` — the entire
  economic case for batching, measurable against §7's numbers.

## 7. Open questions — for `docs/Reports/FILL-ECONOMICS-CALIBRATION.md`

That report supplies the numbers; this ADR supplies the shape. **v4 must not be implemented before it
lands.**

1. `L2_GAS_UNITS[orderType]` from real fills (p50/p95) + the bias margin that keeps the estimate ≤ actual.
2. `msg.data.length` → actual L1 fee under Fjord FastLZ compression: scalar, systematic error, direction.
3. `PRIORITY_ALLOWANCE_WEI` — the priority fee the keeper actually needs to land on Base; does the
   `tx.gasprice` clamp ever bind in practice?
4. Does **500 bps** remain an adequate all-in ceiling, and what is the true minimum viable chunk? (Interacts
   with `MIN_ORDER_AMOUNT` and `DCA_MIN_CHUNK_USD_DEFAULT = 5`, which §1 shows is already too low.)
5. Compact route vs aggregator route: measured **gas delta and output delta per pair** — validating D4's
   premise that the direct pool wins on the user's net.
6. **Fee validation:** does 20 bps + user-paid gas make DCA net-positive across the observed fill mix, and
   at what chunk size does it break even?
7. Gas-vault sweep threshold per token; keeper ETH float sizing (fills/day × avg gas × settlement lag).
8. Batching: measured saving by batch size, and whether the live order book even has enough same-pair
   concurrency to batch (§6).
9. Competitor **effective**-cost benchmark data (EVM only) and the dating convention, for D5's fees UI.

## Consequences

- **Positive:** DCA stops being structurally loss-making; the user's bound becomes genuinely all-in and
  strictly stronger than v3's; the fee moves inside the signed budget rather than beside it; L1-fee metering
  makes cheap routing self-enforcing; SL rides the same deploy without gating DCA; fees become
  unchangeable-after-signing — D3 in bytecode.
- **Costs / risks:** a third executor during drain (~90 days); a new immutable deploy + full fund-flow audit;
  a gas-vault treasury process that did not exist before; estimate error is real and absorbed by the protocol
  by design; a mis-calibrated `L2_GAS_UNITS` needs a new deploy to fix; either the all-in cap rises or the
  minimum chunk does — product-visible either way.
- **Do NOT** implement or deploy on this ADR alone: it needs Architect adjudication, the §7 calibration
  numbers, and a fund-flow Auditor pass (0C/0H).
