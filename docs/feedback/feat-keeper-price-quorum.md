# Feedback — feat/keeper-price-quorum

Per-fill, per-leg DCA floor price QUORUM (owner decisions 2026-10-11) + scope addition 00:51 WEST (hard ceiling +
boot publish). Signed commits: e933668 sources · 09e32bd quorum+wiring · d078526 28b map · f831fee tests+mutation ·
05b5124 ceiling+runtime-config · (this) ADR. Auditor next; no PR. **Both keepers must be restarted.**

## 1. Sources — `price-sources.js`, trust order; each → {price, ts, source}; age > MAX_PRICE_AGE_SEC or no ts ⇒ ABSENT
chainlink: V3 `tokenUsdFeeds` when registered → else resolved `ETH_USD_FEED` (ETH leg, env wins) → else mirror of
`chainlink-feeds.ts` (8453/42161 complete, chain 1 subset; drift test parses the TS: address + decimals + pair).
defillama: the existing endpoint, batched once/cycle. coingecko (NEW): `simple/token_price/<platform>`, keyless,
batched + cached once/cycle, `COINGECKO_API_KEY` optional. Why: nothing in-repo prices by contract address
independently of DefiLlama/Chainlink (catalog = metadata, token-logo = logos); an aggregator quote is what the floor checks.

## 2. input → mode (`resolveFloorPrice`; fill = skip if either leg skips, single if either is single, else quorum)
| 0 sources | **skip** | 1 | **single**: half band + $250 cap + flag | 2 agree (≤300 bps, inclusive) | **quorum** |
| 2 disagree, no 3rd | **skip** | 3, one pair agrees | **quorum**, outlier dropped | 3 chain A~B,B~C | quorum, trust tie-break | 3 none | **skip** |
Conservative = protective: `in` = max, `out` = min. Unknown leg or unusable reference ⇒ skip. Never cancel, never blind.

## 3. Hunk — executor.js, the blind-fill branch (≈1660-1743 on origin/main)
```
- const [refIn, refOut] = await Promise.all([fetchReferencePriceUsd(tokenIn…), fetchReferencePriceUsd(tokenOut…)])
- if (bothPriced) { …decideFloor… } else { classifyReference → decideFailOpen → "dca-floor-unverified" FILL }
+ const floorIn = resolveFloorPrice("in", await quoteCtx.legQuotes(tokenIn)); floorOut = resolveFloorPrice("out", …)
+ if (combineLegModes(…) === "skip" || referenceExpectedOut == null) { recordQuorumSkip(quorumSkips, id) → alert@N;
+   await updateOrderStatus(id, "active"); skipped++; continue }           // never executes, never cancels
+ clearQuorumSkips; band = single ? singleSourceFloorBps(bps) : bps; decideFloor(…) (breach path unchanged)
+ if single: decideSingleSourceCap({ notionalUsd, maxUsd: getFailOpenMaxUsd() }) → delay | fill FLAGGED
```
One `createCycleQuoteContext` per cycle (all active DCA tokens registered). Streak also cleared on success and expiry.

## 4. Mutation — 15 flips, each caught; files restored, git-clean verified (first failing test)
M1 tol×10 → THIRD SOURCE BREAKS THE TIE · M2 max/min swapped → 'in' HIGHER, 'out' LOWER · M3 1→quorum → duplicated source
counts once · M4 skip leg ignored → combineLegModes · M5 stale counted → isFresh · M6 cap 500 → defaults to 250 · M7
`continue` removed → skip ⇒ … continue — and nothing else · M8 alert N+1 → fires exactly at N · M9 no reset → reset on
resolve AND success · M10 all-must-agree → THIRD SOURCE … · M11 full band → single-source floor is TIGHTER · M12 cancel →
unlock (active) · M13 0→single → ZERO sources ⇒ skip · M14 registry ignored → registered in V3 ⇒ registry feed ·
M15 ceiling off → ABOVE the ceiling ⇒ the ceiling

## 5. Suite + lint
keeper `node --test`: origin/main **650 → 731**, 0 fail (+29 sources, +24 floor, +13 wiring, +12 runtime-config; 1 test
rewritten, 3 re-pointed to exported values). root `npm run lint`: 0 errors / 94 warnings = baseline (eslint ignores
`contracts/**`; every keeper file `node --check` clean).

## 6. ADR + deploy
`docs/ADR/ADR-024-dca-price-quorum.md` — Accepted; owner text verbatim incl. "skip the cycle, never the order"; index row added.
Env NAMES: QUORUM_TOLERANCE_BPS · MAX_PRICE_AGE_SEC · SKIP_ALERT_CYCLES · DCA_ORACLE_FLOOR_BPS · DCA_FAIL_OPEN_MAX_USD
(≤ 250 ceiling, clamped + loud) · COINGECKO_API_KEY (opt) · KEEPER_VERSION (opt) · ORDER_EXECUTOR_V3_ADDRESS · ETH_USD_FEED. No new secret.
1. host: `git pull` (both keepers)                 2. `cd contracts/order-engine/executor && npm ci --ignore-scripts`
3. `pm2 restart teraswap-keeper-arbitrum`          4. logs: `No-price fill cap: $250 […]` then `DCA price quorum: in=… out=… -> …`
5. `pm2 restart teraswap-executor` (Base)          6. `select chain_id, no_price_fill_cap_usd from keeper_runtime_config` → 8453 + 42161
   (until the 28b migration is applied, step 6 shows instead the log line "table keeper_runtime_config is not there yet").

## Concerns / premises checked
- **28b NOT merged** (`feat/dca-floor-tiers-consent` 5e01670): no `dca-floor-tier.ts`, no `keeper_runtime_config` on main.
  Mapping: onchain-feed ⇔ quorum with chainlink; offchain-price ⇔ quorum achievable (≥ 2 of the SAME list); unpriced ⇔ ≤ 1.
  TODO at `order-floor.js` `resolveFloorPrice` JSDoc; 28b must count CoinGecko too. Its pin `DCA_NO_PRICE_FILL_CAP_MAX_USD`
  → `DCA_FAIL_OPEN_MAX_USD` literal (regex + value) holds; keeper test pins ceiling == literal == 250. Publish tolerates the
  missing table (404 / PGRST205 → logged, boot continues) — nothing to change when the migration lands.
- Base USDC/USD Chainlink heartbeat is 24 h vs MAX_PRICE_AGE_SEC 600 ⇒ that leg's on-chain quote is usually ABSENT; stables
  quorum on DefiLlama + CoinGecko (Arbitrum USDC/USD 255 s is fine). Owner may want a larger age on Base.
- Protective conservative pick compresses the band near tolerance (two legs at 3 % ≈ +6 % reference) ⇒ false DELAYS, never drains.
- `classifyReference` / `decideFailOpen` retained unused (rule #4). ARCHITECT-INDEX had no ADR-023 row before this (pre-existing).
- Commit layout: the brief's "Commit 5" became 5 (scope addition) + 6 (ADR); the `tokenUsdFeeds` ABI is mirrored from
  `src/lib/order-engine/abi.ts` (feed, feedDecimals, tokenDecimals, maxStaleness, registered).
