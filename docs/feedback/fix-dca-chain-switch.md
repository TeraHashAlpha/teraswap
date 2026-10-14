# Feedback — fix/dca-chain-switch

Recon: `~/TeraSwap-Workspace/queue/site-claims-bugs-2026-10-12.md` (P1–P4). Extra read-only context (recorded): `components/dca/pair-floor-info.ts`
(goal said `lib/order-engine/`), a grep of `app/swap/page.tsx`. Auditor-note: DCA create path = `api/orders/route.ts` (new pre-signature guard).

- [x] C1 client · [x] C2 server · [x] C3 P2/P3/P4 · [x] verify + push

## Evidence
1. **Chain switch** — `DCAPanel.chain-switch.test.tsx` (5): 8453→42161→8453, in-place rerender and keyed; every `/api/dca-floor-cap` request's addresses ∈ `getChainTokenList(request.chainId)`;
   post-switch Base requests use Base WETH; consent body has AERO not ARB; signed order ∈ Base map. Red on old DCAPanel.tsx. Reset runs DURING render (no stale fetch).
2. **Server refusal** — `token-on-chain.ts` (known-map → `eth_getCode` on order chain → 10-min cache per chain+addr; RPC failure = null, uncached).
   Create (v3 DCA, before signature recovery): `false` → 400 `token_not_on_chain{leg,reason}`; `null` → 503 `token_check_unavailable`. Floor-cap: 200, `unpriced`, `legs.<x>.onChain:false`+`reason`, classifier not called.
   Tests: `orders-token-on-chain.test.ts` (8: ARB addr@8453 → 400 with recover/insert/rpc mocks NOT called; Arb WETH tokenIn; cache+TTL; code→201; Base no-feed→201, 0 getCode; getCode down→503; native rules unchanged), `token-on-chain.test.ts` (6), floor-cap route (+3).
3. **P2** before: gate = wagmi `useChainId()` (mainnet when no wallet) → Base-selected visitor saw "Soon" (new test red 4/5 on old page.tsx). After: `useQuoteChainId()`, panel gets `chainId` prop; Base/no wallet → live;
   Ethereum + flag on → tab selectable, "DCA runs on Base and Arbitrum One" + Switch buttons (wagmi if connected, selector store if not); flag off / Arbitrum-dark → unchanged disabled "Soon". Static "Coming to L2 soon" removed. `page.selector-chain.test.tsx` (5).
4. **P3 matrix** (`DCAPanel.tier-hint.test.tsx`, oracle probe stubbed "no oracle" throughout): onchain-feed → none · offchain-price → "Protected by executor price checks (no Chainlink feed registered yet)" · unpriced → "No market price source right now — buys capped at $250 and flagged" (cap = min(server, ceiling)). Dialog copy untouched.
5. **P4** DCA fills (`dca_total>1`) show "⛽ gas paid by executor" (row + aggregate), no ETH figure; non-DCA keeps its figure. 2 tests in `ExecutionTimeline.test.tsx`.
6. **Verify** — tsc clean · suite 4451/4451 (299 files) vs origin/main 4418/4418 (294) · eslint 93 warnings/0 errors vs main 94/0 (delta −1) · 409 ack rule, persistence, keeper, quorum constants untouched.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/dca-chain-switch

## Concerns / edge cases
- `app/swap/page.tsx` has the same wagmi-chain gate + static "Coming to L2" copy (not in scope, untouched) — follow-up if that route is live.
- Pre-signature guard lets an unauthenticated caller cause one cached `getCode` per unknown address (rate-limited; known-map tokens cost 0). Limit/TP/SL create is not covered.
- Fixtures with codeless fake hex tokens (orders-floor-consent/p1b/v3, dca-floor-cap route) now stub the presence check; old "oracle-less advisory" tests in routability were retired (replaced by tier-hint).
- `ComingSoonPanel` moved out of page.tsx; Limit/SL·TP tabs still disabled "Soon" (their copy no longer says "L2 soon").
