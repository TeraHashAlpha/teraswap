# feat/dca-feed-batch-2026-11 — FEEDBACK (no PR, NO tx, no key; Draft PR + **Auditor required**)

Checklist: [x] premise · [x] commit 1 tool + config · [x] commit 2 mirror + pins + keeper data · [x] commit 3 runbook · [ ] verify · [ ] push

Owner answer 2026-11-13 (asked once): "enabled: true" and "no keeper change" cannot both hold; the keeper drift guard
(`contracts/order-engine/executor/price-sources.test.mjs`) requires the keeper Chainlink mirror to equal every enabled row.
Answer: **allow the keeper mirror DATA** (eight Base entries copied from the config, drift guard untouched), add `--keeper` to verify.

## 3 Behaviour changes (commit 2). Seven tokens gain a swap-side feed: MORPHO AAVE LINK USDS AERO ZRO YFI. cbETH app-side is unchanged.
**IN EFFECT AT DEPLOY, BEFORE THE ON-CHAIN EXECUTE (the three that can block or mislabel):**
1. **SWAP (v1 + v2): A SWAP TOUCHING ONE OF THE SEVEN IS HARD-BLOCKED AT ANY SIZE WHILE ITS FEED CANNOT BE READ OR VERIFIED** (RPC read
   failure, round older than 129 600 s = 1.5 x heartbeat, description/decimals mismatch): `price-gate.ts:62-64`, `useChainlinkPrice.ts:392, 416`.
   Today that swap passes with a warning below $10 000. Outage-only.
2. **DCA CREATION (v1 + v2): THE SAME FEED FAILURE BLOCKS CREATING A DCA WITH THAT TOKEN, AND DEFILLAMA MAY NOT SUBSTITUTE**
   (`DCAPanel.tsx:533-549`, `ui/v2/dca/use-dca-form.ts:188-190`). Today the signed minimum falls back to DefiLlama.
3. **LIMIT / TAKE-PROFIT (v1, only where `NEXT_PUBLIC_LIMIT_ENABLED=true`; not readable from the repo): THE SEVEN BECOME SIGNABLE, BUT THE
   CONTRACT JUDGES A TRIGGER FEED WITH 300 s STALENESS** (`TeraSwapOrderExecutorV3.sol:133, 1121-1125`) unless `oracleConfigs[feed]` is set, and
   it is set for NO Base feed (read on-chain 2026-11-13, all 19). **ON A 24 h-HEARTBEAT FEED SUCH AN ORDER CAN FILL ONLY WITHIN 5 MIN OF A
   FEED ROUND.** Already true for COMP, EURC, USDT, VIRTUAL. Registering `tokenUsdFeeds` does not change it.

Other changes at deploy:
4. Swap, healthy feed: the "No Chainlink oracle" warning and the unverified tiers (warn > $1 000, block > $10 000, `constants.ts:501-503`) stop
   applying to that leg; a leg quoted against USDC/USDbC/USDT/DAI is deviation-checked (2 % warn, 3 % consent, > 25 % block). USDS is not in the
   Base USD-stable list (`isUsdStablecoin('USDS', 8453)` = false), so it is checked as a priced leg, never used as a $1 reference.
5. `/api/swap` value estimate gains a Chainlink candidate for the seven (`route.ts:292-296`): fewer `unpriced_ack_required`; the > $10 000
   guard can now engage on a swap whose only priced side is one of them (read from code, not exercised against DefiLlama).
6. `/api/swap-price-tier` (advisory): Chainlink joins the quorum when its round is <= 600 s old. `/api/oracle-coverage`: `hasChainlink` true.
7. Copy "N token price feeds on Base" (`chainlinkFeedCountFor(8453)`, landing + docs, v1 + v2): 9 -> 16 (measured).
8. Limit/TP signable tokens of the curated Base list: 9 -> 13 (measured); AAVE, LINK, USDS are signable through search only. cbETH: never.
9. Keeper, ONLY after the owner redeploys it: Chainlink is a third quorum source for the eight when its round is <= 600 s old
   (`MAX_PRICE_AGE_SEC`); it can break a DefiLlama/CoinGecko tie that skips a cycle today. Round older than that: absent, as today.

DCA floor tier. **Before the execute: unchanged.** The tier is read from the executor's `tokenUsdFeeds` (`dca-floor-tier.ts:105-117`), never
from the mirror: pairs with the eight stay `offchain-price` / `unpriced` with the consent dialog. **After the execute:** a pair with both legs
registered classifies `onchain-feed` (no consent, contract enforces max(oracleFloor, scaledMin)) with no deploy. `registeredFeedCount` in the
consent copy counts the curated 24-token list, so it rises by 5, not 8: AAVE, LINK, USDS are search-only (finding, not fixed).

cbETH: its enabled row made `chainlink-feeds.ts` throw at import (assert (b), FIX-CBETH-DIRECT-FEED). The mirror now keeps a preferred-direct
token out of the terminal map and refuses to load if the row and the preferred feed differ. "Mirrors every enabled row" is true minus cbETH.

Pinned tests (none deleted, none loosened): `chainlink-feeds.test.ts` ("phase 2 rows are disabled" is now "enabled ONLY inside a batch",
with the batch rows pinned by name; +2 tests), `price-feed.test.ts` (BASE_SIGNABLE re-pinned from the resolver, +1 test), Limit and SL/TP panel
tests (the no-feed token is wstETH instead of Base LINK; +1 test each: Base LINK signs its own row feed). Commit 1 alone does not pass the suite.
