# Token catalog — single-source volume admission

**Decision:** owner, 2026-10-26. **Code:** `scripts/token-catalog/lib/{config,verify,fetch-sources,build-chain,dry-run}.ts`.

## Rule

A token listed by exactly **one** external source — in practice CoinGecko only — is admitted to the catalog when its
24h USD volume was **≥ $100,000 on each of the last 7 complete UTC days**. Tokens with ≥ 2 sources keep the existing
rules untouched (`minSources` 2, `lowLiqMinSources` 3, `requiredSourceForNew`). The on-chain catalog guard, the
symbol-conflict rules and the core/curated protections still apply to an admitted token.

Everything else is fail-closed: any history that cannot be read (HTTP error after retries, malformed payload, no
CoinGecko coin id, fewer than 7 complete days) means **not admitted this run**, counted in the run summary
(`fetch failed` / `below floor`). The rule only ever adds tokens: an existing catalog row is never removed by it.

## Parameters (`scripts/token-catalog/lib/config.ts`)

| Key | Default | Meaning |
|---|---|---|
| `singleSource.enabled` | `true` | master switch (`false` = exactly the pre-rule behaviour) |
| `singleSource.minDailyVolumeUsd` | `100_000` | per-day floor, USD |
| `singleSource.days` | `7` | number of complete UTC days checked |
| `singleSource.requireEveryDay` | `true` | every day ≥ floor. `false` = the **median** of the window must clear it |
| `singleSourceByChain[chainId]` | `{}` | partial override merged over the default, e.g. `{ 8453: { minDailyVolumeUsd: 250_000 } }` |

**Raise / lower the threshold:** edit `minDailyVolumeUsd` (globally, or per chain in `singleSourceByChain`), run
`npm run tokens:sync -- --dry-run` with `TOKENS_SYNC_CHAINS=<chain>` to preview the admissions, then ship the config
change in a normal PR. The next scheduled refresh applies it. **Emergency off:** `enabled: false` (or per chain);
rows already admitted stay in the catalog as unverified seeds on the next run — nothing is removed.

## Data and rate limits

`GET https://api.coingecko.com/api/v3/coins/{id}/market_chart?vs_currency=usd&days=7&interval=daily` — keyless, **one
coin per call**. `interval=daily` is required: without it the API returns ~169 *hourly* points for `days=7`. The 7
UTC-midnight points are the 7 complete days; the trailing "now" point is dropped.

- Throttle: ≥ 6 s between calls (10/min — inside the keyless tier's documented ~5–15/min), strictly sequential.
- Backoff on 429 / 5xx / network error: 15 → 30 → 60 → 120 s (`Retry-After` honoured if longer), 5 attempts, then the
  token is "fetch failed". Other 4xx fail at once.
- A cheap pre-filter first: only single-source tokens whose **current** 24h volume (one `/coins/markets` batch of 250)
  is ≥ the floor get a history call. Run time ≈ 6 s × (candidates passing the pre-filter) + backoffs.
- No API key is read or sent anywhere.

## Provenance in the catalog

Admitted rows carry an optional `admission` object (absent on every two-source row; no `schemaVersion` bump):

```json
"admission": { "rule": "single-source-volume", "dailyVolumeUsd": [/* 7 values, oldest → newest */], "minDailyVolumeUsd": 100000, "days": 7 }
```

`verified: true` on such a row means *one source + the volume rule + on-chain guard*, not ≥ 2-source agreement.

## New-token cap

`maxNewTokensPerChain` (1: 400, 8453: 250, 42161: 220) still applies. When it binds: two-source tokens rank first
(today's order), single-source admissions fill the remaining slots by **descending 7-day median volume**, and the
deferred ones are logged (`single-source deferred by the new-token cap …`) and listed in the run summary. Tokens
already in the catalog are seeds, not "new", so they never count against the cap on later runs.

## Preview (`--dry-run`)

`TOKENS_SYNC_CHAINS=8453 npm run tokens:sync -- --dry-run` runs the full pipeline against live sources + RPC reads but
writes **nothing** (no catalog, no trust fixture). It prints, per chain: candidate / pre-filtered / history-call
counts, rule verdicts, would-ship and cap-deferred counts, the top 20 by 7-day median, and (Base) the ETHFI line.

## Known risks

- Volume can be wash-traded; $100k/day for 7 days is a cost, not a proof. The on-chain guard and the ticker rules
  (a single-source token cannot take a ticker held by a seed/core, and loses ties to better-sourced tokens) bound the damage.
- The first scheduled refresh after merge may add ~100–200 rows per chain in one PR; review it like any catalog PR (the PR body carries the Guard result).
