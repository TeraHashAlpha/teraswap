# Feedback — fix/dca-chain-switch

Recon: `~/TeraSwap-Workspace/queue/site-claims-bugs-2026-10-12.md` (P1–P4). Read-only extras recorded in-session:
`src/components/dca/pair-floor-info.ts` (goal text said `lib/order-engine/`; it lives under `components/dca/`).

## Checklist
- [x] C1 client: selections never outlive the chain (key={chainId} + in-panel reset) — evidence 1
- [x] C2 server: refuse foreign addresses (create 400 / floor-cap onChain:false) — evidence 2
- [ ] C3 P2 / P3 / P4 — evidence 3, 4, 5
- [ ] Suite / lint / tsc / diff --stat / compare link — evidence 6

## Evidence
1. Chain-switch: `DCAPanel.chain-switch.test.tsx` (5 tests). 8453→42161→8453, both in-place rerender and keyed; every
   `/api/dca-floor-cap` request's tokenIn/tokenOut asserted ∈ `getChainTokenList(request.chainId)`; consent body has AERO, not ARB;
   signed order addresses ∈ Base map. Verified red on the old DCAPanel.tsx (in-place case fails), green with the fix.
   Design note: reset happens DURING render (setState-in-render), so no effect/fetch ever sees the stale pair; buy side → null per owner text.
2. Server refusal (`lib/order-engine/token-on-chain.ts`; known-map → `eth_getCode` on the order's chain → 10-min cache per (chainId,address)):
   - `api/orders/route.ts`, v3 DCA only, BEFORE signature recovery: `false` → 400 `{code:'token_not_on_chain', leg, reason}`; `null` (RPC failed / unsupported chain) → 503 `token_check_unavailable` (fail closed, not cached).
   - `api/dca-floor-cap`: foreign leg → 200, `tier:'unpriced'`, `legs.<x>.onChain:false` + `reason`, classifier not called; every pair answer now carries `legs.<x>.onChain`.
   - Tests: `orders-token-on-chain.test.ts` (8; ARB addr + chainId 8453 → 400 with `mockRecover`/`mockInsert`/`mockRpc` NOT called; Arb WETH as tokenIn; cache + TTL; long-tail with code → 201; valid Base no-feed token → 201 with 0 getCode; getCode down → 503; native-sentinel rules unchanged), `token-on-chain.test.ts` (6), `dca-floor-cap/route.test.ts` (+3).
   - Existing fixtures use codeless fake hex tokens: orders-floor-consent/p1b/v3 + dca-floor-cap route tests now stub the presence check (comment in each file).
   - Concern: the guard runs pre-signature, so an unauthenticated caller can cause one cached `getCode` per unknown address (rate-limited; known-map tokens cost 0). Limit/TP/SL create is NOT covered (out of scope).
