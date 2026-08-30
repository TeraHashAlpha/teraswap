## Feedback — feat/quote-before-wallet (d6e7867)

### Edge case
- Acceptance #2 ("changing the chain selector without a wallet changes the quote's chain") was
  not satisfiable with the enablement-argument change alone: ChainSelector's disconnected pick was
  local `useState`, never read by `useActiveChainId`. Fix required a small addition beyond the
  listed files — a shared `useDisconnectedChainSelection` zustand store + a new `useQuoteChainId()`
  in `useChainId.ts` (listed), and wiring `ChainSelector.tsx` + `ChainSelector.test.tsx` (not
  listed) to read/write it instead of local state. `useActiveChainId` itself is untouched — its
  ~15 other consumers (balances, approvals, portfolio, swap execution) keep assuming mainnet while
  disconnected; only the quote/browse path (`SwapBox`'s `activeChainId`, `useQuote`) now follows
  the picked chain.

### Concern
- The `/api/spender` fetch effect in `SwapBox.tsx` (keyed on `meta?.best.source`) previously never
  fired while disconnected (meta was always null). It can now fire for a disconnected browsing
  quote. It's read-only and still validated against `isTrustedSpender()` before being stored, so
  no new attack surface, but flagging since it wasn't exercised in the disconnected path before.

### Query enablement (acceptance summary)
- `useQuote` / `useSplitRoute`: now `!isConnected || isCorrectChain` — enabled for a browsing
  visitor with no wallet.
- `useBalance`: unchanged, `isConnected && isCorrectChain && !!tokenIn`.
- Swap button: unchanged — `SwapButton.tsx` gates execution on `isConnected` internally, untouched.

### Cache mechanism + interval
- Shared Upstash-backed cache in `src/app/api/quote/route.ts` (GET only), keyed on the full
  request signature (chain, pair, amount, decimals, excludes). TTL = 12s, chosen just under the
  client's own 15s poll cadence (`QUOTE_REFRESH_MS`) so a cache hit is never staler than what an
  already-open tab would show on its next tick anyway. Fails open on any Redis error/timeout (same
  pattern as the existing halt/rate-limit gates) — a cache outage degrades to "no caching", never
  to a broken quote. It's a general cache (not landing-specific), so it transparently absorbs
  whichever query is hottest — in practice the landing's fixed 0.5 ETH -> USDC default pair.

### Acceptance results
1. No wallet + amount ⇒ quote renders — `SwapBox.test.tsx` asserts `useQuote`'s 4th arg is `true`
   while disconnected (fails if `isConnected` returns to the condition).
2. Chain selector changes the quote's chain while disconnected — `useChainId.test.ts` pins
   `useQuoteChainId()` following `useDisconnectedChainSelection`; `ChainSelector.tsx` writes to
   that same store.
3. `useBalance` + swap button stay wallet-gated — `SwapBox.test.tsx` asserts `useBalance`'s
   `query.enabled` is `false` disconnected / `true` connected.
4. Landing widget and SwapBox share one quote path — `LandingPage.test.tsx` asserts `SwapPreview`
   calls the same mocked `@/hooks/useQuote`, for ETH/USDC/'0.5'.
5. Cache: `route.test.ts` — 5 identical GETs produce 1 `fetchMetaQuote` call; first request tagged
   `X-Quote-Cache: miss`, subsequent identical ones `hit`; a different amount is a separate key
   (still fetches live); a KV read failure fails open (still returns a live quote).
6. Full suite: 3474/3476 passing (2 pre-existing failures in `scripts/grok-dispatch.test.mjs`,
   unrelated — that script/test wasn't touched by this branch). Lint: 94/94 warnings (repo
   ceiling, unchanged from `origin/main` baseline). Typecheck: clean.

---

## Feedback — process-local dampener follow-up (c960fa9)

### Mechanism
Two process-local, in-memory structures in `route.ts`, consulted only AFTER a KV cache miss/error
(so a healthy Upstash never touches either — the KV cache stays the one and only primary path):

1. **In-flight coalescing** (`inFlightQuotes: Map<key, Promise>`) — the primary mechanism, per the
   goal's own framing ("collapsing identical in-flight requests is worth more than any counter").
   N concurrent requests for the same cache key share the ONE upstream `fetchMetaQuote` call
   already in progress instead of firing N. Race-free: the check-then-set is synchronous (no
   `await` in between), so no interleaving is possible on Node's single-threaded event loop.
2. **A short local result cache** (`localQuoteDampenerCache`, TTL 5s) — catches sequential (not
   strictly concurrent) repeats during an outage, e.g. a burst of landing-page loads a few seconds
   apart rather than in the same tick.

### Bound + justification
`DAMPENER_TTL_MS = 5_000`, chosen against two existing constants:
- **`QUOTE_CACHE_TTL_SECONDS` (12s, the KV cache TTL added earlier on this branch)** — 5s is
  deliberately less than half of it. This is what makes acceptance #3 true by construction: the
  dampener's own cache always expires well before the KV TTL would have, so it can never be the
  reason a visitor sees something staler than the KV cache already permits — it only narrows the
  staleness window during an outage, never widens it.
- **`QUOTE_REFRESH_MS` (15s, the client's own poll cadence, `src/lib/constants.ts`)** — 5s is a
  third of it, so any staleness this introduces during a Redis outage is smaller than what a
  single already-open tab already tolerates between its own polling ticks.
- **`QUOTE_RATE_LIMIT` (30 req/60s per IP, `kv-rate-limiter.ts`)** — deliberately NOT a factor in
  the bound. That's a per-identity abuse control; this dampener is identity-blind cost dampening
  for redundant upstream fan-out on the SAME query shape, from any IP. The two are orthogonal and
  this change touches neither the limit's values nor its logic.

### Acceptance results
1. `route.test.ts` — with both `kv.get` and `kv.set` throwing on every call, 5 concurrent identical
   requests produce exactly 1 `fetchMetaQuote` call (test asserts `< N`, actual is 1). A companion
   test proves this is keyed coalescing, not global serialization — two concurrent but DIFFERENT
   amounts still produce 2 upstream calls.
2. `route.test.ts` — with Upstash healthy (fake KV, no forced failure), a second identical request
   is still served as a plain KV `hit` (not a dampener path), with the upstream-call count
   unchanged (still 1 after the first miss) — pinning that the KV path is untouched.
3. `route.test.ts` (fake timers) — same request at t=0 (miss, 1 call), t=3s (served by the local
   dampener cache, still 1 call, header `miss-dampened-local-cache`), t=6s (dampener's own TTL
   expired — refetches fresh, 2 calls) — all still well inside the KV's 12s TTL window, proving the
   5s bound sits strictly inside it rather than reaching or exceeding it.
4. Full suite: 3478/3480 passing (same 2 pre-existing, unrelated `grok-dispatch.test.mjs`
   failures as before — untouched by this change). Lint: 94/94 warnings (unchanged ceiling).
   Typecheck: clean.

### What this dampener does NOT guarantee
It is per-instance, in-memory, uncoordinated cost dampening only — it resets on every cold
start/restart, provides no cross-instance coordination (N warm instances can still each make their
own upstream call for the same query), and is not a rate limit, a security boundary, or any kind of
guarantee; `QUOTE_RATE_LIMIT` remains the only per-identity abuse control and is completely
unchanged.
