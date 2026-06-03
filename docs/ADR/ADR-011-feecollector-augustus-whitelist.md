# ADR-011 — Whitelist ParaSwap/Velora Augustus V6 router on mainnet FeeCollector V2

- **Status:** Proposed (→ Accepted on Auditor sign-off, → executed after 48h timelock)
- **Date:** 2026-06-03
- **Related:** SPRINT-9O (root cause + Part B fallback), SPRINT-9H (Augustus V6.2 selectors, audited),
  INC-2026-06-03-001 (wallet/connectivity arc), `docs/security/AUDIT-TOTAL.md` (router whitelist control)

## Context
SPRINT-9O decoded, on-chain, why every **Velora (ParaSwap V6) fee-routed swap on mainnet** reverts:
the Augustus V6 router **`0x6A000F20005980200259B80c5102003040001068`** is **NOT** in the router
whitelist of mainnet FeeCollector V2 (`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`).
- `USER → FeeCollector.swapETHWithFee(Augustus, …)` → `RouterNotWhitelisted()`
- `FeeCollector → Augustus` (direct, same calldata) → SUCCESS; `EOA → Augustus` → SUCCESS
- Direct whitelist read: Augustus V6 = `false`; uniswap/kyber/odos/1inch/curve/sushi = `true`
ParaSwap V6.2 funnels every route through this single Augustus entry point, so ALL mainnet Velora fee
swaps fail — "Ekubo" was merely the best route at test time. Velora works on **Base** because the Base
FeeCollector already whitelists Augustus.

## Decision
Whitelist Augustus V6 (`0x6A00…1068`) on mainnet FeeCollector V2 via the contract's **timelocked
governance**: `queueRouterChange(router, true)` → wait 48h → `executeRouterChange(actionId, router,
true)`. This is a **contract STATE change, not a redeploy**. No function selector is added (Augustus
`swapExactAmountIn 0xe3ead59e` and the 9H Curve methods are already allowlisted), so the 9H
recipient-decoder/output-redirect concern does not apply here.

## Address verification (it is the known, audited Velora router)
`0x6A000F20005980200259B80c5102003040001068` is confirmed as the legitimate ParaSwap/Velora Augustus
V6 across: `src/lib/chains/routers.ts` (`velora`), `src/lib/api.ts` (router list), the SPRINT-9H
selector audit (`0x6a00…1068`, identical on Ethereum + Base), the Base FeeCollector whitelist (Velora
works there), and the SPRINT-9O live on-chain decode (`FeeCollector → Augustus` direct succeeds).

## Security rationale
- The whitelist is the **default-deny** control added after the original AUDIT-TOTAL finding ("swap*
  WithFee accepted any router"). Adding a known, audited router is the intended use of the control,
  not a weakening of it.
- The ParaSwap Augustus V6 access-control incident (Mar 2024, $5.7M) is noted in AUDIT-TOTAL; TeraSwap
  is "Protected — no generic transferFrom" path through the FeeCollector.
- The **48h timelock is the safety buffer**; the change is observable and cancellable during it.
- No open AUDIT-TOTAL finding opposes whitelisting Augustus. A **light Auditor sign-off** is still
  required because this is a fund-flow contract state change (CLAUDE.md rule #2/#3).

## Consequences
- Mainnet Velora fee-routed swaps execute (FeeCollector 0.1% applies, as for other whitelisted
  routers). SPRINT-9O Part B (auto-fallback off a reverting best route) stays as defense-in-depth.
- **Rollback:** `queueRouterChange(Augustus, false)` → `executeRouterChange(...)`.

## Execution (owner, admin key)
1. `queueRouterChange(0x6A000F20005980200259B80c5102003040001068, true)` — capture the `actionId`
   (emitted by the queue event / derived per the contract) and the queue timestamp.
2. Wait ≥ 48h.
3. `executeRouterChange(actionId, 0x6A000F20005980200259B80c5102003040001068, true)`.
4. Verify the whitelist read flips to `true`, then confirm a real mainnet Velora swap settles.
The exact, ABI-verified `cast`/Foundry commands (incl. the `actionId` derivation + a dry-run) are to
be produced/verified by the Code Agent against the deployed contract — NOT hand-written — before the
owner broadcasts.

## Cross-check (flagged)
Repo `.env.production` shows `NEXT_PUBLIC_FEE_COLLECTOR=0x4dAEAf…58eD` (V1, frozen) while the live app
routes to V2 `0x47f240…7459` (per the 9O decode). Confirm the Vercel **Production** env points at V2,
not V1 — likely already correct (the live sim used V2), but worth verifying.
