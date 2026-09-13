# Feedback — fix/token-search-ranking-squatting

### Ranking rule (3 lines)
1. Exact case-insensitive symbol match outranks a substring match (unchanged from #451).
2. Among **same-symbol** matches (the squatting case), higher `liquidityUsd` wins — unknown/null
   ranks above a *confirmed* zero (never below it) — then CoinGecko trusted-list membership.
3. Otherwise (different symbols — e.g. USDC vs USDC.e, native/bridged pairs), falls back to
   `sources.length` as before; liquidity never reorders them since they aren't duplicates.

Liquidity floor: **$100,000** 24h volume (`LOW_LIQUIDITY_FLOOR_USD`, `src/lib/chains/tokens.ts`),
pinned to match the pipeline's existing `liquidityFloorUsd` (`scripts/token-catalog/lib/config.ts`).
Clones below it that share a symbol with a higher-liquidity match are demoted under a "low
liquidity / unverified" divider in `TokenSelector.tsx` (never hidden).

### Task 2 — volume, and a concern
Root cause: `MarketSignal.volume24hUsd` existed in the type since the pipeline's introduction but
**no fetcher ever populated it** — only DefiLlama's `/prices/current` (price+confidence, no volume)
was wired up. Fixed via a new `makeVolumeFetcher` (CoinGecko `/coins/list?include_platform=true`,
fetched once and memoized, mapped to `/coins/markets` `total_volume`, batched 250 ids/call — the
per-address `simple/token_price` endpoint caps free-tier calls at 1 address each, unusable at
catalog scale). `assembleCatalog` now persists `volume24hUsd`/`volumeSource`/`volumeFetchedAt`
(explicit `null` triple, never a `0`) on every row. Verified live (network): mainnet 698/1240,
Base 273/285, Arbitrum 182/447 populated (was 0/0/0 everywhere).

**Concern (did not commit the regenerated catalogs):** a full live `tokens:sync` run grew mainnet
842→1240 addresses (+399/-1) and Base 259→285 (+26/0) — NOT from a bug, but because (a) mainnet/Base
hadn't been regenerated since 2026-07-01 (external tokenlists + DefiLlama's price-confidence gate —
pre-existing, untouched by me — drifted for 2+ months) and (b) the sticky-seed design (every
verified token becomes a permanent future seed) ratchets monotonically on every run. This blew past
the existing `token-catalog.test.ts` `<1000` mainnet-size guard AND `catalog-address-guard.test.ts`
(5 pre-existing trusted-list-fatal seeds surfaced: KITE/MV/sUSD on mainnet, IDRISS/KAT on Base).
I reverted the 3 generated JSONs + `catalog-guard.trust.json` to `HEAD` — address-set hashes are
therefore **unchanged** (see below). Recommend a separate, reviewed regen PR; this is a pipeline-wide
non-determinism issue, bigger than this fix's scope.

Address-set hashes (sha256 of sorted lowercase addresses, first 16 hex) — before **and** after this
PR, since the committed catalogs are untouched: `1`=`b1c323da481bdf41` (842 addresses),
`8453`=`602b7408fc1f2c19` (259), `42161`=`f62478f831c05da7` (227, unmerged PR #500's own commit —
untouched by me either).

### Task 3 — USDC.e root cause
`docs/feedback/feat-arbitrum-token-catalog-pipeline.md` records USDC.e (normally 5 external votes)
falling to "insufficient-sources" once mid-run, then hard-pinning it into `CURATED_ARBITRUM_SEEDS`
as a workaround. Root cause (code-level, not reproducible on demand — it's an external transient):
each source fetch is a single 30s-timeout HTTP call with no retry; `Promise.allSettled` means ONE
failed call (DNS blip / rate limit / TLS reset) zeroes that source's votes for the **entire chain**,
not just one token. Landing on Arbitrum (fetched last of 3 chains, after hundreds of RPC calls for
mainnet+Base) increases exposure to exactly this kind of window. `retainFlakySeeds` (new, generic)
now protects every token this way — not just the one manually pinned — while still requiring full
agreement for genuinely-new candidates.

### Tests added
`src/lib/chains/tokens.test.ts`: LAPTOP-squatter ranking + demotion, native/bridged non-squatting,
null-vs-zero-liquidity ordering, trusted-list tie-break, floor-value assertion, solo/no-clear-winner
non-demotion. `scripts/token-catalog/lib/build-chain.test.ts`: growth-cap uses real volume (not
alphabetical), volume/provenance/null persistence, retain-on-flake (3 cases: retains + logs, never
retains a brand-new candidate, never retains a real delisting).

### Pre-existing, not touched
`TokenSelector.test.tsx` "wallet connects while a non-matching chain was picked" already fails on
unmodified `origin/feat/arbitrum-token-catalog-pipeline` (LINK is in `ARBITRUM_SUGGESTED_SYMBOLS`,
contradicting the test's expectation) — unrelated to this fix, left as-is.
