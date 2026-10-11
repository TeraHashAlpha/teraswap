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

## 7. Auditor round 1 (2026-10-11: 0C/0H/1M/4L) — follow-up, new commits only, same branch
- [x] **M** cap-delay = skip for streak purposes (executor.js: `recordQuorumSkip` in the `!cap.ok` branch; `dca-floor-delay`
      alert `skip.alert ? TIER_WARN_THRESHOLD : 0`; the single `clearQuorumSkips` moved AFTER the cap check, before `dueSec`;
      a floor breach neither bumps nor resets). Wiring test §4 rewritten + §4b (5 tests); ADR-024 §Consequences bullet.
- [x] **L** 5 new env NAMES in `.env.executor.example` (QUORUM_TOLERANCE_BPS · MAX_PRICE_AGE_SEC · SKIP_ALERT_CYCLES ·
      COINGECKO_API_KEY · KEEPER_VERSION — names + defaults + clamps, no values; plus the pre-existing DCA_FAIL_OPEN_MAX_USD,
      which was also undocumented and whose ceiling clamp is new on this branch — one line beyond the 5, flagged here)
- [x] **L** stale 28b refs in this file corrected (head 5e01670 → 74b8480; `order-floor.js:188` cite on 28b vs `:455` here)
- [x] **L (defer, note only)** per-feed V3 `maxStaleness` read-and-discarded → ADR-024 "Follow-ups" section (gate is the global
      600 s only; proposed `min(MAX_PRICE_AGE_SEC, maxStaleness)` for `v3-registry` quotes + owner decision on the looser half);
      no code change — it would alter which legs are present on live pairs, outside round-1 scope
- [x] keeper suite + lint re-run on the final tree: `node --test` **736/736** (731 + 5 wiring), 0 fail; root `npm run lint`
      0 errors / 94 warnings = baseline; `node --check` clean on executor.js / wiring test / order-floor.js / price-sources.js.
Round-1 follow-up commits (SSH-signed, same branch, no PR): a671abe M · 3b93b5b L env+feedback · (this) L defer note + final.
Mutation (round-1 rules; restore by scratch COPY, not `git checkout` — the latter wiped the GREEN edits once, caught by diff):
M16 cap-delay bump removed → "cap-delay ⇒ recordQuorumSkip on the SAME per-order streak" · M17 alert never escalates →
"cap-delay alert: … WARN at SKIP_ALERT_CYCLES" · M18 reset moved back before the cap check → "reset: ONLY once the price
machinery releases the fill". Suite 731 → **736**, 0 fail.

## Concerns / premises checked
- **28b NOT merged** (`feat/dca-floor-tiers-consent`, head **74b8480** as of the round-1 follow-up — was 5e01670 when §1–6
  were written): no `dca-floor-tier.ts`, no `keeper_runtime_config` on main. Line cite drift: 28b's `dca-floor-tier.ts:34`
  and its test name cite `order-floor.js:188` (the literal's line on main); on THIS branch the literal sits at
  `order-floor.js:455`. The pin itself is by source regex (`export const DCA_FAIL_OPEN_MAX_USD\s*=\s*(\d…)`) + imported
  value, not by line, so it holds either way — whichever branch merges second should refresh the cite.
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

## Feedback — drift-guard mirror regeneration after #558 (post-merge of origin/main)

### Concern
- The DRIFT GUARD failed because `chainlink-feeds.ts` now builds most Base/Arbitrum entries via `...registeredFeedMap(N)` from `src/config/dca-feed-registrations.json`; the mirror was stale AND the test's text parser could not see the derived entries. Both fixed in one commit: the mirror was regenerated programmatically (script read the TS literals + enabled config rows + FEED_EXPECTATIONS/row descriptions; no hand-typed hex), and the test now computes the app's effective set = literals + enabled rows (row wins on a shared token), per chain, with the same address-equality and decimals/pair checks.
- Mirror entries carry only { feed, decimals, pair } — no maxStaleness/heartbeat field exists in the mirror, so none to align (the config's heartbeat/maxStaleness feed the app's staleness tables, not the keeper mirror).

### Evidence
- Per-chain counts (measured): Base 3 -> 8, Arbitrum 5 -> 15. These are NOT 9/16: the effective set is literals ∪ enabled rows with overlaps merged by token (Base: DAI literal + 7 enabled rows, WETH is in both; USDC literal removed from the TS and replaced by the row. Arbitrum: 5 literals + 13 enabled rows, DAI/USDT/WBTC in both = 15). No enabled feed is excluded from the mirror. Only the config's `enabled:false` phase-2 rows (Base 8: AERO, DEGEN, MOG, MORPHO, WELL, YFI, ZRO, cbETH; Arbitrum 4: GMX, GRT, WOO, YFI) are absent, and they are equally absent from the app's maps. I could not reproduce 9/16 from the source.
- Base USDC feed changed 0x4581… (SVR proxy) -> 0x7e86… (plain proxy), per the 2026-10-11 owner decision recorded in chainlink-feeds.ts.
- Drift guard passing: chain 8453 and chain 42161 key-set/address tests, decimals+pair test all ✔.
- Full keeper suite (`node --test` in contracts/order-engine/executor, the keeper-tests.yml command): 736 tests, 736 pass, 0 fail. Run under Node v25.6.1 (Node 20 unavailable locally; CI uses 20.20.2).
- Still a guard (scratch mutations of price-sources.js, restored afterwards):
  - Remove the Base COMP entry: `✖ chain 8453: key set AND every feed address equal chainlink-feeds.ts` — `AssertionError: token key set drifted`
  - Change one hex digit of the Arbitrum LINK feed (…86E53… -> …86E54…): `✖ chain 42161: key set AND every feed address equal chainlink-feeds.ts` — `AssertionError: feed for 0xf97f4df75117a78c1a5a0dbb814af92458539fb4 drifted`
