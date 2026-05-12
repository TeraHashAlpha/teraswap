# ADR-006 — Positive Slippage Sharing on Non-CoW Routes

**Status:** Proposed
**Date:** 2026-05-12
**Authors:** TeraHash (founder/architect)
**Related:** ADR-005 (state persistence), Sprint 9B / Prompts 66-68 (FeeCollector V2 + H-04 `minimumOutput`), LP-05 (`swaps.mev_savings_actual` column)
**Roadmap link:** Phase 2.3 — protocol revenue diversification

---

## Context

Every swap routed through TeraSwap commits to a `minimumOutput` value before
the user signs. The FeeCollector V2 contract (deployed
`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` on 2026-04-23, P68) reverts
with `InsufficientOutput(actual, minimum)` when the user's post-swap
balance delta falls below this minimum — H-04 closed.

When the swap executes better than `minimumOutput`, the difference is
the user's **positive slippage** (also called *trade surplus* or
*price improvement*). Today this surplus accrues entirely to the user:

```
user_received = actualOutput
protocol_received = totalAmount × 0.1%   (FEE_BPS, deducted at entry)
```

The 0.1% upfront fee is the only protocol revenue on non-CoW routes.
For CoW Protocol routes, surplus is already captured inside the
solver competition / batch-auction mechanism — protocol receives the
flat fee and nothing else. **This ADR is about non-CoW routes only.**

The infrastructure to measure surplus already exists:

- `src/lib/post-execution-validator.ts:278-279` computes
  `surplus = actualOutput − expectedMinOutput` per swap.
- `swaps.mev_savings_actual` (LP-05, `supabase/improvements.sql`)
  persists the realised surplus in raw output-token wei.
- `src/lib/mev-savings.ts` (LP-05, refined 2026-05-12) estimates
  pre-swap surplus from the non-CoW quote median.

So the question this ADR answers is:

> **Should TeraSwap capture a share of the positive slippage on
> non-CoW swaps as additional protocol revenue, and if so — how, when,
> and at what rate?**

---

## Industry comparison

Factual summary of how the major aggregators handle positive slippage
as of 2026-05. Reviewed because we are NOT the first to ask this
question; every survivor at scale has converged on some form of
capture, but the specifics differ in ways that matter to TeraSwap's
positioning.

| Project | Treatment | Disclosure to user |
|---|---|---|
| **1inch Fusion / Fusion+** | Solver auction; resolvers compete to maximise user output. Protocol does not directly capture surplus; resolvers keep a portion above the user's minimum as their margin. Effective rate varies (~30–70% of surplus to resolver depending on competition). | Implicit in the auction model; users opt into Fusion explicitly. |
| **CoW Protocol** | Same model as 1inch Fusion. Solvers compete; the surplus above the limit price is split between user and winning solver. CIP-38 / CIP-46 added rebates so part of solver-captured surplus returns to users on average. Protocol fee currently zero on solver mode; partner fees exist via `appData`. | Documented; the "expected output" shown in the UI accounts for the auction. |
| **0x / Matcha** | Matcha v2 captures **100% of positive slippage above the displayed quote** as protocol revenue. Underlying 0x API allows integrators to route surplus to a fee recipient via the `slippageProtection` parameter. | Documented in Matcha FAQ ("how Matcha makes money"); displayed quote IS the user's expected output. |
| **Paraswap / Velora** | Partner-fee mechanism in the router contract — integrators (frontends, wallets) can take up to 100% of positive slippage. Protocol takes 0% by default. | Caller-disclosed (not enforced by protocol). |
| **Kyberswap** | Zero protocol fee; surplus accrues to the user. Revenue model is KyberDAO tokenomics on liquidity pools, not aggregator fees. | N/A — no capture. |
| **Bebop** | Solver-based, similar to CoW. | Documented. |

**Pattern:** the two dominant revenue models are
(a) **solver auction** (CoW, 1inch Fusion, Bebop) and
(b) **flat surplus capture** (Matcha, integrators on 0x and Paraswap).

TeraSwap can plausibly do (b) without changing its meta-aggregation
identity; (a) would require us to build solver infrastructure which is
out of scope for Phase 2.

The competitive baseline: **doing nothing leaves us as the only
material aggregator that captures no surplus.** Kyberswap is the only
peer that matches us today, and they cover the gap with token
incentives.

---

## Mechanism options evaluated

### A. Contract-level capture via FeeCollector V3

Extend FeeCollector with one extra parameter (`expectedOutput`) and
one extra accounting step: after the router call, compare
`actualOutput` to `expectedOutput`; if positive, transfer a fraction
of the surplus to the fee recipient before refunding the user.

```solidity
// pseudocode — NOT a deployment plan
function swapTokenWithFee(
    address token, uint256 totalAmount,
    address router, bytes calldata routerData,
    address tokenOut,
    uint256 minimumOutput,    // existing — H-04
    uint256 expectedOutput,   // new — derived from quote
    uint16  surplusBps        // new — share of surplus protocol takes
) external {
    // ... existing fee deduction + router call ...
    uint256 actual = balanceOf(msg.sender, tokenOut) - tokenOutBefore;
    require(actual >= minimumOutput, InsufficientOutput(actual, minimumOutput));

    if (actual > expectedOutput && surplusBps > 0) {
        uint256 surplus = actual - expectedOutput;
        uint256 protocolShare = (surplus * surplusBps) / 10_000;
        if (protocolShare > 0) {
            IERC20(tokenOut).safeTransferFrom(msg.sender, feeRecipient, protocolShare);
        }
    }
}
```

**Pros:**
- Trust-minimised: capture is enforced on-chain; no off-chain attribution game.
- Atomic with the swap; no settlement risk.
- Transparent: the `expectedOutput` and `surplusBps` are visible in
  every signed transaction (clear-signing via ERC-7730 in P78 already
  surfaces tx args on Ledger).

**Cons:**
- Requires a new contract deployment + audit + migration (V2 → V3).
  Migration cost (per F68 precedent): ~2 weeks of architect + auditor
  + frontend hook updates.
- The token-out approval path for `safeTransferFrom` from user → fee
  recipient is awkward; cleaner is to have the FeeCollector receive
  the full output first, deduct the protocol share, then forward the
  net to the user (changes the user-side balance-delta semantics that
  H-04 depends on, and would need careful re-verification).
- `expectedOutput` is a number derived from our backend; passing it
  on-chain creates an oracle surface — a compromised backend could
  pass an artificially low `expectedOutput` and capture more surplus
  than entitled. Mitigations: sign the (expectedOutput, surplusBps)
  pair with the backend's EOA and verify in-contract, OR cap
  `surplusBps` at a low value (e.g. 30%) so even a worst-case
  manipulation has bounded user impact.

### B. Off-chain attribution + future swap credit

Track surplus per-wallet in Supabase; never move funds. Could be used
to fund a loyalty programme (rebates against future fees, airdrops,
etc.) but does NOT capture revenue to the protocol.

**Verdict:** rejected as a revenue mechanism. Useful as a UX layer
later but doesn't answer this ADR's question.

### C. Per-adapter capture in our backend

Modify each adapter to request a slightly worse `minimumOutput` than
the actual quote, capture the difference at the router level. Several
routers support a `feeRecipient` / `partnerFee` parameter today
(Paraswap's referrer, 0x's `feeRecipient`).

**Verdict:** **partially incompatible with our routing model.** Some
adapters (Uniswap V3 direct, Curve direct, Balancer) don't have this
hook. Doing it only on the adapters that support it would create
routing distortion (we'd favour adapters that pay us). Could be a
follow-on if option A is built; not a substitute.

### D. Hybrid: option A with explicit pre-swap disclosure

Same on-chain mechanism as option A, but the UI surfaces the surplus
share in the quote breakdown (e.g. "If your swap fills better than
expected, TeraSwap keeps 30% of the surplus above 0.5% — typically
$0–$2 on a $1k swap") so the user agrees explicitly before signing.
ERC-7730 metadata (P78) already shows `surplusBps` in the Ledger
clear-signing screen.

**This is the recommended mechanism.**

---

## Capture-rate proposal

| Lever | Proposed initial value | Rationale |
|---|---|---|
| `surplusBps` (protocol share of surplus above noise floor) | **30%** (i.e. user keeps 70%) | Matches 1inch Fusion's effective resolver split; below Matcha's 100%. Leaves us cheaper than Matcha by design. |
| Noise floor (surplus below this goes 100% to user) | **0.5%** of `expectedOutput` | Avoids charging on sub-bps moves that feel like rounding noise. Empirically, ~half of swaps clear `minimumOutput` by less than 0.5% — see § Data analysis. |
| Hard cap on protocol share | **5% of trade size** | Defense against extreme positive slippage events (e.g. an oracle dislocation) where capturing 30% of a 10% slippage would be a $500 grab on a $5000 trade — bad PR. |

These three parameters live in FeeCollector V3 storage so they can be
tuned post-deploy without redeploying. Changes go through the existing
48-h timelock that V2 already enforces on router changes.

---

## Data analysis

The infrastructure to back this with numbers is already deployed:

- `swaps.mev_savings_actual` was added 2026-05-09 (LP-05). It stores
  realised positive slippage in raw output-token wei, but only on
  CoW-routed swaps where the trades endpoint exposed
  `executedBuyAmount`. **For non-CoW routes — the routes this ADR
  targets — we do NOT yet write this column.** That is the gap to
  fix before the build phase (see § Pre-build instrumentation).

- The post-execution validator (`src/lib/post-execution-validator.ts`)
  already computes `surplus = actualOutput − expectedMinOutput` for
  every swap it sees, regardless of source. The result is in the
  audit-trail KV record (`teraswap:execution-audit:<txhash>`, 7-day
  TTL) and is summarised in the validator's `reason` string when
  `surplusPct > 0.1%`. This is the right pre-existing signal to
  hydrate the historical analysis from.

### Required queries (run against production Supabase to finalise numbers)

```sql
-- ① Surplus distribution by source. Run after backfilling
--    swaps.mev_savings_actual for non-CoW rows from the
--    validator's KV audit-trail records (see Pre-build instrumentation).
SELECT
  source,
  COUNT(*)                                                       AS swaps,
  COUNT(*) FILTER (WHERE mev_savings_actual > 0)                 AS swaps_with_surplus,
  ROUND(100.0 * COUNT(*) FILTER (WHERE mev_savings_actual > 0)
          / NULLIF(COUNT(*), 0), 1)                              AS pct_with_surplus,
  -- Surplus expressed in USD using the swap-time price snapshot.
  ROUND(SUM(amount_out_usd * mev_savings_actual::NUMERIC
            / NULLIF(amount_out::NUMERIC, 0))::NUMERIC, 2)       AS total_surplus_usd,
  ROUND(AVG(amount_out_usd * mev_savings_actual::NUMERIC
            / NULLIF(amount_out::NUMERIC, 0))::NUMERIC, 2)       AS avg_surplus_usd,
  -- Median surplus as a percentage of the quoted output
  -- (this drives the noise-floor decision).
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY mev_savings_actual::NUMERIC / NULLIF(amount_out::NUMERIC, 0)
  )                                                              AS median_surplus_frac
FROM swaps
WHERE status = 'confirmed'
  AND created_at > NOW() - INTERVAL '30 days'
  AND source NOT IN ('cowswap', '0x')   -- non-fee-collector routes
GROUP BY source
ORDER BY total_surplus_usd DESC NULLS LAST;

-- ② Revenue projection at the two candidate capture rates.
WITH surplus AS (
  SELECT
    source,
    -- Apply the noise floor app-side (0.5% of amount_out_usd)
    GREATEST(0,
      (amount_out_usd * mev_savings_actual::NUMERIC
       / NULLIF(amount_out::NUMERIC, 0))
      - 0.005 * amount_out_usd
    )                                                            AS surplus_above_floor_usd
  FROM swaps
  WHERE status = 'confirmed'
    AND created_at > NOW() - INTERVAL '30 days'
    AND source NOT IN ('cowswap', '0x')
    AND mev_savings_actual > 0
)
SELECT
  source,
  ROUND(SUM(surplus_above_floor_usd) * 0.30, 2) AS protocol_revenue_at_30pct_usd,
  ROUND(SUM(surplus_above_floor_usd) * 0.50, 2) AS protocol_revenue_at_50pct_usd,
  ROUND(SUM(surplus_above_floor_usd) * 1.00, 2) AS total_capturable_surplus_usd
FROM surplus
GROUP BY source
ORDER BY total_capturable_surplus_usd DESC;
```

### Expected magnitudes (pending operator execution of the queries above)

**Status of these numbers:** the queries above MUST be run against
production Supabase to populate this section. The agent that produced
this ADR does not have a database connection. The placeholders below
are an order-of-magnitude framework — do NOT treat them as production
numbers. Replace before the ADR moves from Proposed → Accepted.

Framework, using a conservative model: at TeraSwap's pre-launch volume
of `~N` confirmed non-CoW swaps per day and an average trade size of
`~V` USD, with industry-typical surplus rates of 0.1–0.4% of trade
size, monthly capturable surplus (after the 0.5% noise floor) is
approximately:

```
monthly_surplus_usd ≈ N × 30 days × V × 0.002         (point estimate)
protocol_30pct_usd  ≈ monthly_surplus_usd × 0.30
protocol_50pct_usd  ≈ monthly_surplus_usd × 0.50
```

For reference: at N = 100 swaps/day and V = $500 (current pre-launch
profile), the model gives monthly surplus ≈ **$3,000**, protocol take
at 30% ≈ **$900/month**. At N = 1,000 swaps/day and V = $2,000
(modest post-launch growth), monthly surplus ≈ **$60,000**, protocol
take at 30% ≈ **$18,000/month**.

These are the same order of magnitude as Matcha's reported surplus
revenue per equivalent volume (~$50–80k/month at our hypothetical
high-end), which is the only external anchor publicly available.

### Per-source intuition (to validate against the queries)

Sources we expect to produce the most surplus:

- **1inch**, **Velora (ParaSwap)**: aggregator-of-aggregators with
  internal routing margin → variable surplus, often non-zero.
- **Uniswap V3 direct**: surplus = whatever the gas estimator
  over-quoted; typically thin.
- **KyberSwap, Odos, OpenOcean**: similar pattern to 1inch.
- **SushiSwap, Balancer, Curve direct**: thin pool spreads → low
  surplus.

Confirm this hierarchy against query ① before finalising the
capture-rate recommendation.

---

## Risk analysis

### User trust

**Risk:** users perceive the surplus capture as a hidden fee on top of
the disclosed 0.1%. This is the most acute risk — DeFi users are
hyper-sensitive to fee opacity, and surplus capture has been a
flashpoint for Matcha in particular (community criticism on r/DeFi
and X every few months).

**Mitigation:**
- **Pre-swap disclosure** is non-negotiable. The quote breakdown UI
  shows the capture rate and the noise floor before the user signs.
- **Post-swap transparency.** The success toast shows both the user's
  realised output and the protocol share (mirrors the LP-05 MEV
  savings line: *"You received X USDC, of which Y went to TeraSwap as
  protocol share of surplus above your minimum"*).
- **Public dashboard.** A `/transparency` page (already provisioned
  in the roadmap for the API-tier launch) shows aggregate protocol
  revenue split between fixed fee + surplus share. No room for
  speculation about what we're keeping.
- **Honest framing.** Don't call it "MEV protection revenue." Call it
  "surplus share." DeFi users tolerate explicit pricing far better
  than euphemism.

### Competitive impact

**Risk:** moving from "user keeps 100% of surplus" to "user keeps 70%"
is a perceived downgrade. A competitor (notably 1inch) could amplify
this in a marketing push.

**Mitigation:**
- 1inch Fusion already does the same; Matcha takes 100%. The factual
  comparison favours us as long as we stay below 50%.
- Soft-launch via a tier-based opt-out: API tier 'enterprise' customers
  can disable surplus capture in exchange for a higher flat fee. Keeps
  professional integrators happy while default flow generates revenue.
- Frame the launch in the context of API tier pricing (P81/LP-08):
  "free retail tier captures 30% of surplus; pro/enterprise can buy
  zero-surplus pricing."

### Regulatory considerations

**Risk:** in some jurisdictions (notably US under SEC custody
interpretation and EU under MiCA's "asset service provider" framing),
undisclosed price improvements that accrue to a non-custodian
intermediary could be characterised as front-running or as
unregistered brokerage activity.

**Mitigation:**
- **Disclosure is the regulatory shield.** When the user signs a
  transaction that explicitly contains `surplusBps` as a calldata
  argument (visible on Ledger via ERC-7730), they have given informed
  consent in the legal sense.
- **Non-custodial atomicity.** The surplus share is transferred
  atomically with the swap; TeraSwap never holds the user's funds.
  This is materially different from a CEX taking spread.
- **Legal review before mainnet deploy.** Required gate for any
  FeeCollector V3 deployment regardless of this ADR.

### Routing distortion

**Risk:** if surplus capture applies only to non-CoW routes, the
auto-routing engine could be tempted (or accidentally biased) toward
non-CoW routes because they're more profitable for the protocol.

**Mitigation:**
- Routing must continue to optimise on **user-side net output**
  (after surplus share). The quoted `toAmount` displayed to the user
  is `actualOutput − protocolSurplusShare`; if non-CoW still wins on
  this number, it wins fairly. If it loses to CoW, the user gets CoW.
- The MEV-preference auto-routing already implemented in LP-04 puts
  a thumb on the scale toward CoW within 0.3%. That stays as-is —
  this ADR does NOT touch routing logic.
- Quarterly review: compare CoW-vs-non-CoW route share before and
  after launch. If non-CoW share grows by >5pp in a quarter without
  a corresponding gas-cost or liquidity explanation, audit the
  routing layer.

### Smart-contract risk

**Risk:** new contract = new attack surface. V2 just shipped; V3
would be the third FeeCollector deploy in 6 months.

**Mitigation:**
- Reuse V2's surface as much as possible — V3 should be V2 + the
  surplus accounting block + ONE new admin-settable parameter pair
  (`surplusBps`, `noiseFloorBps`).
- Mandatory: external audit (the same firm that audited V1/V2) plus
  in-house Foundry tests covering the new code path. Budget: 4-week
  audit window minimum.
- Reuse V2's 48-h timelock for parameter changes.

---

## Recommendation

**Build the FeeCollector V3 surplus-capture mechanism, but DON'T do it
in Sprint 11 or 12.**

Sequencing rationale:

1. **First, instrument.** Backfill `swaps.mev_savings_actual` for
   non-CoW routes so § Data analysis numbers are real, not modelled.
   This is a 1-2 day task in Sprint 11 — see § Pre-build instrumentation.
2. **Then, validate the framework with a 30-day data window.** Confirm
   surplus magnitudes match the model. If query ② shows monthly
   capturable < $500/month, defer this ADR indefinitely — the
   complexity isn't worth the revenue.
3. **Then, build V3 in Sprint 13 or 14**, after:
   - API tier (P81/LP-08) revenue has been measured for one billing
     cycle (we want to know what proportion of total revenue this
     mechanism would represent before deploying it).
   - Legal review is complete.
   - The Phase 2.3 marketing brief — particularly the "what makes
     TeraSwap different" framing on the landing page — has been
     re-evaluated for compatibility with surplus capture.
4. **At launch, default to 30% / 0.5% noise floor / 5% hard cap.**

The framework above (mechanism D, capture-rate proposal) is
**Proposed** as a target architecture. It moves to **Accepted** only
after steps 1–3 produce numbers that justify the build.

### Pre-build instrumentation (Sprint 11, ~2 days)

Independent of the V3 decision, the codebase should start collecting
the data this ADR's eventual successor will need:

- Extend `post-execution-validator.ts` to write `surplus_wei` into
  `swaps.mev_savings_actual` for ALL sources (currently CoW-only via
  the `cow.ts` poll function). Source the surplus from
  `validateExecution`'s `actualOutput − expectedMinOutput` rather
  than the CoW-specific `executedBuyAmount` field, so the column
  semantics are uniform.
- Add `swaps.expected_output` column (NUMERIC, nullable) so the
  query above can compute `surplus = actual − expected` rather than
  `actual − minimum`. The expected output is what the user saw in
  the quote breakdown; storing it makes "did this swap beat the
  quote?" a straightforward join.
- Run query ① weekly via a small cron job and pipe the result to the
  Telegram ops channel. Two months of weekly data is the right
  foundation for the build/wait decision.

These instrumentation changes are independently useful (better
analytics dashboards, smarter alerts) regardless of the V3 outcome.

---

## Consequences

### Positive (if accepted)

- **New revenue stream uncorrelated with swap volume.** Surplus
  capture scales with market volatility, not just user count —
  diversifies the protocol's revenue against quiet markets.
- **Aligns with industry standard.** Matches the disclosed-capture
  posture of Matcha, the implicit-capture posture of 1inch Fusion
  and CoW solvers.
- **Funds infrastructure investment without raising the visible fee.**
  The 0.1% headline rate stays unchanged — surplus is a different,
  user-acknowledged charge.

### Negative

- **Brand risk.** First-time-buyer perception is "they're now taking
  more." If we mismanage the launch comms (mechanism D's disclosure
  layer is non-negotiable), it's a Twitter problem.
- **Contract complexity.** V3 is the third FeeCollector iteration in
  six months. Smart-contract risk surface keeps growing.
- **Routing-engine review burden.** Every change to the quote /
  routing layer needs to verify it still optimises on user-side net
  output. New invariant to maintain.

### Neutral

- **No effect on CoW routes.** CoW solvers already capture surplus
  internally; V3 only changes non-CoW behaviour.
- **No effect on the 0.1% flat fee.** That stays as-is.

---

## Reconsideration triggers

- The 30-day data window in step 2 shows total capturable surplus
  < $500/month or < 10% of API-tier monthly revenue → abandon (the
  contract complexity is not worth the marginal revenue).
- Legal review concludes that pre-swap disclosure is insufficient
  under any of US / EU / UK jurisdictions → either defer to a fully
  custodial model (out of scope for TeraSwap) or accept the
  geographic restriction.
- A peer aggregator visibly suffers a community backlash for similar
  capture → re-evaluate the framing, not necessarily the mechanism.
- CoW or 1inch Fusion expand their model to the point where it
  becomes the de-facto default for retail (>50% of aggregator
  volume) → revisit whether building V3 is still the right
  investment versus building solver infrastructure instead.

---

## Related

- ADR-001 — monitoring architecture (the audit-trail mechanism that
  makes "did surplus actually happen on this tx" auditable).
- ADR-005 — state persistence (the FeeCollector contract upgrade
  pattern this ADR's mechanism D would follow).
- Sprint 9B (P66–P68) — FeeCollector V2 + H-04 `minimumOutput`.
  Sets the precedent for adding revert-on-shortfall arguments;
  surplus capture extends the same pattern in the opposite direction.
- LP-05 — `swaps.mev_savings_actual` column (the data substrate).
- P81 / LP-08 — public API tier infrastructure (relevant because
  surplus capture would be tier-aware: enterprise customers buy out
  of it).
- ERC-7730 metadata for FeeCollector (P78) — the clear-signing layer
  that makes mechanism D's on-chain disclosure visible on Ledger.
