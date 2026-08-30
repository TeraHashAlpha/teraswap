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
