# Feedback — fix/dca-chain-switch

Recon: `~/TeraSwap-Workspace/queue/site-claims-bugs-2026-10-12.md` (P1–P4). Read-only extras recorded in-session:
`src/components/dca/pair-floor-info.ts` (goal text said `lib/order-engine/`; it lives under `components/dca/`).

## Checklist
- [x] C1 client: selections never outlive the chain (key={chainId} + in-panel reset) — evidence 1
- [ ] C2 server: refuse foreign addresses (create 400 / floor-cap onChain:false) — evidence 2
- [ ] C3 P2 / P3 / P4 — evidence 3, 4, 5
- [ ] Suite / lint / tsc / diff --stat / compare link — evidence 6

## Evidence
1. Chain-switch: `DCAPanel.chain-switch.test.tsx` (5 tests). 8453→42161→8453, both in-place rerender and keyed; every
   `/api/dca-floor-cap` request's tokenIn/tokenOut asserted ∈ `getChainTokenList(request.chainId)`; consent body has AERO, not ARB;
   signed order addresses ∈ Base map. Verified red on the old DCAPanel.tsx (in-place case fails), green with the fix.
   Design note: reset happens DURING render (setState-in-render), so no effect/fetch ever sees the stale pair; buy side → null per owner text.
