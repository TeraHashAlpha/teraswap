# fix/quote-rate-limit-normal-use (**Auditor required**: rate limiting and which route Swap executes)

Owner, production, 2026-11-27: after two token changes "Rate limit exceeded" appears and stays until the Swap tab is
left. Base: origin/main `dae5fd80` (the goal read `5465ceb0`).

Done: step 0 · fix 1 (one request per analysis) · fix 2 (429 cleared and shown) · fix 3 (budget test) · fix 4
(Cloudflare list not stale) · tests failing first · one verify run · push.

## Evidence
**1. Step 0**, `/api/quote` requests/429s, before → after. Real Chromium, production build, unmodified limiter over a fake KV, stubbed upstreams, each action in its own window:
| action | v1 $100 | v2 $100 | v1 $10,000 | v2 $10,000 |
|---|---|---|---|---|
| idle 60 s | 4/0 → 4/0 | 4/0 → 4/0 | 25/8 → 4/0 | 25/8 → 4/0 |
| 5 token changes in 30 s | 5/0 → 5/0 | 5/0 → 5/0 | 27/10 → 10/0 | 27/10 → 10/0 |
| typed digit by digit · flip | 3/0 · 3/0 → same | 3/0 · 3/0 → same | 39/22 · 27/10 → 7/0 · 6/0 | 28/11 · 16/0 → 7/0 · 6/0 |
| 1,234,567 USDC backspaced to 12 | 51/23 → 8/0 | 40/12 → 8/0 | 29/12 → 9/0 | 29/12 → 9/0 |
| two tabs 60 s, both counted | 9/0 → 9/0 | 9/0 → 9/0 | 40/11 → 10/0 | 40/11 → 10/0 |
| 3.3333 ETH retyped fast as 0.0123456 | 122/106 → 1/0 | 1/0 → 1/0 | n/a | n/a |
First 429 before: $10,000 **idle at 31 s, no action** (3 × 12 > 30); $100 only by editing down from a large amount; after: none. **A small amount's other way in (v1 only):** the old large quote sized each half-typed amount, 11 requests a key (67 of the 122 asked ≤ 0.02 ETH). Cloudflare: 15 IPv4 + 7 IPv6 ranges equal the published set (API etag `38f79d050aa027e3be3865e495dcc9bc`): not stale. It stays current **by hand only** (re-copy `cloudflare.com/ips-v4`, `/ips-v6`); no automated check; a missing range puts that edge's users in one bucket.
**2. Root cause** (origin/main): `useSplitRoute.ts:87-175` ran on every `meta.fetchedAt` and every un-debounced `amountIn`, sizing it by whatever quote was on screen (`:61-80`), 11 requests a run (`split-router.ts:60-84`): 12 per 15 s poll against 30/min.
Why it stayed: `useQuote.ts:303-305, 375-396` kept the error and a backoff up to 120 s across pair/amount changes; only `:437-444` (disabled) reset it, and leaving the tab unmounts the hook.
**3. Tests** (+45), each failing on origin/main first: route 8/8 · useQuote 7/7 · wait text 2/2 · split cadence 14/14 (new helpers added, main's hook: 11, 22, 88 requests) · helpers 3/3 (absent) · stale split 3/3 · budget 8/8 (≤ 12 a minute now; back-to-back session 0 429s). 25 seeded quote sets: today's `bestSplit` from 1 request.
**CHANGED EXPECTATION** (`useSplitRoute.test.ts`): the sub-quote URL's amount is the TRADE's, plus `split=1`; cases run a fake clock past the 1.5 s hold (negative cases now stricter). 2 split fixtures gained `fetchedAt`; the parity harness now records toasts. Limiter tests untouched.
**4. Browser** (v1 and v2 alike): split panel absent at 1.2 s, shown by 4.7 s, 1 split request; real bucket filled → "Rate limit exceeded… Retrying in 30s", then 25s; amount change fetched within 1.5 s (429, wait restarted); recovered with no input after 89 s; 0 page errors.
**5. Verify:** one run, `agent-verify.sh --codeql` on code `837b57b5`, load 5.5: **PASS** (11778 tests, 0 failed; lint +0 err, -2 warn; tsc, build, v1-css, parity, rpc-budget; CodeQL 0 new). Keeper SKIP. This docs-only commit follows it.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/quote-rate-limit-normal-use
**NOT verified:** production (never called) · real Upstash, upstreams or client-IP headers · a real wallet (stale-split fallback and split execution: tests only) · Linux CI.

## Owner answers (asked once, 2026-11-27; they supersede the goal text)
1. **Split cost:** QUOTE_RATE_LIMIT stays 30/min. A split call costs 1 unit there plus 1 per sub-quote (11) on a NEW
   `quote-split:` bucket of 66/min. Bucket spent: no error, the split comes later.
2. **Budget test:** each step 0 action gets its own minute, under 15 requests, two tabs counted together; the whole
   back-to-back session has zero 429s. The split starts once the pair and amount have held about 1.5 s.
3. **Split age (owner's own words):** "While a split is the selected route, refresh its analysis with every 15 s poll (one
   batched call), so the sub-quotes execution reads are never older than today. The 60 s rule applies only while no split
   is selected. If Swap is pressed with split sub-quotes older than 15 s (bucket spent), do not execute the split: fall
   back to the single best route and say so in the UI."

Design that follows (mine, forced by 2 + 3): the refresh **rides on the poll** (`/api/quote?…&split=1` answers the
single quote and the sub-quotes). As a separate request, two tabs with a split selected would make 16 a minute. The
60 s refresh rides too. Only a new trade's first analysis (or re-selecting a stale split) is a request of its own. In v2,
the fallback opens the single route's review; in v1 the same press goes down the single path, which has its own review.

## For the owner and the Auditor
- **Owner decision, server-wide limiter:** `globalLimiter` (`rate-limiter.ts:70`, 120 fan-outs/min per instance, ALL
  users; unchanged) counts every sub-quote. One $10,000 tab with a split selected now uses 48 a minute (before: the 30/min
  429 cut it off); one IP can reach about 95 (before 30). About three such users on one warm instance exhaust it, and
  everyone on it then gets 502 "Rate limited: too many requests".
- **Split bucket vs 66:** two tabs on a selected split need 8 analyses a minute, more than 6; so do more than 5 trade
  changes in a minute beside the idle refresh. Deferred refreshes age, and Swap on that tab uses the single route.
- **15 s is exact:** polls are 15 s apart, so when one answers slower than the last, the split reads older than 15 s for
  that difference and a press then falls back (fail closed). No grace was added.
- With a split selected the single quote waits for its sub-quotes (parallel, each bounded 10 s). With Redis hung, a
  split request waits one more 1 s limiter gate than the figure in `route.ts` above `KV_GATE_TIMEOUT_MS`. A split is
  charged even if the main quote then fails. Degraded limiter: 33 split units a minute per instance.
- Excluding a source re-seeds an UNSELECTED split only at its next refresh (≤ 60 s). Sub-quotes never honoured
  exclusions, on main either.
- Recovery after a 429 took 89 s although the window frees at 60 s (30 s then 60 s backoff; `X-RateLimit-Reset` unread).
- Pre-existing, not changed: the split badge reads "+0.17%%" (`SplitRouteVisualizer.tsx:80,93`, `SplitRoutePanel.tsx:27,38`).

## Further reads (the task needed them)
`src/lib/{meta-quote-cache,client-ip-key,rate-limiter,api,fetch-json,kv,quote-identity,executable-sources,mev-preference,circuit-breaker}.ts`,
`src/hooks/{useDebounce,useSplitSwap}.ts`, `node_modules/@upstash/redis` (REST encoding, for the rig's fake KV),
`src/lib/adapters/{kyberswap,velora,shared}.ts`, `src/app/page.tsx`, `src/app/api/CLAUDE.md`,
`src/components/TokenSelector.tsx`, `src/ui/v2/{modals/TokenSheet,__tests__/rpc-budget/*}`, `e2e/third-party-hosts/*`,
`.github/workflows/e2e.yml`, `scripts/agent-verify.sh`.

The step 0 rig (fake Upstash, upstream stub, Chromium driver) ran from the session scratchpad and is not in the repo.
It used the cached Chromium through `PW_CHROMIUM`; nothing was installed beyond `npm ci`.
