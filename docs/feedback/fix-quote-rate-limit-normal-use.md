# fix/quote-rate-limit-normal-use

Owner, production, 2026-11-27: after two token changes on the swap screen "Rate limit exceeded" appears and stays until
the Swap tab is left and reopened. Base: origin/main `dae5fd80` (the goal read `5465ceb0`).

## Checklist
- [ ] Step 0: measure /api/quote per minute and per action (v1 + v2, $100 and $10,000), name the first 429
- [x] Step 0: compare `src/lib/cloudflare-ips.ts` with Cloudflare's published ranges
- [ ] Fix 1: split analysis = one request, on pair / settled-amount change, then at most once per 60 s
- [ ] Fix 2: pair / amount / chain change clears the 429 backoff and stale error; the wait is shown and ends by itself
- [ ] Fix 3: budget rule as a test (under 15 /api/quote requests a minute, no 429)
- [x] Fix 4: Cloudflare list (not stale, no change)
- [ ] Tests that fail on origin/main first
- [ ] One `scripts/agent-verify.sh` run on the last code commit; push

## Further reads (the task needed them)
`src/lib/meta-quote-cache.ts`, `src/lib/client-ip-key.ts`, `src/lib/rate-limiter.ts`, `src/lib/api.ts` (fetchMetaQuote),
`src/lib/fetch-json.ts`, `src/hooks/useDebounce.ts`, `src/lib/kv.ts`, `node_modules/@upstash/redis` (REST encoding, for
the rig's fake KV), `src/lib/adapters/{kyberswap,velora}.ts` (response shapes for the rig's upstream stub),
`src/components/TokenSelector.tsx` and `src/ui/v2/{swap/TokenButton,modals/TokenSheet}.tsx` (rig selectors),
`e2e/third-party-hosts/{playwright.config,rig,rpc-stub,quote-logging.pw}`, `.github/workflows/e2e.yml`.

## Cloudflare ranges
Fetched 2026-11-27: `cloudflare.com/ips-v4`, `/ips-v6` and `api.cloudflare.com/client/v4/ips` (etag
`38f79d050aa027e3be3865e495dcc9bc`). 15 IPv4 + 7 IPv6 ranges, the same set as `src/lib/cloudflare-ips.ts`. Not stale.
