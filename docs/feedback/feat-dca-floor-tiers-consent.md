# feat/dca-floor-tiers-consent — FEEDBACK (owner decision 2026-10-11; no PR, Auditor follows)

All checklist items done (C1 classifier, C2 API+migration, C3 UI, C4 tests). Commits 20df018, 907bd20, c8f828b, tests commit.

**1. Classifier** `src/lib/order-engine/dca-floor-tier.ts`: `onchain-feed` = both SIGNED legs `registered` in the chain's V3 `tokenUsdFeeds`
(native->that chain's WETH, `getChainConfig`); else `offchain-price` = every non-WETH leg has a DefiLlama price (WETH via Chainlink);
else `unpriced`. Registry unreadable / no executor / unsupported chain / price-source throw -> `unpriced`. Pin: `DCA_NO_PRICE_FILL_CAP_USD = 250`
== `DCA_FAIL_OPEN_MAX_USD` (`contracts/order-engine/executor/order-floor.js:188`), test imports the keeper module AND regexes its source.
**2. Route** `src/app/api/orders/route.ts:490-519` (v3 DCA only, after signature recovery): server classifies; tier != onchain-feed needs
`body.floorAck.tier === serverTier` else **409** `{requiredTier}`; `acknowledgedAt` must be ISO, <=24h old, <=5min future else 400. Insert (L704)
adds `floor_tier`/`floor_ack_at` ONLY for consent tiers. Non-DCA / v2 untouched.
**3. Storage: migration** (`order_data` is the signed struct the keeper replays - not reused). `supabase/migrations/20261011120000_orders_floor_tier_consent.sql`
(+ mirrored in `contracts/order-engine/schema.sql`): `orders.floor_tier TEXT NULL` (CHECK in the 3 tiers), `orders.floor_ack_at TIMESTAMPTZ NULL`.
**NOT applied.** Owner verifies in Supabase after merge: both columns exist, nullable, constraint `orders_floor_tier_valid`. Apply BEFORE deploy:
until then a consent-tier DCA insert 500s (fails closed); on-chain-feed DCA is unaffected. Grep: `floor_tier|floor_ack` in `contracts/order-engine/executor/*.js` = 0;
the keeper reads `select=*` so it receives the columns but never references them.
**4. UI copy (verbatim)** offchain-price: "No on-chain price feed for <SYMBOL>. The contract cannot enforce a minimum; each buy is protected only by our off-chain price check."
unpriced: "No price source for <SYMBOL>. Buys may execute at ANY price; each buy is capped at $250 and flagged." (250 interpolated from the constant.)
Checkbox "I understand and want to proceed"; Continue disabled until ticked; Cancel = safe focus. None for onchain-feed. Badge on both order cards.
**5. Tests** (+24, 285->288 files): dca-floor-tier.test (10: 3 tiers, lookup/price failure, unsupported chain, per-chain V3 address, ETH->WETH, WETH never looked up, cap pin);
orders-floor-consent.test (9: feed w/o ack 201, offchain w/o ack 409, mismatch, onchain-feed ack no bypass, both acks persisted, registry down->unpriced, bad timestamps, v2 untouched);
FloorTierBadge.test (2); DCAPanel nofeed-fail-closed 7->10 / nofeed-consent 3 / arbitrum-gates 2 inverted (wallet silence until ack still asserted; dialog per tier, none for feed).
orders-v3/p1b mock the classifier as `onchain-feed` (pre-consent suites).
**6. Verify** vitest 288 files/4333 tests (origin/main 84da8a3: 285/4309); eslint 94 warn/0 err = baseline (delta 0); tsc clean; 22 files, +856/-85. Keeper/order-floor/V3 untouched.

## Notes for the Auditor
- Premise corrections: native->WETH is DCAPanel.tsx ~L866 (not 379-380). Cap 250 is a keeper DEFAULT; env `DCA_FAIL_OPEN_MAX_USD` can override, so UI text can drift from a tuned keeper.
- `acknowledgedAt` is client-supplied (validated window); the server stores it, it is evidence of consent not proof.
- Registry-down now asks consent ("unpriced") where it used to say "try again" - per spec; classification adds 1 RPC + <=2 DefiLlama calls per v3 DCA POST (post-signature, rate-limited).
- Old `NoFeedConsentModal` untouched (superseded). Client classifies with the same module, so it can show the dialog before approve; the server's 409 stays authoritative.
