# feat/dca-floor-tiers-consent — FEEDBACK (owner decision 2026-10-11; no PR, Auditor follows)
Done: classifier, API+migration, UI, tests, cap-ceiling change. Commits 20df018, 907bd20, c8f828b, e1cb9c7, 76228ad; Auditor round 1 fixes ccb4c83, 68806c6.

1. **Classifier** `src/lib/order-engine/dca-floor-tier.ts`: onchain-feed = both SIGNED legs `registered` in the chain's V3 `tokenUsdFeeds` (native->chain WETH);
   else offchain-price = every non-WETH leg has a DefiLlama price; else unpriced. Any lookup failure -> unpriced. Pin: `DCA_NO_PRICE_FILL_CAP_MAX_USD=250`
   == `DCA_FAIL_OPEN_MAX_USD` (`order-floor.js:188`), test imports + regexes the keeper source.
2. **Route** `src/app/api/orders/route.ts:490-519` (v3 DCA, post-signature): tier != onchain-feed needs `floorAck.tier == serverTier` else 409 `{requiredTier}`;
   `acknowledgedAt` ISO, <=24h old, <=5min future else 400. Insert adds `floor_tier`/`floor_ack_at` only for consent tiers.
3. **Storage = migration, NOT applied** `supabase/migrations/20261011120000_orders_floor_tier_consent.sql` (+ `contracts/order-engine/schema.sql`):
   `orders.floor_tier` (nullable, CHECK 3 tiers), `orders.floor_ack_at` (nullable), table `keeper_runtime_config(chain_id PK, no_price_fill_cap_usd, keeper_version, updated_at)`
   RLS on, no policies. Owner verifies all three in Supabase; apply BEFORE deploy (consent-tier insert 500s until then). `floor_tier|floor_ack` in executor/*.js = 0 (keeper reads `select=*`).
4. **UI copy** offchain-price: "No on-chain price feed for <SYMBOL>. The contract cannot enforce a minimum; each buy is protected only by our off-chain price check."
   unpriced: "No price source for <SYMBOL>. Buys may execute at ANY price; each buy is capped at up to $250 and flagged." (+" Currently $X." only if effective < MAX; never above MAX.)
   Checkbox "I understand and want to proceed"; none for onchain-feed; badge on both order cards.
5. **Tests** (+39 vs main): dca-floor-tier.test 11, orders-floor-consent.test 11, DcaFloorConsentDialog.test 5, dca-floor-cap route.test 7, FloorTierBadge.test 2;
   DCAPanel nofeed-fail-closed/nofeed-consent/arbitrum-gates inverted to consent flow (wallet silence until ack still asserted).
6. **Verify** vitest 290 files/4348 tests (origin/main 84da8a3: 285/4309); eslint 94w/0e = baseline (delta 0); tsc clean; 25 files +1102/-85 at 68806c6 (the earlier +1039 was wrong; +1028/-85 was at 5e01670, before the round-1 fixes). Keeper/order-floor/V3 untouched.

## Owner decisions (2026-10-11, supersede goal text)
- Cap env-overridable -> constant is a CEILING; `GET /api/dca-floor-cap` = min(keeper_runtime_config row, MAX) else MAX (web READ-only). **Deferred follow-up (keeper price-quorum goal):** keeper clamps env > MAX with a loud warning and writes its runtime-config row at startup.
- Read scope: I read beyond the list (useOrderEngine, supabase.ts, types.ts, economic-floor, chainlink, executor.js, schema.sql, order cards, NoFeedConsentModal) without asking; owner ACCEPTED, Auditor reviews them.
- Native ETH->WETH is `src/components/DCAPanel.tsx:865` (not 379-380; the earlier :866 was off by one), confirmed.

## Auditor notes
`acknowledgedAt` is client-supplied (window-validated evidence, not proof). Registry-down now asks "unpriced" consent (was "try again"); +1 RPC and <=2 DefiLlama calls per v3 DCA POST.

## Auditor round 1 (0C/0H/1M/3L) — fixes
- L-01 `orders/route.ts`: v3 DCA with the native sentinel as tokenOut -> 400 "Use WETH"; NOT mapped server-side (signed leg == classified leg). Test, mutation-verified.
- L-02 Limit/TP v3 on Base: zero classifier calls, 201, no `floor_tier`/`floor_ack_at`; mutation dropping the DCA orderType check now fails it (it did NOT before the test reached the gate; limit-buy and TP share orderType `limit`).
- L-03 `/api/dca-floor-cap`: `checkRateLimit` (QUOTE_RATE_LIMIT, per IP, 429 before any DB read) + `Cache-Control: public, max-age=60` (success and ceiling fallback); 2 tests.
- M-01 resolved by the keeper clamp in feat/keeper-price-quorum (merges right after this); nothing changed here.

## Owner checklist (before deploy / keeper restart)
- Apply + verify the migration (item 3) BEFORE deploy.
- Before keeper restart confirm DCA_FAIL_OPEN_MAX_USD is unset or <= 250 in both executor env files (count lines by NAME only, print no values).
