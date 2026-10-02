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
  verified:true"** — a 153-shaped row, this run gets `uniswap`+`coingecko` back →
  `tokens[0].verified === true`, `sources === ['curated','uniswap','coingecko']` ('curated' is
  the seed's own provenance, not a vote — rides along at top source-priority), no longer in
  `unverifiedSeeds`.
- (b)-equivalent — "previously-verified + inTrustedList:false + lost agreement → dropped,
  reported" — already covered by the pre-existing `(a)` test at `build-chain.test.ts:275-299`;
  not duplicated.

NEW `scripts/token-catalog/build.test.ts` (none existed for `build.ts` before). Required
CLI-guarding `build.ts`'s `run().catch(...)` behind `import.meta.url === process.argv[1]` (same
pattern as `scripts/check-product-claims.mjs`) — otherwise importing `seedsFor` for a unit test
would trigger the real network pipeline as an import side effect, which the goal's Do-NOT
(no live `tokens:sync`) rules out:
- **"seedsFor admits every row in the generated catalog, verified or not"** — mocks
  `@/lib/chains/token-catalog.generated` with a synthetic chain id (no overlap with real
  `DEFAULT_TOKENS`/`CURATED_*_SEEDS`) holding one `verified:true` and one `verified:false` row;
  asserts `seedsFor(chainId).size === 2` and both addresses present.
- **"an unknown chain id yields no seeds"** — sanity on the `?? []` fallback.

**Mutation check** (manually re-introduced `if (!t.verified) continue`, reran the full
build.test.ts + build-chain.test.ts suite, then reverted): only the new **seedsFor** test failed
(`seeds.size` 1 not 2), exactly as expected — it is the only test that exercises `seedsFor()`
itself. The pre-existing AND new `build-chain.test.ts` replay tests construct the `seeds`/
`previousCatalog` maps BY HAND and never call `seedsFor()`, so they stayed green under the
mutation — this is precisely why the 42161-shape-replay test already in the suite (added by
`fix/catalog-trust-loss-means-previously-verified`) did not catch the real bug: it proved
`buildChainCatalog` behaves correctly GIVEN the right seeds, but nothing proved `seedsFor()`
ever produced them. 33/33 tests pass with the actual fix in place.

## Evidence 3 — diff stat, full suite, lint, Auditor note

`git diff --stat origin/main` (final, after Commits 1–3):
```
 .../feedback/fix-catalog-seeds-include-unverified-rows.md | 141 +++++++++++++++
 scripts/token-catalog/build.test.ts                       |  61 +++++++
 scripts/token-catalog/build.ts                            |  49 +++---
 scripts/token-catalog/lib/build-chain.test.ts              |  93 ++++++++++
 scripts/token-catalog/lib/category.ts                      |   3 +
 5 files changed, 331 insertions(+), 16 deletions(-)
```

Full suite (`npx vitest run`, whole repo, in this dedicated worktree): **285 test files, 4309
tests, 0 failures** (includes the catalog-pipeline slice: 9 files / 118 tests, up from
`origin/main`'s 8 files / 114 tests — +1 new file (`build.test.ts`, 2 tests) and +2 new tests in
`build-chain.test.ts`, 29→31, verified by grepping `it(` on both revisions).
`npx tsc --noEmit`: clean, 0 errors. `npx eslint . --max-warnings 94`: **94 problems (0 errors,
94 warnings), exit 0** — exactly the repo's existing warning baseline, 0 new warnings introduced
by this branch's 3 files (one `export` keyword, one CLI-entrypoint guard, two comments).

**Auditor note** (no separate Auditor on this branch — restores documented behaviour,
tightening-neutral; recorded here per the goal):
- **Restored**: pre-#517 persistence of unverified continuity seeds across MULTIPLE refresh
  cycles, not just one. `seedsFor()` (`build.ts:~109`) no longer filters `GENERATED_TOKEN_CATALOG`
  rows by `verified` before admitting them as seeds — every committed row is a seed again,
  matching the ORIGINAL (pre-"post-baseline additions persist only while verified") contract that
  `CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS` (`build-chain.ts:85`) was written to police.
- **Stays strict, unchanged**: a previously-verified row that genuinely loses trust (`inTrustedList
  === false` AND `votes < minSources` AND `previousCatalog.verified === true`) is still DROPPED
  and reported (`build-chain.ts:335-355`, `trustLost`/log) — this branch touches none of that
  logic. A brand-new address with no previous row is still FATAL on a failed trusted-list check
  (no seed ⇒ never reaches the continuity path). Cores are still forced
  (`CoreTokenValidationError`) and hand-curated seeds are still exempt — untouched.
- **New in this fix, not previously true**: a seed can now be PROMOTED back to `verified:true`
  on a LATER run after a demotion (it couldn't before, because it was never re-admitted as a
  seed at all past the first demotion) — see the new promotion test.
- Out of scope, flagged for the Architect: 1inch's Arbitrum list contraction (≥201→129, −35%
  between the 2026-09-12 activation build and PR #538/run #17) — the mechanism that demoted the
  153 rows in the first place. No `sourceCounts` baseline existed for chain 42161 before PR #517
  (the field postdates the activation build), so `SOURCE_OUTAGE_RATIO_THRESHOLD` never got a
  chance to fire on it.

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
