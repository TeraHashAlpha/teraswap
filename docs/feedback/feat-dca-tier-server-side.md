# Feedback — feat/dca-tier-server-side

**Scope.** Owner-accepted reads/edits beyond the list (asked in-session): `origin/feat/keeper-price-quorum`
`price-sources.js` + `order-floor.js` (READ-ONLY; absent on origin/main — Commit 3's premise was false until answered);
7 DCAPanel tests (`arbitrum-gates`, `chain-availability`, `native-out-signs-weth`, `nofeed-consent`, `nofeed-fail-closed`,
`oracle-fail-closed`, `v3`) and `orders-floor-consent.test.ts` (price-source mock only). **Merge order: 29 (this) before
33 (keeper quorum).** If the keeper changes `QUORUM_TOLERANCE_BPS` / `MAX_PRICE_AGE_SEC`, the pin test fails loudly.

## 1. Endpoint — `GET /api/dca-floor-cap?chainId&tokenIn&tokenOut`
Same path, rate limit, `Cache-Control: public, max-age=60`; 30 s cache per (chainId,in,out), lowercased. Classifier =
`classifyDcaFloorDetailed`, which `classifyDcaFloor` (the create route's) wraps. 400 on non-`0x`+40-hex or one-sided pair;
classifier failure → 200 `unpriced`, legs null, not cached. Without the pair: legacy shape, unchanged.
`{"tier":"offchain-price","legs":{"in":{"registered":true,"priced":true},"out":{"registered":false,"priced":true}},"registeredFeedCount":3,"effectiveCap":250,"max":250,"maxUsd":250,"effectiveUsd":250}`
(`effectiveCap`/`max` as specified; legacy `maxUsd`/`effectiveUsd` kept for the dialog's existing consumers.)

## 2. Browser calls removed
DCAPanel no longer imports the classifier: no registry read, no DefiLlama call for classification (`pair-floor-info.ts` only
fetches the endpoint). Start disabled until answered; error/5xx/bad shape → `unpriced`. Confirm reuses the acked tier (no
refetch); the server accepts ack ≥ its tier. Order-row badges already render the persisted SERVER tier (`order.floorTier`) — unchanged.

## 3. CSP — `coins.llama.fi` KEPT
DCAPanel still calls `fetchDefiLlamaPrice` (lines ~550/555) for its own live-price/floor preview, not classification:
`grep -rln "fetchDefiLlamaPrice\|coins.llama.fi" src` → `DCAPanel.tsx` is the only `'use client'` consumer (the rest are API routes / libs).
Removing it would break the preview. CoinGecko is server-only and not in the CSP (asserted).

## 4. Quorum (Auditor 29a #7)
`offchain-price` ⇔ DefiLlama AND CoinGecko both fresh (≤600 s, ≥−300 s skew, dated) and spread ≤300 bps; 1 source or
disagreement → `unpriced` = the keeper's single/skip exactly. Unchanged: the chain's WETH counts as priced (Chainlink).
Pin: `dca-price-quorum.test.ts` — frozen literals; regex+value vs `order-floor.js` once it defines them (skipped on today's
main); and `git show origin/feat/keeper-price-quorum:…` when that ref exists locally (ran, passes).

## 5. Tests (+25: 4372 → 4397)
route +6 (shape, same-classifier spy+equivalence, junk→400, throw→200 unpriced, cache key/TTL, legacy shape) · quorum +12
(2 agree; 1 source ×5; disagree; tolerance edge; same-vendor; stale/undated/future; unmapped chain; cache; spreadBps; 3 pin) ·
tier 3→5 (single, disagree) · panel +5 (no llama/RPC fetch + 0 registry reads; disabled until tier; error→unpriced ×2;
grammar; Base WETH→UNI names only UNI — UNI picker added to the mock). Mutations: fail-open on error → 1 UI fail; route
`onchain-feed` on throw → 1 fail. Judgment call: Commit 3 left 3 panel tests red until Commit 4 (stub price source); no commit is pushed alone.

## 6. Verification
Suite 291 files / 4396 pass + 1 skipped (pin); origin/main 290 / 4371 pass + **1 failed** (not investigated; main run in a
worktree with symlinked `node_modules`). `git diff --stat origin/main`: 20 files, +870 / −82. Lint 0 errors / 94 warnings = main. `tsc --noEmit` clean. No keeper, 409-rule or persistence change.

## Feedback — CodeQL js/request-forgery (dca-price-quorum.ts)

### Edge case
- `normalizeAddress()` lowercases at the route boundary, so the classifier now receives lowercase addresses instead of "as given" (checksummed). The classifier and caches were already case-insensitive; the one test asserting "as given" now asserts lowercase.
- DefiLlama's `slug:address` key keeps a literal `:` (each half encoded) so the URL is byte-identical to before; CoinGecko query order is unchanged.

### Concern
- Fix verified locally (4401 tests, tsc, eslint clean). CodeQL goes green only once it re-scans the pushed commit; alert is not dismissed.

## Feedback — CI full-suite "1 skipped" (dca-price-quorum.test.ts)

### Edge case
- The skip was the BRANCH pin (`git show origin/feat/keeper-price-quorum:…`), not the tree pin — CI full-suite log (run 38156091300, `8dbce34`): tree pin ✓, branch pin ↓. #560 merged and the remote branch is deleted, and CI checks out `fetch-depth: 1`, so that ref never exists there: the test was permanently dead. Removed it; the tree pin (now on main) is the single source of truth.
- Tree pin is now unconditional (no `skipIf`): mutations verified — `QUORUM_TOLERANCE_BPS` 300→301 → AssertionError; `price-sources.js` removed → ENOENT. Both fail, neither skips.

### Concern
- Locally the branch pin RAN and passed (0 skipped) because a stale remote-tracking ref `origin/feat/keeper-price-quorum` survived the remote delete — a test whose outcome depends on local ref state hides CI skips. Avoid `git show <remote-branch>` pins.
