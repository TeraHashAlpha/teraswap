# ADR-014-NONDCA-V3-DESIGN — execution model for Limit/SL·TP on OrderExecutorV3 (P1b/P1c design gate)

> **Source:** owner greenlight 2026-07-21 to start P1b (Limit on v3). Architect pre-flight found an OPEN
> DESIGN QUESTION that blocks implementation: v3 `executeOrder` REQUIRES a real signed `routerDataHash`
> for non-DCA (`RouterDataRequired` on ZeroHash — the deliberate fix for v2's structurally-unexecutable
> non-DCA path), but a Limit/SL·TP route is only knowable AT TRIGGER, not at signing. A route pinned at
> signing goes stale (likely router revert / worse path); ZeroHash reverts by design; re-signing at
> trigger kills autonomy. **Deliverable = ADR-014 (Proposed) with options + recommendation; NO code.**
> Model Opus (design, fund-flow semantics). Read-only + one new ADR file; Architect adjudicates before any
> implementation sprint.

## Requirements
1. **Ground the constraint:** read TeraSwapOrderExecutorV3.sol (§2b routerDataHash block, nonce branch,
   oracle floor path §1, MAX_ORDER_SLIPPAGE_BPS, _checkPriceCondition), PR #296/#299/#301 FEEDBACK, ADR-013,
   the threat model P1 finding. State precisely what the deployed bytecode allows/forbids for non-DCA.
2. **Enumerate options with security + ops analysis** (at least):
   a. **Route-pin at signing** (works with deployed bytecode): frontend obtains routerData at creation,
      user signs its hash; keeper must execute with EXACTLY that calldata. Analyze staleness (quote expiry
      inside Augustus calldata, revert probability vs time-to-trigger, partial-fill impossibility), when it
      is viable (short-expiry limit orders?) and UX honesty requirements.
   b. **Contract vNext: oracle-floor path for non-DCA** — allow ZeroHash for Limit/SL·TP WHEN a price feed
      is registered, making the ADR-013 §1 floor + condition check the binding constraint (mirror of the
      DCA rationale). Requires new deployment + audits + migration; analyze whether the DCA-bypass
      justification transfers cleanly to non-DCA (it nearly does: recipient==owner, whitelisted router,
      floor at execution price), what NEW risk surface opens (keeper route freedom on triggered orders),
      and the deploy/migration cost (timelock, dual-executor drain, runbook).
   c. **Trigger-time keeper-built route + user pre-authorization via bounded delegation** (e.g. signed
      constraints: max slippage vs oracle at trigger, router set, expiry) — is this expressible WITHOUT
      contract changes? If not, fold into (b)'s vNext scope.
   d. Any additional credible option (e.g. hybrid: pin-at-signing with auto-refresh via cancel+re-sign UX;
      CoW-style off-chain auction) — include only if defensible.
3. **Score options** (security, autonomy/UX, time-to-ship, deploy cost, audit surface, keeper complexity) +
   RICE; give ONE recommendation and the implied sprint cut (P1b scope, P1c scope, contract-change y/n).
4. **Write `docs/ADR/ADR-014-nondca-execution-model.md` (status: Proposed)** per repo ADR conventions;
   ≤2 pages; cite contract lines. No other files.

## Do NOT
Write/change any code, contract, or runbook; touch v3/Arbitrum live config; open a PR (branch
`adr/014-nondca-design` pushed + compare link; owner opens).

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the options table (one line each: option → binding
constraint → main risk → ship cost) + the recommendation. Architect adjudicates; implementation specs
(P1b/P1c) follow the accepted ADR.
