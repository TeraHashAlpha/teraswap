# Launch readiness — Limit / DCA / SL·TP on L2 (Base)

**Status:** DEFERRED by owner decision (2026-06-11). Tabs stay "Soon". Do NOT flip live until every
item below is done, tested, and audited. Owner: "prefer to delay the launch than ship and have errors."
This is a single deliberate launch push, not piecemeal.

## Decision context
- L2-ONLY: conditional orders ship on **Base first**, NOT mainnet (mainnet gas makes small autonomous
  orders unviable — see memory `l2_only_decision`). Mainnet order-engine contract exists (Phase 1) but
  the feature will be gated to L2.
- These are AUTONOMOUS, on-chain, fund-moving orders executed without the browser open → the bar is
  higher than for swaps. A half-ready launch invites an incident.

## Readiness checklist
### Contracts / infra
- [ ] Deploy **TeraSwapOrderExecutor** on **Base** (audited build; verified on BaseScan).
- [ ] FeeCollector / router whitelist + selector allowlist correct for the Base executor path.
- [ ] Self-hosted **executor** running for Base (monitors + executes Base orders; gas cap, stale-lock
      recovery, prioritization — per the mainnet executor).
- [ ] Supabase order tables / RLS / realtime cover Base (chainId-tagged).
- [ ] test-contracts CI (now a real gate) covers the Base executor + FeeCollector suites.

### Frontend / activation
- [ ] Activate DCA/Limit/SL·TP tabs **gated to Base only** (chain-aware; "Soon"/unsupported on mainnet).
- [ ] Order CREATE EIP-712 review (9U ✅) works on Base (chain-agnostic).
- [ ] Order CANCEL / INVALIDATE EIP-712 review (CHORE-CANCEL-REVIEW — pending; build chain-agnostic).
- [ ] Order management UI: view active orders, cancel, edit, execution/fill history (Phase 1.5 items).
- [ ] All order signatures use the active chain (no mainnet pinning), reuse 9R/9U review + chain/account
      invalidation.

### Engine correctness / edge cases
- [ ] DCA dust (SC-02 known tech debt), nonce handling, expiry/validTo, partial fills, trigger
      validation, oracle staleness on the Base feeds (9V per-feed) for trigger prices.
- [ ] Min-output / slippage enforced on-chain per order.
- [ ] Depeg/manipulation considerations for trigger assets (9W-oracle breaker applies to cbETH etc.).

### Quality gates
- [ ] Full TS/unit/integration suite green; contract suite green (real gate).
- [ ] **Full Auditor review** (autonomous fund-moving feature — C/H must be 0 before launch).
- [ ] Real L2 testing: create → trigger → autonomous execution → cancel, on Base mainnet, with a real
      wallet, before flipping tabs live.
- [ ] Monitoring/alerts (Telegram/Sentry) cover the Base executor + order failures.

## When ready
Flip the Base tabs from "Soon" to live in a single change, behind the Preview gate, after the Auditor
pass + real-L2 verification. Until then this doc is the gate.
