## Feedback — fix/zerox-quote-hygiene

### T1 — telemetry (`quote_build_attempts`, migration `20260912120000_quote_build_attempts.sql`)
Fields: `source`, `chain_id`, `sell_token`/`buy_token` (lowercased), `amount_bucket` (4-sig-fig, same
`quantizeAmount` the meta-quote cache key uses), `outcome`, `request_id`, `wallet` (nullable). Fired
from `fetchSwapFromSource` (api.ts) — every source, not just 0x — via `quote-build-monitor.ts`.
Outcome taxonomy (`built | sim-failed | upstream-error | 429`): `sim-failed`/`upstream-error` reuse
`isTransientSwapError`'s own transient/deterministic split (swap-build-retry.ts) so the two never
disagree. The T3 pre-emptive skip also logs `'429'` — same bucket as a live 429, since it's the same
self-throttle, just applied before the call. Read side: views `quote_build_daily_stats` (attempts
vs confirmed swaps, per source/day — the ratio 0x's warning is actually about) and
`quote_price_source_daily_stats` (unnests `quotes.sources_responded` for /price counts — `log-quote`
already had the data, just not per-source rows).

### T2 — shared cache (`src/lib/meta-quote-cache.ts`)
Key: `quote:cache:v1:{chain}:{src}:{dst}:{amount}:{srcDecimals}:{dstDecimals}:{excludes}` — extracted
verbatim from GET /api/quote (feat/quote-before-wallet), unchanged. **No slippage in the key** —
`fetchMetaQuote`/adapter `fetchQuote` never receive slippage (only swap-build does), so nothing to key
on. TTL 12s (kept, just under `QUOTE_REFRESH_MS`=15s). New: POST /api/quote and GET /v1/quote now go
through the SAME module (previously POST had zero caching, v1/quote too — only GET was wired).
Expected reduction: upstream /price calls collapse to 1 per pair per 12s window **across all three
endpoints combined**, not just within GET.

### T3 — 0x quote-build cap (`kv-rate-limiter.ts`)
8/min, 40/hour per IP (api/swap route) — sized off `SPLIT_MAX_LEGS`=3 (0x occupies ≤1 leg per split
swap) plus a few retried Swap clicks; ~5-8x headroom over real usage. **Not wired into /v1/swap** —
`FEE_INCOMPATIBLE_SOURCES` already rejects 0x as a pinned/auto-selected source there (FeeCollector
can't wrap it), so 0x can never reach `fetchSwapFromSource` via that route; adding the cap there would
be dead code. On exceed: `ZeroXQuoteCapExceededError` → 429 (`ZEROX_QUOTE_CAP_EXCEEDED`), not the
generic 502 — client already has other quotes to pick from.

### T4 — 429-aware breaker (`circuit-breaker.ts`)
A 429 opens the breaker on the FIRST failure (no 3-strike wait), cooldown = `Retry-After` header when
0x sends one (parsed in zerox.ts, embedded as `retryAfterMs=<n>` in the error message — generic
convention, works for any adapter using the same `${source} ${status}` shape), else
`rateLimitCooldownMs`=300s (vs 60s normal).

### Tests
`circuit-breaker.test.ts` (429 describe), `api.zerox-breaker-fanout.test.ts` (open breaker → fan-out
still resolves), `api.fetchSwapFromSource.test.ts` (T1+T3 wiring), `quote-build-monitor.test.ts`,
`meta-quote-cache.test.ts`, plus additions to `api/quote/route.test.ts` (POST cache, GET+POST share),
`v1/quote/route.test.ts` (cache wiring), `api/swap/route.test.ts` (429 mapping).

### Test gap found
`api/quote/route.test.ts`'s "POST chainId coercion" describe had no per-test module/mock reset —
harmless while POST was uncached, but once POST started sharing the KV cache, two tests using the
same src/dst/amount/chainId silently coupled (test 1's cached result answered test 2, leaving a
queued mock rejection unconsumed and leaking into an unrelated later describe via `instanceof` across
a `vi.resetModules()` boundary). Fixed by adding the same `beforeEach` reset every other describe in
that file already has.

### User sees
Nothing different — no UI change, same quotes/swaps returned; only server-side call volume to 0x drops.
