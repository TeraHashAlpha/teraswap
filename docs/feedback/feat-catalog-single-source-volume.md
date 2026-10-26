# Feedback — feat/catalog-single-source-volume

Goal: admit a CoinGecko-only token when its 24h USD volume was >= $100,000 on EACH of the last 7 days (owner decision 26 Oct). Pipeline code + tests + docs only; generated catalogs untouched.

## Checklist
- [ ] C1 rule + config (`cfg.singleSource`, verify.ts, throttled market_chart fetcher, build-chain wiring)
- [ ] C2 cap ordering by 7-day median + deferred log, Guard/removal assertions, `--dry-run`
- [ ] C3 fixture table tests + runbook
- [ ] Dry-run 8453 run ONCE (live CoinGecko, read-only)
- [ ] Suite / lint / tsc vs origin/main (baseline 323 files / 5045 tests, lint 93)

## Decisions recorded
- Owner (26 Oct, this session): provenance = optional `admission` object on the catalog row (`{rule, dailyVolumeUsd[7], minDailyVolumeUsd, days}`), no schemaVersion bump.
- `market_chart?days=7` alone returns 169 HOURLY points, not daily (measured 2026-10-26). The fetch adds `&interval=daily`: 7 UTC-midnight points (= the last 7 complete days) + 1 trailing in-progress point, which is dropped.
