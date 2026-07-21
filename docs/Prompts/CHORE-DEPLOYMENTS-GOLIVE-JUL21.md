# CHORE-DEPLOYMENTS-GOLIVE-JUL21

## Context

OrderExecutorV3 (Base) cutover is complete (2026-07-21). TeraSwapFeeCollector deployed to Arbitrum One on
2026-07-20 and flipped to production. Documentation update required to reflect both deployments as live.

## Objective

Document the go-live status of OE_V3 (Base) and FC (Arbitrum) in the canonical deployments record + runbook
lessons from both deployments.

## Updates

### docs/DEPLOYMENTS.md

1. **OrderExecutorV3 (Base) row:** status cutover-pending → **LIVE** (2026-07-21). Include:
   - Oracle feeds (WETH/USDC/DAI) executed via timelock
   - Keeper dual-routing v2+v3
   - First production oracle-floor fill 2026-07-21 (full tx hash verified on-chain)
   - Carve-out: mass-cancel for DCA is DB-level only until `fix/mass-cancel-dca-onchain` merges

2. **NEW Arbitrum FeeCollector row:** deployed+verified+bootstrapped (9 routers), prod flip 2026-07-20
   - Same-address gotcha expanded: this address also mainnet OrderExecutor v2 + Base FeeCollector
   - Fee verified on-chain via Arbiscan

3. **Same-address gotcha note:** updated to include Arbitrum (three chains, three roles)

### Runbooks

**V3-EXECUTOR-DEPLOY.md** + **ARBITRUM-FEECOLLECTOR-DEPLOY.md** (both appended):

Production smoke runs ONLY on real domain (teraswap.app) — *.vercel.app origins fail Alchemy allowlist,
oracle gate fail-closes with `'Chainlink oracle data outdated (0h old)'`.

## Exit criteria

- Branch pushed
- Compare link reported
- All on-chain addresses/hashes verified programmatically (cast/RPC) — no hand-typed hex

## Files

- docs/DEPLOYMENTS.md
- docs/Runbooks/V3-EXECUTOR-DEPLOY.md
- docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md
- docs/Prompts/CHORE-DEPLOYMENTS-GOLIVE-JUL21.md
