# Feedback — fix/catalog-seeds-include-unverified-rows

Triage of PR #538 (run #17, chain 42161 `tokens:sync` refresh, included 281 → 131) found 153 of
the dropped rows are still live (153/153 on CoinGecko's arbitrum-one list today — see the
read-only investigation this branch follows up on). They were verified at the pipeline's
activation build (coingecko+oneinch), lost the oneinch vote in PR #517 (1inch's Arbitrum list
shrank ≥201→129) and were correctly demoted to `verified:false, sources:["curated"]` — kept,
honest ⚠, per `CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS`. But `build.ts`'s `seedsFor()` had
`if (!t.verified) continue` on the post-baseline branch, so an already-unverified row on disk
never became a seed again — dropped BEFORE build-chain.ts's trust-loss policy/breaker/log ever
saw it. Silent: no `removed (trust lost: …)` line, no FEEDBACK, no breaker accounting. `CLEAR`
flipped to unverified in #538 itself and was one refresh away from the same fate.

- [x] C1 `seedsFor()` admits every on-disk row regardless of `verified`; survival decided once,
      in build-chain.ts's existing `CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS` block
- [x] C2 tests: 42161-shape replay (inTrustedList:true variant), promotion case, `seedsFor()`
      unit test, mutation check
- [x] C3 categorizer TODO note (0xBitcoin, no logic change)
- [x] Evidence (hunks, test counts, diff stat, full suite, Auditor note)

## Evidence 1 — the single policy-site fix

`scripts/token-catalog/build.ts` — `seedsFor()` (now exported for the unit test), the
post-baseline loop over `GENERATED_TOKEN_CATALOG[chainId]`:

```diff
   for (const t of GENERATED_TOKEN_CATALOG[chainId] ?? []) {
-    if (!t.verified) continue // post-baseline additions persist only while verified
     push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals })
   }
```

Docblock above it rewritten to name the regression and point at the one place survival is now
decided: `build-chain.ts`'s `CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS` block (`:335-355` on
`origin/main`), which already reads the previously-committed row's `verified` flag from
`deps.previousCatalog` (built independently in `build.ts`'s `previousCatalogFor()`, never
re-derived from `sources`) — not from the seed itself. **No change needed there or in
`verify.ts`'s `assembleCatalog`**: its step 3 ("seeds that never qualified — keep, honest ⚠,
flagged") already does exactly the right thing for a seed that fails to re-qualify, and already
has test coverage proving it (`build-chain.test.ts:399-466`, the pre-existing 42161-shape replay
— it was asserting against a correctly-behaving `buildChainCatalog`, but seeds never actually
arrived at that function hand-built in production, because `seedsFor()` filtered them out one
layer up). `SeedToken` (`types.ts`) needed no new field — nothing downstream re-derives
"previously verified" from a seed; it is read once, from `previousCatalog`.

## Evidence 2 — tests

`scripts/token-catalog/lib/build-chain.test.ts` (existing 42161-shape-replay describe block,
2 new `it`s added):
- **"0 drops: 128 previously-verified rows stay verified, 153 never-verified rows are kept
  unverified despite losing their listing"** — pre-existing, unchanged, still green (confirms
  `buildChainCatalog` itself was never the bug).
- NEW **"…same shape but inTrustedList:true (the real #538 run — the rows never left any
  trusted list, they just lost a vote)"**: 153 rows `verified:false, sources:["curated"]`,
  `inTrustedList:true`, this run's only external vote is `coingecko` (1 < minSources 2) → 0
  drops, 153 `unverifiedSeeds`, 281 included, 128 verified, gate green (`gateFatals([])`).
- NEW **"a previously-unverified seed that regains >=2 votes this run is promoted to
  verified:true"** — one of the 153-shaped rows, this run gets `coingecko`+`oneinch` back →
  `tokens.find(...).verified === true`, `sources` includes both, no longer in `unverifiedSeeds`.
- (b)-equivalent — "previously-verified + inTrustedList:false + lost agreement → dropped,
  reported" — already covered by the pre-existing `(a)` test at `build-chain.test.ts:275-299`;
  not duplicated.

NEW `scripts/token-catalog/build.test.ts` (none existed for `build.ts` before):
- **"seedsFor admits every row in the generated catalog, verified or not"** — mocks
  `@/lib/chains/token-catalog.generated` with a synthetic chain id (no overlap with real
  `DEFAULT_TOKENS`/`CURATED_*_SEEDS`) holding one `verified:true` and one `verified:false` row;
  asserts `seedsFor(chainId).size === 2` and both addresses present.
- **Mutation check**: manually re-introduced `if (!t.verified) continue` and reran both the new
  `seedsFor` test and the new inTrustedList:true 42161-replay test — both failed as expected
  (seedsFor test: size 1 not 2; replay test: 153 rows missing from `result.tokens` instead of 0
  drops). Reverted before committing.

Full counts: see `git diff --stat` and suite run below (Evidence 3).

## Evidence 3 — diff stat, full suite, lint, Auditor note

(filled in after Commit 2/3 — see bottom of this file)

## Commit 3 — categorizer note

0xBitcoin (`0x7cb16cb78ea464ad35c8a50abf95dff3c9e09d5d`, symbol `0xBTC`) is tagged category
"Wrapped BTC" by `category.ts`'s keyword matcher though it is an unrelated, legitimate 2018 PoW
token (not a wrapped-BTC bridge asset, not a scam — confirmed on-chain + on CoinGecko + on the
official Arbitrum bridge list). One-line TODO added at the matching site, no logic changed —
separate triage per the goal's Do-NOT.

## For the Architect

1inch's Arbitrum token list contracted from ≥201 (activation build, 2026-09-12) to 129 raw
entries (PR #538, run #17, 2026-10-02) — a ≥35% drop, and precisely the mechanism that
demoted the 153 rows this branch stops from being erased. No `sourceCounts` baseline existed
for chain 42161 before PR #517 (the field postdates the activation build), so
`SOURCE_OUTAGE_RATIO_THRESHOLD` never got a chance to fire on it. Worth flagging to 1inch or
at minimum backfilling a baseline so the breaker can catch the next contraction.
