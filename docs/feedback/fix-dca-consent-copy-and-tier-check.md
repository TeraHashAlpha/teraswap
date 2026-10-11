# Feedback — fix/dca-consent-copy-and-tier-check

**Scope.** Owner-accepted reads outside the list: `next.config.js` (CSP), `src/lib/security-headers.test.ts`,
`src/app/api/orders/route.ts` + `orders-floor-consent.test.ts`, the `orders_floor_tier_consent` migration.
Path drift: the dialog is `src/components/dca/DcaFloorConsentDialog.tsx` (+ `dca/__tests__/`).

## 1. Part-1 tier check — BUG, but not in `dca-floor-tier.ts`
Real `classifyDcaFloorDetailed` in Node with public DefiLlama. The registry is stubbed `registered=false`
because V3 is env-only: unset locally it returns `unreadable` → `unpriced`, an env artifact.

| chain | pair | DefiLlama coin key | HTTP | price | conf | tier |
|---|---|---|---|---|---|---|
| 42161 | WETH→AAVE | `arbitrum:0xba5d…7196` | 200, 589 ms | 167.33 | 0.99 | offchain-price |
| 42161 | WETH→UNI | `arbitrum:0xfa7f…f7f0` | 200, 143 ms | 7.557 | 0.99 | offchain-price |
| 8453 | WETH→AAVE | `base:0x6370…814b` | 200, 361 ms | 167.33 | 0.99 | offchain-price |
| 8453 | WETH→UNI | `base:0xc3de…3c83` | 200, 335 ms | 7.557 | 0.99 | offchain-price |

Price ts ~100 s old. Coin-key format, case, the confidence filter and the 3 s timeout are all ruled out; ACAO is `*`.
**Root cause.** The dialog's tier is classified in the **browser** (`DCAPanel.tsx:866` → `fetchDefiLlamaPrice`).
The production CSP `connect-src` (`www.teraswap.app`, curl 2026-10-11) has no `https://coins.llama.fi`, so the
fetch is blocked, returns null, and the leg is `unpriced` for every token with no on-chain feed. That is systematic,
matching AAVE and UNI. The server re-classifies without CSP, gets `offchain-price`, and its exact-match rule would 409
the `unpriced` ack (read from the code, not observed in production).
**Owner fix.** CSP origin + pin test; server accepts an ack ≥ the server tier and persists the server tier;
`floor_ack_tier` was **not** added (no column fits; note only).
**Follow-up (not this branch).** Move classification to a server endpoint so the browser never calls price sources
(one source of truth, no CSP widening). Also unverified: the no-env RPC fallbacks (`arb1.arbitrum.io`,
`mainnet.base.org`) aren't in `connect-src` either. Production showed only AAVE named, consistent with its registry
read succeeding.
