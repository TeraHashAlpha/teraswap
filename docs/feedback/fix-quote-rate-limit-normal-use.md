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

## Step 0, before (origin/main `dae5fd80`, production build)
Rig (scratchpad, not in the repo): Chromium → `next start` → the unmodified limiter at 30/min over a fake Upstash REST
store; a server preload answers KyberSwap and Velora and fails every other upstream, so nothing external is called.
Wallet-less visitor. Cells: `/api/quote` requests / 429s, each action in its own limiter window, after "amount entered".

| action | v1 $100 | v2 $100 | v1 $10,000 | v2 $10,000 |
|---|---|---|---|---|
| amount entered (first 8 s) | 2 / 0 | 2 / 0 | 12 / 0 | 12 / 0 |
| idle 60 s | 4 / 0 | 4 / 0 | 25 / 8 | 25 / 8 |
| 5 token changes in 30 s | 5 / 0 | 5 / 0 | 27 / 10 | 27 / 10 |
| amount typed digit by digit (700 ms a key) | 3 / 0 | 3 / 0 | 39 / 22 | 28 / 11 |
| flip, type, flip back | 3 / 0 | 3 / 0 | 27 / 10 | 16 / 0 |
| 1,234,567 USDC deleted to 12, key by key | 51 / 23 | 40 / 12 | 29 / 12 | 29 / 12 |
| two tabs idle 60 s (both counted) | 9 / 0 | 9 / 0 | 40 / 11 | 40 / 11 |
| 3.3333 ETH replaced by 0.0123456, 150 ms a key | 122 / 106 | 1 / 0 | n/a | n/a |

First 429 in one back-to-back session: **$10,000: idle, 31 s in, no action at all** (the third poll: 3 × 12 > 30), v1
and v2. $100: the large-to-small deletion; no other action.

**A small amount reaches the limit one other way, in v1 only.** After a large quote, quick edits keep the old quote on
screen, so `useSplitRoute` reads its USDC output as the trade's value and sends 11 requests per keystroke, for the
half-typed amount: 67 of the 122 requests above asked for 0.02 ETH or less. v2 passes the hook only a quote that
matches the field, and sent 1. A small amount that never passed through a large one never got a 429 in this rig.

## Owner answers (asked once, 2026-11-27; they supersede the goal text)
1. **Split cost:** QUOTE_RATE_LIMIT stays 30/min. A split call costs 1 unit there plus 1 per sub-quote (11) on a NEW
   `quote-split:` bucket of 66/min. Bucket spent: no error, the split comes later. One IP's fan-out ceiling rises from 30
   to about 95 a minute.
2. **Budget test:** each step 0 action gets its own minute, under 15 requests, two tabs counted together; the whole
   back-to-back session has zero 429s. The split starts once the pair and amount have held about 1.5 s.
3. **Split age (owner's own words):** "While a split is the selected route, refresh its analysis with every 15 s poll (one
   batched call), so the sub-quotes execution reads are never older than today. The 60 s rule applies only while no split
   is selected. If Swap is pressed with split sub-quotes older than 15 s (bucket spent), do not execute the split: fall
   back to the single best route and say so in the UI."

Design that follows (mine, forced by 2 + 3): the refresh **rides on the poll** (`/api/quote?…&split=1` answers the
single quote and the sub-quotes). As a separate request, two tabs with a split selected would make 16 a minute.

## Further reads (the task needed them)
`src/lib/meta-quote-cache.ts`, `src/lib/client-ip-key.ts`, `src/lib/rate-limiter.ts`, `src/lib/api.ts` (fetchMetaQuote),
`src/lib/fetch-json.ts`, `src/hooks/useDebounce.ts`, `src/lib/kv.ts`, `node_modules/@upstash/redis` (REST encoding, for
the rig's fake KV), `src/lib/adapters/{kyberswap,velora}.ts` (response shapes for the rig's upstream stub),
`src/components/TokenSelector.tsx` and `src/ui/v2/{swap/TokenButton,modals/TokenSheet}.tsx` (rig selectors),
`e2e/third-party-hosts/{playwright.config,rig,rpc-stub,quote-logging.pw}`, `.github/workflows/e2e.yml`.

## Cloudflare ranges
Fetched 2026-11-27: `cloudflare.com/ips-v4`, `/ips-v6` and `api.cloudflare.com/client/v4/ips` (etag
`38f79d050aa027e3be3865e495dcc9bc`). 15 IPv4 + 7 IPv6 ranges, the same set as `src/lib/cloudflare-ips.ts`. Not stale.
