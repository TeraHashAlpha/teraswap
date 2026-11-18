# Tables — fix/catalog-refresh-drops-untrusted

Measured 2026-11-18 on origin/main bfe26155 (committed catalogs) with live CoinGecko / RPC reads.

## 1. Step 0 — the 18 tokens (all already on the site; none is a new candidate)

Fresh list = `tokens.coingecko.com/<platform>/all.json` fetched 2026-11-18 (sizes 5800 / 2857 / 3236 vs 6115 / 2981 / 3283 in the previous run: 88-98%, not a dead list).
"Previous list" = the committed trust fixture had `inTrustedList=true` for all 18. None is a core or hand-pinned token (checked by address against `CORE_TOKENS` and `handCuratedSeedsFor`). 7-day volume: CoinGecko has no coin id for any of the 18 addresses any more, so the catalog's own source cannot return a history (they were delisted, not merely illiquid).

| chain | symbol | address | on site today | sources on site | in previous CG list | in fresh CG list | bytecode / on-chain symbol / decimals | 24h vol on site | 7d vol (CoinGecko history) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | APW | 0x4104b135…60c8 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / APW / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | CRPT | 0x08389495…6d8B | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / CRPT / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | FRM | 0xE5CAeF4A…A68C | yes, verified=true | coingecko+oneinch+trustwallet+defillama | yes (committed trust fixture) | **NO** | yes / FRM / 6 | $46.87 | n/a (no CoinGecko coin id) |
| 1 | KEY | 0x4CC19356…96E7 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / KEY / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | MULTI | 0x65Ef703f…2df4 | yes, verified=true | uniswap+coingecko+oneinch | yes (committed trust fixture) | **NO** | yes / MULTI / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | POLC | 0xaA8330FB…6B37 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / POLC / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | PSTAKE | 0xfB5c6815…7006 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / PSTAKE / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | RGT | 0xD291E7a0…C623 | yes, verified=true | uniswap+coingecko+oneinch | yes (committed trust fixture) | **NO** | yes / RGT / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | TKN | 0xaAAf91D9…E73a | yes, verified=true | coingecko+oneinch+trustwallet | yes (committed trust fixture) | **NO** | yes / TKN / 8 | $0 | n/a (no CoinGecko coin id) |
| 1 | TKX | 0x667102BD…0a88 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / TKX / 8 | $0 | n/a (no CoinGecko coin id) |
| 1 | TONE | 0x2Ab6Bb84…03c4 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / TONE / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | TVK | 0xd084B83C…3988 | yes, verified=true | uniswap+coingecko+trustwallet | yes (committed trust fixture) | **NO** | yes / TVK / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | UFT | 0x0202Be36…3AB1 | yes, verified=true | coingecko+oneinch+trustwallet | yes (committed trust fixture) | **NO** | yes / UFT / 18 | null | n/a (no CoinGecko coin id) |
| 1 | USDN | 0xde17a000…DEE2 | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / USDN / 18 | $0 | n/a (no CoinGecko coin id) |
| 1 | XCAD | 0x7659CE14…6Aa0 | yes, verified=true | coingecko+oneinch+trustwallet | yes (committed trust fixture) | **NO** | yes / XCAD / 18 | $0 | n/a (no CoinGecko coin id) |
| 8453 | PSTAKE | 0x38815A44…3400 | yes, verified=true | superchain+uniswap+coingecko | yes (committed trust fixture) | **NO** | yes / PSTAKE / 18 | $0 | n/a (no CoinGecko coin id) |
| 42161 | LIQD | 0x93C15cd7…174f | yes, verified=false | curated only | yes (committed trust fixture) | **NO** | yes / LIQD / 18 | $0 | n/a (no CoinGecko coin id) |
| 42161 | RGT | 0xef888bcA…4794 | yes, verified=true | arbitrumBridge+uniswap+coingecko | yes (committed trust fixture) | **NO** | yes / RGT / 18 | $0 | n/a (no CoinGecko coin id) |

Why the old pipeline kept them: the 9 `verified=false` rows are curated-only seeds (never dropped by CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS); the 9 `verified=true` rows still have >= 2 external votes (oneinch / trustwallet / uniswap) without CoinGecko, which that policy leaves for "a human decides".

## 2. Reproduction (old pipeline, workflow's own commands, detached worktree at origin/main)

| chain | `tokens:sync` | gate: guard test | gate: other | decision replay on that real output |
|---|---|---|---|---|
| 1 | exit 0, 1389 rows | 15 x `[fatal] trusted-list` = exactly the issue list | `token-catalog.test.ts` size bound: 1389 not < 1000 | removed 17 (15 + DELTA, WHITE the pipeline already dropped silently), 0 left out, guard fatals on result 0 |
| 8453 | exit 0, 521 rows | 1 x `[fatal]` PSTAKE | size bound: 521 not < 500 | removed 1, guard fatals 0 |
| 42161 | exit 0, 608 rows | 2 x `[fatal]` LIQD, RGT | none | removed 3 (LIQD, RGT + waArbezETH pipeline drop), guard fatals 0 |

New pipeline end-to-end, chain 1: decision kept 1377 / removed 17 / left out 0, gate: guard test + json test green, only the size bound red (1377).

## 3. Second blocker found (not part of the goal, not changed)

The 2026-11-16 cron passed the size bound. Since then 1inch's lists grew: chain 1 1074 -> 3205, Base 194 -> 337, Arbitrum 137 -> 5069 entries. Mainnet gets +397 `coingecko+oneinch` tokens (bound < 1000, committed 994), Base +59 (bound < 500, committed 462). The outage breaker only trips on a source SHRINKING. After this fix chains 1 and 8453 still fail the gate at `token-catalog.test.ts`; 42161 has no bound and passes.

## 4. Sample PR body (chain 1, produced from the real pipeline output)

## Tokens removed from the site by this refresh

17 token(s) leave the site when this PR is merged — merging is the decision.

- chain 1 · `APW` · `0x4104b135DBC9609Fc1A9490E61369036497660c8` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `CRPT` · `0x08389495D7456E1951ddF7c3a1314A4bfb646d8B` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `DELTA` · `0x9EA3b5b4EC044b70375236A281986106457b20EF` · dropped by the pipeline: not in any trusted list, 1 external vote(s) &lt; 2 required · 7-day volume n/a
- chain 1 · `FRM` · `0xE5CAeF4Af8780E59Df925470b050Fb23C43CA68C` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `KEY` · `0x4CC19356f2D37338b9802aa8E8fc58B0373296E7` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `MULTI` · `0x65Ef703f5594D2573eb71Aaf55BC0CB548492df4` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `POLC` · `0xaA8330FB2B4D5D07ABFE7A72262752a8505C6B37` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `PSTAKE` · `0xfB5c6815cA3AC72Ce9F5006869AE67f18bF77006` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `RGT` · `0xD291E7a03283640FDc51b121aC401383A46cC623` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `TKN` · `0xaAAf91D9b90dF800Df4F55c205fd6989c977E73a` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `TKX` · `0x667102BD3413bFEaa3Dffb48fa8288819E480a88` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `TONE` · `0x2Ab6Bb8408ca3199B8Fa6C92d5b455F820Af03c4` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `TVK` · `0xd084B83C305daFD76AE3E1b4E1F1fe2eCcCb3988` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `UFT` · `0x0202Be363B8a4820f3F4DE7FaF5224fF05943AB1` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `USDN` · `0xde17a000BA631c5d7c2Bd9FB692EFeA52D90DEE2` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a
- chain 1 · `WHITE` · `0x5F0E628B693018f639D10e4A4F59BD4d8B2B6B44` · dropped by the pipeline: not in any trusted list, 1 external vote(s) &lt; 2 required · 7-day volume n/a
- chain 1 · `XCAD` · `0x7659CE147D0e714454073a5dd7003544234b6Aa0` · guard: trusted-list: address not found in the bundled CoinGecko per-chain list and not in trustedListExempt · 7-day volume n/a

## Candidates left out

None.

## 5. Mutation proof (scratch copy, `refresh-decision.test.ts` + `refresh-workflow.test.ts`, baseline 63/63 green)

| mutant | result |
|---|---|
| M1 removals missing from the PR body | killed (1 failed) |
| M2 cap removed | killed (25 failed) |
| M3 fatal candidate kept, self-check off | killed (35 failed) |
| M3b fatal candidate kept, self-check on | killed (37 failed) |
| M4 left-out list empty | killed (12 failed) |
| M5 dead-upstream check removed | killed (3 failed) |
| M6 workflow PR step drops the sections file | killed (1 failed) |

Property seeds: 1 2 3 7 42 99 1234 2026 31337 86400 (60 random refreshes each). Cap boundaries tested at previous sizes 0 1 19 20 39 40 41 100 399 400 401 419 420 1000 5000 (limit passes, limit + 1 blocks).
