# Feedback — fix/cbeth-direct-feed-and-approx-scope

## Feedback — FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE

Spec: `docs/Prompts/FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE.md` (owner `/goal`, transcribed — no
separate Architect packet existed).

---

### 1. The three on-chain readings (required by Task 1 before wiring)

Feed address **derived, not typed**: fetched Chainlink's official reference-data directory
(`feeds-ethereum-mainnet-base-1.json`) and took the canonical ENS-named `cbeth-usd` entry — the same
method `scripts/verify-arbitrum-addresses.mjs` uses, and the discriminator that matters, because the
9V audit once matched the similarly-named `cbeth-eth-exchange` entry by mistake. Directory says
`proxyAddress 0xd7818272B9e248357d13057AAb0B417aF31E817d`, `contractAddress 0x71E021bc…`,
`decimals 8`, `heartbeat 1200` — consistent with the truncated `0xd7818272…` / `agg 0x71E021bc…`
already recorded in `chainlink-feeds.ts:238` and `SPRINT-9V-AUDIT.md`.

Then read on-chain against Base (chainId asserted `0x2105` on both), **two independent RPCs
returning identical values** — `mainnet.base.org` and `base-rpc.publicnode.com`, block ts 1787695639
(2026-08-25):

| call | reading | verdict |
|---|---|---|
| `description()` | `"CBETH / USD"` | matches the required identity |
| `decimals()` | `8` | matches |
| `latestRoundData()` | roundId `36893488147419130468`, answer `278273887800` (= **$2782.738878**), startedAt `1787695390`, updatedAt `1787695403`, answeredInRound `36893488147419130468` | fresh (**236s** old, vs a 1200s heartbeat), answer > 0, `answeredInRound >= roundId` |
| `aggregator()` (extra) | `0x71E021bc2e8a709B72aC7b6036e5B2Bf30F263d0` | equals the directory's `contractAddress` |

Denomination cross-check, which is the reading that actually proves it is USD and not ETH: the
composition it now leads reads `CBETH / ETH` 1.13773235696862 x `ETH / USD` $2445.541902 =
**$2782.33** — **0.015% from the direct feed**. Two feeds never configured to agree, agreeing.

The method is committed and re-runnable: **`node scripts/verify-base-cbeth-feeds.mjs`** (read-only,
public endpoints, no keys). Last run: **ALL CHECKS PASSED** — 3 cbETH directory entries enumerated,
all four Base feeds identity/decimals/freshness/aggregator-verified on both RPCs, direct-vs-composed
0.0075% apart, magnitude guard live-asserted.

---

### 2. Acceptance results

**1 — direct resolution + fall-through.** `resolveFeed(cbETH, 8453)` now returns a THIRD
`ResolvedFeed` shape, `kind:'preferred'` (`primary`, `base`, `quote`). Pinned in
`chainlink-feeds.test.ts` (registry: primary is `CBETH / USD` 8dp, fallback legs unchanged and still
identified; plus a test that cbETH is *not* in the terminal direct map, since a hit there would
short-circuit the composition into dead config). Fall-through pinned in `useChainlinkPrice.test.ts`
and, independently, `chainlink.test.ts` for the server path: **stale** (1801s, one second past the
feed's own 1200x1.5 ceiling), **reverting**, **settled-empty**, and **zero-answer** each fall through
to the composition and price it; 1799s still uses the direct feed. `useChainlinkPrice` gained a
third read slot (leg C), always declared so the hook-call count stays fixed.

**2 — magnitude guard.** Two independent halves. *Registry:* an import-time assert in
`chainlink-feeds.ts` requires every preferred-direct feed to declare a `"… / USD"` identity at 8 dp —
point the map at `0x806b…` (`CBETH / ETH`, 18dp) and the module throws on import, before any read.
*Runtime:* `useChainlinkPrice.test.ts` prices cbETH and Base WETH through the real resolver with the
genuinely-measured on-chain magnitudes and asserts `cbETH >= ETH`, `cbETH <= 2x ETH`, ratio
`1.1379`. A fourth test proves the guard is not vacuous by forcing the exact defect (an
ETH-denominated answer in the USD slot) and showing the price comes back `null`.

**3 — the incident recomputed.** Pinned in `v3-min-price-integrity.test.ts`. Both legs from the SAME
measured snapshot — mixing a live price for one leg with a historical price for the other is the
mismatched-pair mistake that caused the incident:

```
amountIn 3186645813843290 · dcaTotal 3 · 300 bps · both legs 18 dp
priceIn  cbETH = $2782.738878   (DIRECT feed)
priceOut WETH  = $2445.541902   (ETH/USD, same block)

minAmountOut  = 3517247074632108        hasFeed true · source 'chainlink'
IMPLIED RATIO = 1.137882                (incident: 1.853314 — 1.6287x higher)
cross-check: the CBETH/ETH feed's own answer is 1.13773235696862 → 0.013% apart
```

**It lands at market.** And the consequence, which is the number that matters: after the contract's
per-chunk scaling (`OrderExecutorV3.sol:526`, first chunk) the enforced floor is `1172415691544035`
— **0.9754x** the keeper's ~1.202e15 re-quote, i.e. **fillable**, where the shipped order's was
**1.5887x** and could never clear. 516 reverts become 0. A control test at the incident-day prices
(cbETH ~$2204) gives 1.13464, so the result is not an artifact of the day it was measured.

---

### Concern — the ONE deliberate asymmetry, flagged for the Auditor

The spec says a stale or reverting direct feed must fall through. It is silent on an **identity
mismatch**, and I did not treat that as a fall-through case: a reachable feed whose
`description()`/`decimals()` contradict `FEED_EXPECTATIONS` **hard blocks** and is never masked by
the composition, in both the hook and `fetchChainlinkPriceRaw`.

Reasoning: staleness is an *outage* (fall through — an unpriced leg is the incident). An identity
mismatch is an ADR-018 *config/proxy defect* — the whole value of the identity check is that it is
visible, and a fallback that quietly succeeds would bury it indefinitely. It is also literally the
defect shape acceptance 2 exists to catch. The cost is availability: if the direct feed were ever
repointed, cbETH would hard-block rather than degrade to the composition. I believe that is the
right trade on a fund-flow path, but it is a judgment call the spec did not make, so it is the item
I would most want ratified. It is documented at all three sites and pinned by a test in each path.

### Scope — three additions beyond the spec's file list

1. **`.github/workflows/ci.yml`** — added `feed-resolution-guard`, a targeted job for
   `chainlink-feeds` / `useChainlinkPrice` / `chainlink` / `usd-scope-guard`. Neither
   `chainlink-feeds.test.ts` nor `useChainlinkPrice.test.ts` had a named guard job, and this change
   decides which feed prices a signed minimum — the same class `signing-price-integrity-guard`
   already covers arithmetically (INC follow-up 3, same reasoning). `full-suite` also runs them, but
   it is whole-repo, not an individually-named required check. Revert if the Auditor prefers the
   narrower diff.
2. **`scripts/verify-base-cbeth-feeds.mjs`** (new) — the on-chain verification the spec demanded,
   committed rather than performed once and described, per the repo's "the method is the
   deliverable" convention. Not wired into CI (network flakiness), mirroring
   `verify-arbitrum-addresses.mjs`.
3. **`src/lib/order-engine/usd-scope-guard.test.ts`** (new) — #408 made "no table in a SIGNED
   minimum" a compile error by removing the parameters. There is no equivalent compiler expression
   for "no table in a GATE" (any module can import a `Record<string, number>`), so the boundary is
   enforced by a structural test: it scans `src/` for real imports of `APPROX_PRICES`/`fillUsd` and
   fails on any importer outside a display/analytics allowlist.

### Assumption that turned out wrong — the registry comment was factually false

`chainlink-feeds.ts:39-45` asserted "Chainlink publishes only cbETH/ETH on Base". That is wrong (it
predates 9V-M-01) and it is the sentence that made the direct feed look unavailable for two months.
Corrected in place. Related: the same block says the raw cbETH/ETH answer is "~1.08" — it reads
**1.1377** today, so a reviewer sanity-checking against the comment would see a mismatch that is
drift, not a defect.

### Edge case — `resolveFeed`'s preferred branch degrades in two directions, deliberately

A preferred primary whose identity is undeclared (`toLeg → null`) does **not** take the composition
down with it — it falls back to `kind:'composed'`. Symmetrically, a composition with an
unidentifiable leg still yields `kind:'single'` on the primary. Failing closed on one source must
not remove the other, or the fix would reintroduce the unpriced leg it exists to close. Both
directions are in the code path; only the first is exercised by an existing registry state.

### Test gap closed — the structural guard was testing its own reconstruction

`useChainlinkPrice.test.ts`'s registry-wide guard rebuilt the `ResolvedFeed` from
`getChainlinkFeed`/`getComposedFeed` instead of calling `resolveFeed`. It would therefore have
passed for cbETH even if `resolveFeed` had ignored the new registry entirely — testing the
reconstruction, not the resolver. It now calls the genuine resolver (via `vi.importActual`, since
the module-level `vi.mock` replaces that very export) and feeds every leg the resolution names.
`listConfiguredFeedTokens` correspondingly reports the kind a token *resolves to* rather than the
registry it was found in, and dedupes — a direct-preferred token lives in two registries.

### Concern — two test suites were silently unpriced, and one was silently chain-less

`DCAPanel.test.tsx` mocked `useAccount()` with **no `chain`**. `useResolvedChainId` is
`useAccount().chain?.id` with no fallback, so every oracle read in that suite returned "we do not
know which chain this is" → UNREADABLE, for every test, since #370. Harmless while the dust guard
read a constant; not harmless now. Fixed (`chain: { id: 8453 }`, matching the already-mocked
`useChainId`), and the suite now serves real Chainlink reads built from the registry's own declared
identities. `DCAPanel.ux-polish.test.tsx` stubbed `useChainlinkPrice` to `chainlinkPrice: null` for
the same reason and now returns a live price. Both use **$2000**, deliberately not the table's 3500,
so a revert to `APPROX_PRICES` changes the asserted output instead of passing silently.

The behaviour change this exposes is worth stating plainly: at the table's $3500, 0.01 WETH looked
like $35 and the guard allowed **35** buys; at a live $2000 it allows **20**. That is the "lets
chunks through that should be stopped" in the spec, quantified.

### Pre-existing, not fixed here (flagged for the backlog)

- **`src/app/api/analytics/route.ts:189` keeps its OWN copy of `APPROX_PRICES`**, while
  `usd.ts` describes itself as the "single source of truth" so the two dashboards agree. They are
  two hand-edited tables that can drift apart. Display-only on both sides, so out of scope here, but
  the docblock's claim is currently false.
- **`fetchHistoricalPrice` still resolves via `getChainlinkFeed` only**, so it returns null for
  composed AND for direct-preferred tokens. Unchanged and still the correct fail-closed answer (a
  single-leg half price would be worse), but cbETH now *has* a direct feed with full history, so
  supporting it there is newly cheap if anyone wants historical cbETH.
- **`CreateOrderConfig.priceInUsd` is passed only by `DCAPanel`.** `LimitOrderPanel` and
  `ConditionalOrderPanel` do not, so their per-order-floor copy drops the "~$…" suffix and states
  the floor in token units. That is the repo's "never fabricate USD" rule rather than a regression,
  and it is copy on a base-unit gate that is unaffected — but it is a visible UX delta.

### Verification

`npm run typecheck` clean · `npm run lint` **94/94** (unchanged ceiling) · `npm run check:circular`
clean · **full vitest suite: 225 files, 3239 tests, 0 failures** (was 224/3203; +1 file, +36 tests) ·
`node scripts/verify-base-cbeth-feeds.mjs` ALL CHECKS PASSED. No `.sol`, no contract config, no
keeper file touched. Nothing deleted.
