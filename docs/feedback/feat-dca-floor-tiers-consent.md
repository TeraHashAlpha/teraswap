# feat/dca-floor-tiers-consent — FEEDBACK (owner decision 2026-10-11; no PR, Auditor follows)
Done: classifier, API+migration, UI, tests, cap-ceiling change. Commits 20df018, 907bd20, c8f828b, e1cb9c7, 76228ad.

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
5. **Tests** (+35 vs main): dca-floor-tier.test 11, orders-floor-consent.test 9, DcaFloorConsentDialog.test 5, dca-floor-cap route.test 5, FloorTierBadge.test 2;
   DCAPanel nofeed-fail-closed/nofeed-consent/arbitrum-gates inverted to consent flow (wallet silence until ack still asserted).
6. **Verify** vitest 290 files/4344 tests (main 84da8a3: 285/4309); eslint 94w/0e = baseline; tsc clean; 25 files +1039/-85. Keeper/order-floor/V3 untouched.

## Owner decisions (2026-10-11, supersede goal text)
- Cap env-overridable -> constant is a CEILING; `GET /api/dca-floor-cap` = min(keeper_runtime_config row, MAX) else MAX (web READ-only). **Deferred follow-up (keeper price-quorum goal):** keeper clamps env > MAX with a loud warning and writes its runtime-config row at startup.
- Read scope: I read beyond the list (useOrderEngine, supabase.ts, types.ts, economic-floor, chainlink, executor.js, schema.sql, order cards, NoFeedConsentModal) without asking; owner ACCEPTED, Auditor reviews them.
- Native ETH->WETH is `DCAPanel.tsx:866` (not 379-380), confirmed.

## Auditor notes
`acknowledgedAt` is client-supplied (window-validated evidence, not proof). Registry-down now asks "unpriced" consent (was "try again"); +1 RPC and <=2 DefiLlama calls per v3 DCA POST.
