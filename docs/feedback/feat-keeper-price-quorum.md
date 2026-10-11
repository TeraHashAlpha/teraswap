# Feedback — feat/keeper-price-quorum

Goal: DCA floor price QUORUM per fill, per leg (owner decisions 2026-10-11) + scope addition 00:51 WEST
(hard ceiling `DCA_NO_PRICE_FILL_CAP_MAX_USD`, clamp + loud warning, boot upsert `keeper_runtime_config`).

## Checklist
- [ ] C1 sources: `price-sources.js` (chainlink V3 registry → mirror, defillama, coingecko) + tests
- [ ] C2 quorum + skip: `resolveFloorPrice`, constants, executor wiring replaces blind-fill branch
- [ ] C3 28b alignment (not merged → mapping + TODO file:line)
- [ ] C4 tests + mutation table; keeper suite count vs 650
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
