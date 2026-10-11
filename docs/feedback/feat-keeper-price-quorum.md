# Feedback — feat/keeper-price-quorum

Goal: DCA floor price QUORUM per fill, per leg (owner decisions 2026-10-11) + scope addition 00:51 WEST
(hard ceiling `DCA_NO_PRICE_FILL_CAP_MAX_USD`, clamp + loud warning, boot upsert `keeper_runtime_config`).

## Checklist
- [x] C1 sources: `price-sources.js` (chainlink V3 registry → mirror, defillama, coingecko) + tests
- [x] C2 quorum + skip: `resolveFloorPrice`, constants, executor wiring replaces blind-fill branch
- [x] C3 28b alignment (not merged → mapping + TODO file:line)
- [x] C4 tests + mutation table; keeper suite count vs 650
- [ ] C5 ADR-024 + deploy note + host checklist
- [ ] Scope addition: ceiling clamp (both directions tested), boot upsert (tolerates missing table)

## Premises checked
- 28b (`feat/dca-floor-tiers-consent`, head 5e01670) is NOT on origin/main: no `dca-floor-tier.ts`,
  no `keeper_runtime_config` table. Its pin reads `export const DCA_FAIL_OPEN_MAX_USD = <literal>`
  by source regex AND imported value → that literal stays exactly as is (250).
- origin/main keeper suite: 650 tests / 124 suites, 0 fail (measured in this worktree after
  `npm ci --ignore-scripts` in `executor/`).

## 28b alignment (C3) — 28b NOT merged, mapping recorded, no fork
| 28b tier (`dca-floor-tier.ts`, creation time) | keeper mode (`order-floor.js` `resolveFloorPrice`, fill time) |
|:--|:--|
| `onchain-feed` (both legs registered in V3) | `quorum` with chainlink present (registry hit) |
| `offchain-price` | quorum achievable: ≥ 2 of chainlink / defillama / coingecko answer for EVERY leg |
| `unpriced` | ≤ 1 source on some leg → `single` (capped, flagged) or `skip` (0 / disagreement) |

TODO pinned at `contracts/order-engine/executor/order-floor.js` (JSDoc of `resolveFloorPrice`,
"TODO(28b-alignment)"): when 28b merges, its classifier must count the SAME source list
(`PRICE_SOURCE_TRUST_ORDER`; today it counts only DefiLlama off-chain) and a pin test must import both.

## Mutation table (C4) — each rule flipped in place, tests run, file restored (git-clean verified)
| # | rule flipped | first failing test |
|:--|:--|:--|
| M1 | agree within tol → 10×tol | THIRD SOURCE BREAKS THE TIE: two agree, the outlier is dropped |
| M2 | conservative in=max/out=min swapped | 'in' takes the HIGHER, 'out' the LOWER price |
| M3 | 1 source reported as quorum | quorum needs INDEPENDENT sources: a duplicated source counts once |
| M4 | a skip leg no longer skips the fill | combineLegModes: any skip ⇒ skip |
| M5 | stale quote counted (age cap dropped) | isFresh: within max age (inclusive) (+5 more in price-sources) |
| M6 | cap 250 → 500 | defaults to 250 (+ cap source is DCA_FAIL_OPEN_MAX_USD = 250) |
| M7 | skip `continue` removed (falls to execute) | skip ⇒ count, log, unlock, skipped++, continue — and nothing else |
| M8 | alert at N → N+1 | alert fires exactly at N (default 3) and at 2N, not between |
| M9 | reset-on-success removed | reset: when a price resolves AND on a successful fill |
| M10 | third source no longer breaks a tie | THIRD SOURCE BREAKS THE TIE |
| M11 | single floor not tighter | single-source floor is TIGHTER: half the band |
| M12 | skip cancels instead of unlocking | skip ⇒ … unlock (active) (+ never cancels an order) |
| M13 | 0 sources → single | ZERO sources ⇒ skip with no price |
| M14 | V3 registry ignored | registered in V3 ⇒ reads the registry's feed |
Keeper suite: origin/main 650 → 717 (+29 sources, +24 order-floor, +13 wiring, +1 eth-usd-feed rewrite = 67). 0 fail.
