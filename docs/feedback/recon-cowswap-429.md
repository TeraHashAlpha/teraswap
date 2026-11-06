# recon/cowswap-429 — CoW 429 standing outage (READ-ONLY recon, 2026-11-06, base main 40d5c52)

- [x] 1 request shape  - [x] 2 live capture  - [x] 3 CoW terms  - [x] 4 history  - [x] 5 volume  - [x] v1/v2 parity

## Root cause: NOT reproducible from our code or my IP -> egress-IP-level limit/block on Vercel (hypothesis, not proven)
- **We send** (`src/lib/adapters/cow.ts` postCowQuoteWithFeeFallback): `POST https://api.cow.fi/{mainnet|base}/api/v1/quote`,
  header names `Content-Type, Accept` ONLY (no UA set -> undici default, no API key, no X-AppId). Body keys: sellToken, buyToken,
  sellAmountBeforeFee, kind=sell, from(=FEE_RECIPIENT on the quote path), appData(`appCode:"TeraSwap"` + partnerFee 10 bps), partiallyFillable,
  sellTokenBalance, buyTokenBalance, signingScheme=eip712. Native ETH mapped to chain WETH. Egress = Vercel serverless IPs (shared AWS pool).
- **Live, production adapter code run unchanged** (tsx, `fetchQuote` ETH->USDC on chain 1 and 8453): both **HTTP 200**, quotes returned.
  Raw curl same body: 200. Burst of 14 parallel quotes (>10 rps doc limit): 14x200, no 429. So request shape/appData/endpoint are fine.
  I could NOT capture a real 429 (no headers/body seen). Only prod evidence is the `[CB]` log: Retry-After honoured -> CoW answers 429 + `Retry-After: 30`.
- **CoW docs** (https://docs.cow.fi/cow-protocol/integrate/api): "Quote requests: 10 requests/second", "Order submission: 5 requests/second",
  "General endpoints: 100 requests/minute"; "429: Rate limited"; "No API key required for basic operations". Per-IP scope, Retry-After,
  appCode-vs-limits, partner keys, v1 deprecation: **not documented** (partners-api page 404; no deprecation/changelog notice found).
  An unverified search snippet mentioned an SDK API-key/partner host (partners.cow.fi) — NOT confirmed by docs; owner should ask CoW.
- **Volume is far below any limit**: breaker allows ~1 probe/30 s per warm instance (<=120/h/instance); monitor GET `/mainnet/api/v1/quote`
  every 60 s tick (60/h); quorum every 15th tick (4/h, skips OPEN sources since ea70eaa). Client quote cache 12 s KV. Limit = 36,000/h. We are not the cause.
- **Monitor is blind**: `health-check.ts` treats any status <500 as ok, so a 429 on the GET probe counts as healthy -> no alert, source looks green.

## History
- 429s from 29 Oct per owner's logs. `e012c49` (2026-10-30) "recon for ... CoW 429 loop" and `ea70eaa` (2026-10-30) added Retry-After + quorum 5->15 ticks
  (mitigations only; they cut OUR volume but the outage persists). cow.ts request code unchanged by those; no @cowprotocol dep in package.json.
  git history of cow.ts is collapsed into merge a382a5a (2026-10-31), so no earlier first-429 date is derivable from git.

## v1 vs v2: identical. No `api.cow.fi` ref under src/ui/v2; both reach CoW only via /api/quote -> fetchMetaQuote -> adapters/cow.ts.

## Premise deviations (recorded, did not block)
- `src/lib/adapters/cowswap*.ts` is `cow.ts`; `src/lib/monitoring/**` does not exist (probes live in `health-check.ts`, `monitoring-loop.ts`, `quorum-check.ts`).
- Not read (outside list): `docs/feedback/fix-monitor-self-source-alerts.md` (prior CoW-429 recon) and Vercel runtime logs — owner may authorise either.

## Proposed fix goal (5 lines)
1. Owner: ask CoW (docs/Discord/support) whether Vercel egress is rate-limited/blocked and obtain a partner key/allowlisting if one exists (env NAME TBD, e.g. `COW_API_KEY`).
2. Capture the real 429 from prod: add one structured log line (status, Retry-After, x-* headers, cf-ray/body<=200 chars) in cow.ts on 429 — no key printed.
3. Set a stable UA/`X-AppId` header; if still 429, route CoW calls via a fixed-egress path (Vercel Static IPs / small proxy) — decide after step 2.
4. Make the monitor treat 429 as degraded for cowswap (probe the real quote or flag 429), so the outage alerts instead of looking green.
5. UI: when Force-MEV and CoW is OPEN, show "MEV source rate-limited" instead of "No MEV-protected quote".

## Risk while shipping without CoW
Among swap-quote sources only CoW is `mevProtected` (the other flagged one is the order engine, not a swap quote): with Force MEV on, every pair on chains 1 and 8453 (and 42161 if enabled) yields no quote; users who want MEV protection get none or silently use unprotected routes.
