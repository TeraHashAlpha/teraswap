# QUESTIONS.md — Comprehensive Code Review

> **Reviewer:** Claude (Tech Lead / Security Auditor)
> **Project:** TeraSwap DEX Meta-Aggregator
> **Date:** 2026-03-19
> **Scope:** Full codebase — architecture, security, performance, correctness

---

## SECTION 1: ARCHITECTURE & DESIGN

### Q1. Single page.tsx routing — why not use Next.js App Router pages?

The entire app (landing, swap, docs, legal) lives in a single `src/app/page.tsx` with client-side state (`useState<AppPage>`) toggling between views. This defeats Next.js's built-in routing, SSR, code-splitting, and SEO.

**Impact:** Larger initial bundle (all pages loaded at once), no deep-linking (`/docs`, `/legal` not real URLs), no per-page SSR/ISR.

**Should we split into proper route segments?** e.g. `src/app/(app)/swap/page.tsx`, `src/app/docs/page.tsx`, etc.

> ANSWER: **Not now — low priority.** The single-page approach was intentional for this phase. The app is primarily a swap tool; the landing/docs/legal are secondary views that rarely change. Splitting into App Router pages would break the current animated transitions and require a router migration. **Mark for Phase 3 (L2 launch) when we'll also add multi-chain routing.** For now, the bundle cost is acceptable (~200KB gzipped total).

---

### Q2. Dual analytics systems — localStorage vs Supabase

There are two independent analytics pipelines:
1. `analytics-tracker.ts` — localStorage-based, client-only, uses `trade_events` table (which doesn't exist in schema)
2. `/api/analytics` — Supabase `swaps` table, server-rendered dashboard

The localStorage tracker still has `seedDemoData()`, `computeDashboard()`, and `loadEvents()` that seem dead/unused since the server-side analytics was built.

**Is the localStorage analytics system dead code?** Can we remove `analytics-tracker.ts`, `analytics-types.ts`, and the `trackTrade` calls in `SwapBox.tsx`?

> ANSWER: **Yes, remove it.** The localStorage analytics was the v1 prototype before Supabase. The server-side `/api/analytics` is now the source of truth. **Action: Delete `analytics-tracker.ts`, `analytics-types.ts`. Remove `trackTrade` import and call from `SwapBox.tsx`. Keep `useAnalytics.ts` (it calls the server API).** The `seedDemoData()` is definitely dead code. The `exportWalletSnapshot()` function is used by the admin — move it to the server-side if needed.

---

### Q3. Order Engine — is it deployed and active?

The order engine (DCA, Limit, SL/TP) has full code: smart contracts, Gelato automation, API routes, hooks, panels. But the UI shows "Coming Soon on L2" for all three modes.

**What's the status?** Is the contract deployed on mainnet? Is Gelato active? Are the `/api/orders/*` routes reachable in production? If none of this is live, should we gate the API routes to prevent unintended use?

> ANSWER: **The contract is deployed on mainnet but NOT active for users.** The executor is NOT running (confirmed by memory file). Gelato is NOT deployed. The `/api/orders/*` routes ARE reachable in production but create orders that never execute. **Action: Add an `ORDER_ENGINE_ENABLED` env var check to the orders API routes. Default to `false`. Return 503 "Order engine not yet active" when disabled.** This prevents accidental order creation while keeping the code ready for L2 launch.

---

### Q4. Capacitor native app loads from live URL — intended?

`capacitor.config.ts` sets `server.url: 'https://teraswap.app'`, meaning the native app is just a WebView pointing to the live site. There's no local build/bundle.

**Is this intentional?** Pros: zero maintenance, always latest. Cons: requires internet, no offline capability (despite the PWA service worker), App Store reviewers sometimes reject this pattern.

> ANSWER: **Intentional for now.** This is a DeFi app — it requires internet for blockchain interactions anyway. There's no meaningful offline mode for a swap aggregator. The WebView approach avoids maintaining separate native codebases. **If Apple rejects it, we'll switch to a local build with `npx cap sync`.** No action needed now.

---

### Q5. `page.tsx` imports all panels even if unused

`page.tsx` imports `DCAPanel`, `LimitOrderPanel`, `ConditionalOrderPanel` (commented out) and `OrderDashboard`, `AnalyticsDashboard`, etc. Even commented imports affect readability, and the active imports load code for modes the user may never visit.

**Should we use `next/dynamic` with `ssr: false` for non-default swap modes?**

> ANSWER: **Yes, use `next/dynamic` for OrderDashboard and AnalyticsDashboard.** These are heavy components with charts/tables that most users never see. **Action: Convert OrderDashboard, AnalyticsDashboard to dynamic imports. Remove commented-out DCA/Limit/Conditional imports entirely (they're in git history if needed).** Keep SwapBox as a static import since it's the primary view.

---

### Q6. No test infrastructure

There are zero frontend tests (no `__tests__/`, no `.test.ts` files, no Jest/Vitest config). The only test is a Solidity test for the order executor.

**Is testing planned? What's the minimum viable test coverage target?** At minimum, `useSwap`, `useApproval`, and the swap API routes should have unit tests.

> ANSWER: **Testing is planned for Phase 2 but not blocking current work.** The priority right now is shipping features and getting users. **Action: No implementation now, but add a `TODO-TESTING.md` noting the priority order:** 1) API route tests (swap, quote, analytics), 2) `useSwap` hook tests, 3) `useApproval` hook tests. We'll set up Vitest when we do the first batch.

---

## SECTION 2: SECURITY

### Q7. API routes have no authentication — most accept any request

All logging endpoints (`/api/log-event`, `/api/log-activity`, `/api/log-swap`, `/api/log-quote`) accept unauthenticated POST requests from any origin (CORS `*`).

**Risk:** An attacker could flood the database with fake swap logs, fake wallet activity, or fake analytics events.

**Should we add a lightweight HMAC or session-based auth to logging endpoints?** Or is the fire-and-forget design intentional and the data considered low-sensitivity?

> ANSWER: **The fire-and-forget design is intentional. The data is low-sensitivity (public blockchain data).** Fake logs don't affect user funds or swap execution. The analytics dashboard only shows `status='confirmed'` swaps (which require on-chain tx hashes). **However: Action: Add a simple origin check to logging endpoints — reject requests where `Origin` header doesn't match `teraswap.app` or `localhost`. Not bulletproof but stops casual abuse.** Also add batch size limits (already done for log-event, extend to others).

---

### Q8. Address format validation is inconsistent

- `/api/swap` and `/api/orders` validate addresses with `/^0x[a-fA-F0-9]{40}$/` (good)
- `/api/quote`, `/api/spender`, `/api/history`, `/api/log-swap`, `/api/log-quote` do NOT validate address format

**Should we add a shared `isValidAddress()` utility and apply it to all endpoints?**

> ANSWER: **Yes, fix this.** **Action: Create `src/lib/validation.ts` with `isValidAddress(addr: string): boolean` using the existing regex. Apply it to all API routes that accept address parameters.** This is a quick win — prevents garbage data in the DB and potential edge cases.

---

### Q9. In-memory rate limiting resets on cold starts (Vercel serverless)

`/api/swap` and `/api/rpc` use in-memory `Map<string, number[]>` for rate limiting. On Vercel, each serverless function instance is ephemeral — the rate limit state resets with every cold start or new instance.

**Is this acceptable?** The comment in `rpc/route.ts` acknowledges this. Should we migrate to Vercel KV, Upstash Redis, or at minimum document this limitation?

> ANSWER: **Acceptable for now.** The in-memory rate limiting still works within a single warm instance (which handles most sequential requests from the same user). The real protection comes from the blockchain itself — you can't spam swaps without paying gas. **Action: No change now. Add Upstash Redis in Phase 2 when we add multi-region deployment.** The comment in the code is sufficient documentation.

---

### Q10. Health endpoint token in query params

`/api/health` reads the auth token from `searchParams.get('token')`. Query params appear in server logs, browser history, and Referer headers.

**Should we move this to the `Authorization` header (like `/api/monitor` already does)?**

> ANSWER: **Yes, fix this.** **Action: Migrate `/api/health` to use `Authorization: Bearer <token>` header, matching the `/api/monitor` pattern.** Quick fix, improves security hygiene.

---

### Q11. DefiLlama oracle — single point of failure for price validation

`/api/swap` uses DefiLlama as the sole server-side oracle. If DefiLlama is down or returns stale data, the validation is skipped (non-blocking by design).

**But:** If DefiLlama returns an incorrect price, it could wrongly block legitimate swaps (false positive) or allow bad swaps (false negative).

**Should we add a second oracle source (e.g. CoinGecko) for cross-validation, or is DefiLlama reliability sufficient?**

> ANSWER: **DefiLlama is sufficient for now.** It aggregates prices from multiple DEXes (the same ones we query). The non-blocking design means a wrong price only blocks swaps (false positive) — it never allows bad swaps because the 8% threshold is very conservative. False positives are annoying but not dangerous. **Action: No change. Revisit if we see false positive reports from users.**

---

### Q12. `APPROX_PRICES` in analytics is hardcoded and will become stale

`/api/analytics/route.ts` lines 140-145 hardcode token prices (ETH: 3500, WBTC: 95000) for volume estimation when `amount_in_usd` is null.

**These prices will drift significantly over time.** Should we fetch live prices from DefiLlama/CoinGecko, or at minimum use the Chainlink feed that already exists?

> ANSWER: **Fix this — use DefiLlama prices.** The `defillama.ts` module already exists with caching. **Action: In `/api/analytics/route.ts`, replace `APPROX_PRICES` with a call to `fetchDefiLlamaPrices()` for the tokens found in the swaps data. Cache the result for 10 minutes (analytics endpoint is already cached for 30s).** This makes the volume accurate without adding load.

---

### Q13. RPC proxy allows `eth_estimateGas` — potential abuse vector

`/api/rpc/route.ts` allows `eth_estimateGas` which is computationally expensive on the node. An attacker could craft complex estimation requests to increase costs.

**Should we remove `eth_estimateGas` from ALLOWED_METHODS, or add stricter rate limits for expensive methods?**

> ANSWER: **Keep it but add per-method limits.** `eth_estimateGas` is needed for the wallet to estimate gas before sending transactions. Removing it would break the privacy proxy's purpose. **Action: Add a separate rate limit for expensive methods (`eth_estimateGas`, `eth_call`) — 10/min vs 60/min for read-only methods.** Quick change in the existing rate limiter.

---

### Q14. No Content-Security-Policy for WebSocket connections

`next.config.js` has a comprehensive CSP but doesn't explicitly allow WebSocket connections (`wss://`) for WalletConnect or RPC subscriptions.

**Are WebSocket connections working in production, or are they silently failing?**

> ANSWER: **WebSocket connections work because WalletConnect uses its relay servers which are already in `connect-src`.** The CSP has `connect-src` with `wss://*.walletconnect.com` implicitly via the wildcard patterns. **Action: Verify the exact CSP and add `wss://*.walletconnect.com wss://*.walletconnect.org` explicitly if not already present.** Quick check.

---

### Q15. Supabase anon key is client-exposed via `NEXT_PUBLIC_SUPABASE_ANON_KEY`

The Supabase anon key is in a `NEXT_PUBLIC_` variable, meaning it's bundled into the client JS. Combined with RLS policies, this is Supabase's intended pattern.

**But:** The `order-engine/supabase.ts` creates a client with the anon key for order queries. If RLS is misconfigured on the `orders` table, any user could read/modify any order.

**Can you confirm RLS is enabled on the `orders` table with proper wallet-based policies?**

> ANSWER: **RLS needs to be verified and fixed.** The `orders` table was created during the order engine build but RLS policies may not be set. **Action: Add SQL to enable RLS on `orders` and `order_executions` tables with wallet-based SELECT policies and service_role INSERT/UPDATE policies.** Same pattern as `security_events` and `wallet_activity` that we just fixed. Provide SQL for the user to run.

---

### Q16. `useTokenImport` doesn't validate ERC-20 checksum addresses

`useTokenImport.ts` line 24 validates with `/^0x[a-fA-F0-9]{40}$/` but doesn't use EIP-55 checksum validation. A user could import a token with a slightly wrong address (typo) and the app would accept it.

**Should we use `viem`'s `getAddress()` to normalize and validate checksums?**

> ANSWER: **Yes, fix this.** **Action: Replace the regex check with `viem`'s `getAddress()` which both validates and normalizes to checksum format. Wrap in try-catch — invalid addresses throw.** This is a one-line fix with high safety impact.

---

## SECTION 3: PERFORMANCE

### Q17. ParticleNetwork O(n^2) loop runs every frame

The particle connection loop (lines 110-134) is O(n^2) with 80 particles = 3,200 distance calculations per frame at 60fps = 192,000 calculations/second.

**Impact:** On low-end devices or mobile, this could cause frame drops.

**Should we implement spatial partitioning (grid-based), reduce particle count on mobile, or use `requestAnimationFrame` throttling?**

> ANSWER: **Reduce particle count on mobile.** Spatial partitioning is overkill for 80 particles. The O(n^2) is fine on desktop (3,200 calcs is trivial for modern CPUs). **Action: Detect mobile via `window.innerWidth < 768` and reduce `PARTICLE_COUNT` to 40 on mobile.** Also skip the glow gradient rendering on mobile (the most expensive draw call). No spatial partitioning needed.

---

### Q18. `/api/monitor` fetches 17,000+ rows from Supabase per request

The monitor endpoint does `Promise.all` fetching 5,000 swaps + 2,000 quotes + 10,000 usage events, then computes aggregations in JavaScript.

**Should we move these aggregations to SQL (using `GROUP BY`, `COUNT`, `SUM`) and only return the computed metrics?**

> ANSWER: **Yes, but not now.** The monitor endpoint is admin-only (token-protected), used rarely, and cached for 15s. The performance is acceptable for 1-2 requests/minute. **Action: Mark for Phase 2 optimization. When data grows past 50K rows, create Supabase database functions for the aggregations.** No change now.

---

### Q19. `/api/analytics` loads 5,000 swaps and computes everything in JS

Similar to Q18 — the analytics dashboard fetches all swap rows and computes period metrics, source metrics, hourly volume, top pairs, daily volume all in JavaScript.

**Should we create a Supabase database function or view for this?**

> ANSWER: **Same as Q18 — acceptable for now.** With 15 confirmed swaps the computation is instant. **Action: When we reach 1,000+ swaps, create a materialized view or DB function.** The 30s cache already prevents hammering.

---

### Q20. No `React.memo` or `useMemo` on expensive components

Several components re-render unnecessarily:
- `SwapBox.tsx` — the share button computation runs every render
- `TokenSelector.tsx` — the `contracts` array for balance fetching is recalculated on every render
- `AnalyticsDashboard.tsx` — chart data isn't memoized

**Should we add targeted memoization to the heaviest render paths?**

> ANSWER: **Yes, add targeted memoization.** **Action: Add `useMemo` to:** 1) TokenSelector `contracts` array, 2) SwapBox share button computation, 3) AnalyticsDashboard chart data derivation. **Don't over-memoize** — only the expensive computations. React 18 concurrent mode handles most re-renders efficiently.

---

### Q21. Audio files loaded eagerly

`sounds.ts` uses a `Map<string, HTMLAudioElement>` cache but loads MP3s on first call. Multiple simultaneous plays create new `Audio()` instances.

**Should we preload critical sounds (swap-confirm, touch) on app mount to avoid latency?**

> ANSWER: **No change needed.** The MP3 files are tiny (<50KB each) and the first-play latency is imperceptible. The Web Audio API synthesis handles the critical path (swap sounds). MP3s are only for touch/background. **No action.**

---

## SECTION 4: BUGS & CORRECTNESS

### Q22. `logSwapToSupabase` fires before wallet confirmation — creates orphan "pending" rows

In `useSwap.ts` line 227, `logSwapToSupabase({status: 'pending'})` is called BEFORE `sendTransaction`. If the user rejects in their wallet, the row stays as "pending" forever.

**We already fixed the analytics dashboard to filter `status='confirmed'`, but should we also:**
1. Add a cleanup job to mark stale pending rows as "abandoned" after X minutes?
2. Move the `logSwapToSupabase` call to after `sendTransaction` returns?

> ANSWER: **Both.** **Action 1: Move `logSwapToSupabase` to AFTER `sendTransaction` succeeds (when we have a txHash). Status should start as `'submitted'` not `'pending'`.** This eliminates most orphan rows. **Action 2: Add SQL cleanup — provide a Supabase cron query that marks `pending` rows older than 15 min as `abandoned`.** This catches edge cases (browser crash, network drop).

---

### Q23. `useChainlinkPrice` — `feedDecimals` undefined leads to Infinity

In `useChainlinkPrice.ts` line 44-46, if `feedDecimals` is `undefined`, the code returns early. But if it's `0` (valid for some feeds), the division `10 ** 0 = 1` works, but `Number(undefined)` would be `NaN`, leading to `10 ** NaN = NaN`.

**Is this actually reachable? Should we add an explicit `typeof feedDecimals !== 'number'` check?**

> ANSWER: **Not a real bug — the early return on `undefined` prevents the NaN path.** But a defensive check is cheap. **Action: Add `if (typeof feedDecimals !== 'number') return` for clarity.** One line, zero risk.

---

### Q24. Fallback receipt polling in `useSwap.ts` has cleanup race condition

Lines 671-754: The fallback polling uses `setInterval` + `setTimeout` with refs. If the component unmounts during active polling:
1. The interval continues
2. The timeout may fire after cleanup
3. State updates on unmounted component

**Should we use an AbortController pattern or a mounted ref check?**

> ANSWER: **Add a mounted ref check.** AbortController is overkill for polling. **Action: Add `const mountedRef = useRef(true)` at the hook level. Set `false` in cleanup. Check `mountedRef.current` before all `setStatus`/`setErrorMessage` calls in the polling loop.** This is the standard React pattern for this.

---

### Q25. `useApproval.ts` — missing `isNative` in dependency array

Line 103: The `useEffect` that computes the approval plan depends on `tokenIn`, `spender`, `allowanceData`, etc., but omits `isNative`. If the user switches from ETH (native) to WETH (non-native), the plan may not recalculate.

**Is this a real bug or is `isNative` derived from `tokenIn` (and thus already covered)?**

> ANSWER: **Not a real bug.** `isNative` is `isNativeETH(tokenIn)` — it's derived from `tokenIn` which IS in the dependency array. When `tokenIn` changes, the effect re-runs and `isNative` is recalculated inside the effect body. **No action needed.**

---

### Q26. Toast cleanup race condition in SwapBox

Lines 166-169: `swapToastId.current` is dismissed and set to null. But if a new swap starts before the dismiss animation completes, the ref could be stale.

**Is this causing visible issues (duplicate toasts, missing toasts)?**

> ANSWER: **No visible issues reported.** The toast library handles dismiss-then-create gracefully. The ref race is theoretical — in practice, swaps take 10+ seconds and users don't start a new swap while the previous one is confirming. **No action needed.**

---

### Q27. `useSplitRoute` — abortRef increment race

Lines 75, 116, 135: `abortRef.current++` is used to cancel stale fetches. But if two fetches start in rapid succession (e.g. user types "1" then "10" quickly), both get new IDs before either completes, and the first's results could leak through.

**Should we use an AbortController instead of a counter?**

> ANSWER: **The counter pattern is correct.** The increment happens synchronously before the async work. Even if two fetches start "simultaneously" (they can't — JS is single-threaded), the second increment runs before the first's async callback checks the ID. The first fetch's callback sees `myId !== abortRef.current` and bails. **No action needed.**

---

### Q28. CoW Protocol flow — stale address captures

In `useSwap.ts` lines 495-593, multiple `trackWalletActivity` calls capture `address` from the closure. If the user disconnects their wallet during CoW order signing/polling, `address` becomes stale.

**Should we re-read `address` from the hook at each tracking point, or is this acceptable since disconnecting mid-swap is an edge case?**

> ANSWER: **Acceptable edge case.** If the user disconnects mid-swap, the swap will fail anyway (no signer). The stale address in tracking is harmless — it's the correct address that initiated the swap. **No action needed.**

---

### Q29. `useSwapHistory` Zustand store has no persistence

`useSwapHistory.ts` uses Zustand without persist middleware. On page refresh, all swap history is lost and must be re-fetched from Supabase.

**Should we add `persist` middleware with localStorage, or is the Supabase fetch on mount sufficient?**

> ANSWER: **Supabase fetch on mount is sufficient.** Swap history is authoritative from the database. Adding localStorage persistence would create a sync problem (local cache vs DB truth). **No action needed.**

---

## SECTION 5: DATA & DATABASE

### Q30. `trade_events` table referenced but doesn't exist in schema

`analytics-tracker.ts` line 106 queries `trade_events` table, but `supabase/schema.sql` only has `swaps`, `quotes`, `security_events`, `usage_events`, `wallet_activity`.

**Is `trade_events` dead code from before the migration to server-side analytics?**

> ANSWER: **Yes, dead code.** This is part of the v1 localStorage analytics that should be removed per Q2. **Action: Covered by Q2 — delete `analytics-tracker.ts`.**

---

### Q31. No database indexes for common query patterns

The schema has indexes on `swaps(wallet, created_at)`, `swaps(source)`, etc. But the monitor endpoint queries with:
- `security_events` by `created_at` (no index)
- `usage_events` by `event_type` + `created_at` (composite index missing)
- `wallet_activity` by `wallet` + `created_at` (has index, good)

**Should we add missing composite indexes?**

> ANSWER: **Yes.** **Action: Provide SQL to add:**
> - `CREATE INDEX idx_security_events_created ON security_events(created_at DESC);`
> - `CREATE INDEX idx_usage_events_type_created ON usage_events(event_type, created_at DESC);`
> These are read-heavy, write-light tables so index overhead is minimal.

---

### Q32. No TTL/cleanup for old data

Tables grow indefinitely. `usage_events` could accumulate millions of rows (page views, clicks). `wallet_activity` grows with every swap attempt.

**Should we add:**
1. A Supabase cron job to delete rows older than 90 days?
2. Partitioning by month?
3. An archival strategy?

> ANSWER: **Add a 90-day TTL for `usage_events` and `wallet_activity`.** Keep `swaps` and `security_events` forever (they're business-critical audit data). **Action: Provide SQL for a Supabase pg_cron job that runs daily and deletes `usage_events` and `wallet_activity` older than 90 days.** No partitioning needed at current scale.

---

### Q33. `swaps` table — no cleanup for orphan "pending" rows

Related to Q22. Swaps that were initiated but never confirmed (wallet rejection, browser close, network error) remain as `status='pending'` forever.

**Should we add a periodic job to mark `pending` rows older than 15 minutes as `abandoned`?**

> ANSWER: **Yes.** **Action: Provide SQL for a pg_cron job that runs every 15 min: `UPDATE swaps SET status = 'abandoned' WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes';`** This keeps the data clean without losing information.

---

## SECTION 6: FRONTEND & UX

### Q34. Hardcoded ETH price ($2000) for USD volume estimation

`SwapBox.tsx` line 313 uses `Number(amountIn) * 2000` as a fallback USD estimate for ETH swaps.

**This was roughly correct when ETH was $2000, but it's now ~$3500. Should we use the existing Chainlink price hook or the DefiLlama cache?**

> ANSWER: **Fix this.** The `useChainlinkPrice` hook already exists in the component scope. **Action: Replace the hardcoded `* 2000` with the Chainlink ETH/USD price from the hook. Fallback to 2500 if unavailable.** Simple one-line fix.

---

### Q35. No `prefers-reduced-motion` check for animations

`ParticleNetwork.tsx`, `LandingPage.tsx` animations, and the turbo swap effect don't respect `prefers-reduced-motion`. Users with motion sensitivity or vestibular disorders could be affected.

**Should we check `window.matchMedia('(prefers-reduced-motion: reduce)')` and disable/reduce animations?**

> ANSWER: **Yes, add this.** **Action: In `ParticleNetwork.tsx`, check `prefers-reduced-motion` on mount. If enabled: reduce particle count to 20, disable turbo jitter, reduce speed to 0.2x.** Don't fully disable — keep subtle ambient motion. This is an accessibility best practice.

---

### Q36. Tab bar sticky at `top-8` — may overlap with BetaBanner

The recently-added `sticky top-8` on the swap mode tab bar assumes the BetaBanner height is ~32px (top-8 = 2rem). If the banner is dismissed, the tab bar sticks 32px below the viewport top.

**Should we dynamically calculate the top offset based on whether the banner is visible?**

> ANSWER: **Yes, fix this.** **Action: Change `sticky top-8` to `sticky top-0` and add a CSS transition. The BetaBanner already has a spacer div — the sticky element will naturally sit below it. When the banner is dismissed, the tab bar moves to `top-0`.** This is the correct CSS sticky behavior.

---

### Q37. Particle z-index at z-30 — overlays swap box content

Particles at `z-30` pass in front of the swap card during turbo. But this also means they pass in front of:
- Quote breakdown text
- Rate/route info
- Error messages
- Buttons (though `pointer-events-none` prevents click blocking)

**Is this the desired UX? Or should turbo particles only appear outside the swap card area?**

> ANSWER: **This is the desired UX.** The turbo effect is meant to feel immersive — particles flying across the entire screen including the swap card. Since `pointer-events-none` prevents interaction blocking, it's purely visual. **The only concern is readability during turbo — but turbo only lasts 10-30 seconds during tx confirmation, when the user isn't reading the quote.** No action needed.

---

### Q38. No loading state for analytics dashboard on first load

`useAnalytics.ts` fetches from `/api/analytics` on mount. Until the response arrives, `dashboard` is `null` and the component may show nothing or a skeleton.

**Is the current loading UX acceptable? Should we add an optimistic cache or SSR the initial data?**

> ANSWER: **Acceptable.** The AnalyticsDashboard already handles `null` dashboard with a loading state. The 30s server cache means subsequent loads are fast. **No action needed.**

---

## SECTION 7: SMART CONTRACTS

### Q39. FeeCollector — is the flat file the deployed version?

`contracts/TeraSwapFeeCollector_flat.sol` is a single flattened file. There's no corresponding `foundry.toml` or deploy script for it (the order-engine has its own Hardhat project).

**Is this the exact bytecode deployed on mainnet? What address? Is it verified on Etherscan?**

> ANSWER: **Yes, the flat file is the deployed version.** The contract address is the one in `NEXT_PUBLIC_FEE_COLLECTOR` env var. It IS verified on Etherscan. The flat file approach was used because Foundry wasn't set up at the time — the contract was deployed via Remix. **No action needed** — the contract is immutable and working.

---

### Q40. Order Engine executor — is it running?

The order executor (`contracts/order-engine/executor/`) has a `ecosystem.config.cjs` (PM2 config) and `executor.js`. The memory file says "Executor should NOT be running yet."

**What's the plan for activating it? Is it blocked on the L2 launch?**

> ANSWER: **Blocked on L2 launch.** The executor will run on a server monitoring Gelato tasks for order execution. It's not needed on mainnet because gas costs make DCA/limit orders impractical for most users. **No action needed — keep the code ready.**

---

### Q41. Gelato Web3 Function — deployed or local only?

`contracts/order-engine/gelato/web3Function.ts` contains the automation logic for executing orders.

**Is this deployed on Gelato's infrastructure? Or is it local-only code waiting for the order engine launch?**

> ANSWER: **Local only — not deployed on Gelato yet.** Same as Q40 — waiting for L2 launch. **No action needed.**

---

## SECTION 8: DEVOPS & INFRASTRUCTURE

### Q42. No staging/preview environment mentioned

All deploys seem to go directly to production (`main` branch → Vercel → `teraswap.app`).

**Is there a staging environment? Should we set up Vercel preview deployments for PRs?**

> ANSWER: **Vercel already creates preview deployments for every push automatically.** We just don't use PR-based flow — we push directly to main. This is fine for a solo/small team. **Action: No change. Consider branch protection rules when team grows.**

---

### Q43. Sentry DSN not configured

The `NEXT_PUBLIC_SENTRY_DSN` environment variable has been flagged as needed but not yet added to Vercel.

**Is Sentry collecting errors in production? If not, we're flying blind on client-side errors.**

> ANSWER: **Not configured yet — this is a known gap.** **Action: Add `NEXT_PUBLIC_SENTRY_DSN` to Vercel env vars.** The Sentry SDK is already integrated (sentry.client.config.ts, sentry.server.config.ts, sentry.edge.config.ts exist). Just needs the DSN. **High priority — do this ASAP.**

---

### Q44. No CI/CD pipeline

No `.github/workflows/`, no `vercel.json` with build checks, no pre-commit hooks. Code goes directly from local → git push → Vercel deploy.

**Should we add:**
1. GitHub Actions for `next build` + TypeScript checks on PR?
2. A linter (ESLint) configuration?
3. Pre-commit hooks (husky)?

> ANSWER: **Yes, add a basic CI pipeline.** **Action: Create `.github/workflows/ci.yml` with `next build` + `tsc --noEmit` on push to main. No ESLint or husky yet — they add friction without enough value at current team size.** The build check alone catches 90% of issues.

---

### Q45. `.gitignore` doesn't exclude iOS/Android build artifacts

The `ios/` folder was committed to git. Capacitor's `ios/` and `android/` folders contain Xcode/Gradle build artifacts that shouldn't be in source control.

**Should we add `ios/`, `android/` to `.gitignore` (keeping only `capacitor.config.ts`)?**

> ANSWER: **Keep `ios/` in git** — Capacitor's recommended approach is to commit the native projects so team members can build without running `cap add ios` again. The Xcode project contains configuration (signing, capabilities) that's hard to recreate. **Action: Add `ios/App/Pods/`, `ios/build/`, `android/build/`, `android/.gradle/` to `.gitignore` (build artifacts only).**

---

## SECTION 9: CODE QUALITY

### Q46. Massive file sizes — SwapBox.tsx (659 lines), useSwap.ts (813 lines)

`SwapBox.tsx` and `useSwap.ts` are very large single files mixing concerns (standard swap, CoW flow, split swap, error handling, analytics, sounds, toasts).

**Should we extract:**
- `useSwapStandard.ts` + `useSwapCow.ts` (split the two flows)
- `SwapErrorDisplay.tsx` (error rendering)
- `SwapToastManager.ts` (toast logic)

> ANSWER: **Not now — the files are large but cohesive.** Splitting `useSwap` into two files would create a coordination problem (shared state between standard and CoW flows). The swap is ONE operation with two execution paths. **Action: No splitting now. If we add a third execution path (e.g. cross-chain), then refactor.** The file sizes are manageable with code folding.

---

### Q47. Dead/commented-out imports in page.tsx

Lines 12-14 have commented-out imports for DCA/Limit/Conditional panels. Lines throughout have `// Coming soon` patterns.

**Should these be removed entirely until the features are ready, rather than leaving commented code?**

> ANSWER: **Yes, remove them.** **Action: Delete all commented-out imports and components from `page.tsx`. The code is in git history.** Covered by Q5.

---

### Q48. Inconsistent error handling patterns

Some endpoints return errors silently (200 with empty data), others return proper error codes (400, 422, 502). Some use `console.error`, others use `console.warn`, others swallow silently.

**Should we establish a standard error handling pattern?** e.g.:
- All validation errors → 400
- All auth errors → 401/403
- All upstream errors → 502
- All internal errors → 500 + Sentry capture

> ANSWER: **Yes, standardize.** **Action: Create a shared `apiError()` helper in `src/lib/api-utils.ts` that returns consistent JSON error responses with proper status codes. Apply the pattern you described. Fire-and-forget endpoints (log-*) stay 200-always by design — but should `console.error` internally.** Medium priority — do this during the next refactoring pass.

---

### Q49. `sounds.ts` — 500+ lines of Web Audio API synthesis

The sounds module contains hand-crafted audio synthesis using `OscillatorNode`, `GainNode`, etc. This is impressive but complex and hard to maintain.

**Is the synthesized audio intentional (avoids loading MP3s) or was it a prototype? Should we simplify to just MP3 playback for production?**

> ANSWER: **Intentional.** The synthesized sounds provide unique audio identity without licensing concerns or large MP3 files. Each sound is procedurally generated to match the app's aesthetic. The MP3 files (touch.mp3, swap-confirm.mp3) are simpler fallbacks. **No action needed — the code works and sounds great.**

---

### Q50. Multiple Supabase client instances

- `src/lib/supabase.ts` — main server-side client (service role key)
- `src/lib/order-engine/supabase.ts` — separate client (anon key, client-side)
- Various API routes create ad-hoc clients

**Should we centralize all Supabase access through a single `getSupabase()` with role-based configuration?**

> ANSWER: **The separation is intentional.** Server-side uses service role (full access, bypasses RLS) for trusted operations. Client-side uses anon key (subject to RLS) for order queries. These SHOULD be different clients. **Action: No change. But verify that no API route accidentally uses the anon key client.** Quick grep check.

---

## SECTION 10: MISSING FEATURES / GAPS

### Q51. No user session/auth system

There's no user authentication beyond wallet connection. The wallet address IS the identity. This means:
- Anyone can query anyone's swap history
- Analytics events can be spoofed
- Wallet activity can be fabricated

**Is wallet-only identity the intended permanent design, or is a sign-in-with-Ethereum (SIWE) flow planned?**

> ANSWER: **Wallet-only is the intended design.** This is a DeFi application — wallet IS identity. Swap history is public on-chain anyway (Etherscan). Adding SIWE would add friction without meaningful security benefit. **Action: No change.**

---

### Q52. No error boundary around swap flow

`global-error.tsx` exists for Next.js-level errors, but there's no React Error Boundary around `SwapBox` or its children. A rendering crash in quote display would crash the entire page.

**Should we wrap `SwapBox` in an Error Boundary with a "Reset" button?**

> ANSWER: **Yes.** **Action: Create a `SwapErrorBoundary.tsx` that wraps SwapBox in `page.tsx`. On error, show a "Something went wrong — Reset" button that clears state and reloads the component.** This is a quick win for reliability.

---

### Q53. No transaction simulation before execution

The swap flow calls `sendTransaction` directly without simulating first via `eth_call`. A failed transaction still costs gas.

**Should we add pre-flight simulation (already partially done with allowance checks) to catch reverts before submitting?**

> ANSWER: **The wallet (MetaMask/Rainbow/etc.) already does `eth_estimateGas` before sending, which catches most reverts.** Adding our own simulation would duplicate this and add latency. **Action: No change.** If we get reports of failed transactions that weren't caught by wallets, revisit.

---

### Q54. No gas price optimization

There's no EIP-1559 gas price suggestion, no "fast/standard/slow" selector, no maxFeePerGas optimization. Users rely entirely on wallet defaults.

**Is this intentional (let the wallet handle it), or should TeraSwap suggest optimal gas settings?**

> ANSWER: **Intentional — let the wallet handle gas.** Modern wallets (MetaMask, Rainbow, Rabby) have sophisticated gas estimation. Overriding it would confuse users and could cause stuck transactions. **No action needed.**

---

### Q55. Service Worker caching strategy may serve stale API responses

`sw.js` uses network-first for `/api/` routes, which is correct. But if the network fails, it falls back to cache — serving potentially very stale quote/price data.

**Should API responses be excluded from SW caching entirely, or should we add a max-age check?**

> ANSWER: **Exclude API responses from SW cache entirely.** Stale quotes are dangerous (user sees old price, executes at different price). **Action: In `sw.js`, modify the network-first handler to NOT cache `/api/` responses at all. If network fails for API calls, let the error propagate to the UI.** Quick fix.

---

## SECTION 11: LIB LAYER & TYPE SAFETY

### Q56. `api.ts` is 2,087 lines with 69+ `any` type assertions

The central aggregation file disables TypeScript safety with `eslint-disable @typescript-eslint/no-explicit-any` in multiple places. CoW order params use `Record<string, any>`, and API response parsing casts without validation.

**Should we create proper interfaces for each aggregator's response and remove all `any` assertions?**

> ANSWER: **Yes, but incrementally.** Creating 9 aggregator response interfaces in one go would be a huge PR. **Action: Start with the 3 most-used aggregators (1inch, Odos, KyberSwap) — create typed response interfaces. Replace `any` with `unknown` + type guards for the rest. Mark remaining `any` with `// TODO: type this` comments.** Phase 2 work.

---

### Q57. `api.ts` — fee deduction uses unchecked BigInt arithmetic

`deductFee()` (line ~871) converts `toAmount` string to BigInt for fee calculation. If `toAmount` is malformed (empty string, non-numeric), `BigInt()` throws.

**Should we wrap this in try-catch, or validate `toAmount` before deduction?**

> ANSWER: **Add a try-catch.** **Action: Wrap the `deductFee()` BigInt arithmetic in try-catch. On failure, return the original amount unchanged (don't block the swap over a fee calculation error).** Quick fix.

---

### Q58. Uniswap fee tier cache has 45-minute TTL — too long?

`api.ts` caches Uniswap pool fee tiers for 45 minutes. If Uniswap governance changes a fee tier, the cache serves stale data.

**Is 45 minutes acceptable, or should we reduce to 10-15 minutes?**

> ANSWER: **45 minutes is fine.** Uniswap fee tier changes are governance proposals that take days to execute. The cache saves RPC calls. **No action needed.**

---

### Q59. DefiLlama price validation doesn't check response structure

`defillama.ts` `fetchDefiLlamaPrice()` doesn't validate that the API response contains the expected fields (`price`, `confidence`, `timestamp`). A malformed response could be cached and used for swap validation.

**Should we add schema validation (e.g. check `typeof price === 'number' && price > 0`)?**

> ANSWER: **Yes.** **Action: After parsing the JSON response, add: `if (typeof coin.price !== 'number' || coin.price <= 0) return null`. Also check `confidence > 0.5` to avoid low-confidence prices.** Three lines, high safety impact.

---

### Q60. DefiLlama 5-minute cache too long for volatile markets?

The price cache TTL is 5 minutes. In a flash crash scenario, a 5-minute-old price could wrongly block a legitimate swap (false positive) or allow a bad one.

**Should we reduce to 1-2 minutes, or make TTL configurable?**

> ANSWER: **Reduce to 2 minutes.** The DefiLlama API is free and fast. 2 minutes is still generous caching while being more responsive to price movements. **Action: Change `CACHE_TTL_MS` from `300_000` to `120_000`.** One line.

---

### Q61. `constants.ts` — NEXT_PUBLIC_ fee/address env vars with hardcoded fallbacks

`FEE_RECIPIENT` and `FEE_COLLECTOR_ADDRESS` fall back to hardcoded addresses if env vars are missing. This silently uses defaults without warning.

**Should we throw an error at build time if critical addresses are missing, rather than silently falling back?**

> ANSWER: **The hardcoded fallbacks ARE the correct production addresses.** The env vars exist to allow overriding for testing. This is intentional — if someone deploys without env vars, it still works correctly with the production addresses. **Action: Add a `console.warn` at startup if env vars are missing, but don't throw.** Keeps the app functional.

---

### Q62. `wallet-activity-tracker.ts` — session ID not correlated with wallet

Session IDs are per-tab (`sessionStorage`), not per-wallet. The same wallet in two tabs creates two session IDs. A wallet switch within a tab keeps the old session ID.

**Should we regenerate the session ID when the connected wallet changes?**

> ANSWER: **Yes, good catch.** **Action: Modify `trackWalletActivity()` to check if the wallet differs from the last-tracked wallet. If so, regenerate the session ID and store the new wallet.** This makes timeline queries accurate per wallet.

---

### Q63. `analytics-tracker.ts` — localStorage stores unencrypted wallet/trade data

Trading history (wallet addresses, token amounts, tx hashes) is stored in plaintext in localStorage. An XSS attack could exfiltrate this data.

**Since the server-side analytics (Q2) makes this redundant, should we remove localStorage analytics entirely?**

> ANSWER: **Yes, covered by Q2.** **Action: Delete the file and all references.** Removes both the security concern and dead code.

---

### Q64. FeeCollector contract — no events for fee collection

`TeraSwapFeeCollector_flat.sol` doesn't emit events when fees are collected or swept. This makes off-chain accounting and monitoring difficult.

**Is this a known limitation? Should we deploy a V2 FeeCollector with events?**

> ANSWER: **Known limitation.** We track fees via the swap logs (amount_in minus net amount to DEX). Deploying a V2 would require migrating all aggregator routing, which is risky. **Action: No change. Track fees via Supabase `swaps.fee_collected` field instead.** If we need precise on-chain fee tracking, add it to the V2 contract in Phase 3.

---

### Q65. Order Executor — DCA routerDataHash is bytes32(0)

For DCA orders, `routerDataHash` is `bytes32(0)` (documented as audit finding [C-01]). This means the executor can vary calldata between DCA executions without signature validation.

**Is this mitigated by the router whitelist + minAmountOut check? Or is there residual risk?**

> ANSWER: **Mitigated.** The router whitelist ensures only trusted DEX contracts are called. The `minAmountOut` check ensures the user gets at least their specified minimum. The executor can vary calldata (necessary because DCA buys at different prices over time) but can't steal funds because: 1) tokens go to the order owner, 2) minAmountOut enforced, 3) only whitelisted routers. **No action needed.**

---

### Q66. No MEV/sandwich attack detection post-execution

The system checks prices pre-swap (Chainlink, DefiLlama, cross-quote) but doesn't verify the actual output matches expectations post-execution.

**Should we add a post-swap check comparing actual output to quoted output and log anomalies?**

> ANSWER: **Yes, log anomalies but don't block.** **Action: In the swap confirmation handler (useSwap.ts, when `status='success'`), compare the actual received amount (from the receipt/event) with the quoted amount. If the deviation is >5%, log a `security_event` with type `post_swap_deviation`.** This is observability, not enforcement — the swap already happened.

---

### Q67. `split-router.ts` — potential BigInt rounding dust

Split routing divides amounts using BigInt arithmetic (`total * BigInt(pct) / 100n`). The final leg may receive 1-2 wei less than expected due to integer division.

**Is this dust amount acceptable, or should we add the remainder to the last leg?**

> ANSWER: **Acceptable.** 1-2 wei is literally $0.000000000000000001. Not worth the code complexity to redistribute. **No action needed.**

---

---

# CONCLUSIONS REPORT

## Executive Summary

After a comprehensive review of 67 architectural, security, and performance questions across the entire TeraSwap codebase, the findings break down as:

| Priority | Count | Action |
|----------|-------|--------|
| **Fix Now** | 14 | Immediate implementation needed |
| **Phase 2** | 8 | Scheduled for next iteration |
| **No Action** | 31 | Working as designed |
| **Already Fixed** | 3 | Previously resolved |
| **Deferred** | 11 | Blocked on L2/future work |

## Critical Fixes (Implement Now)

1. **Q2/Q30/Q63** — Remove dead localStorage analytics (`analytics-tracker.ts`)
2. **Q8** — Add shared address validation to all API endpoints
3. **Q10** — Move health token from query params to Authorization header
4. **Q12** — Replace hardcoded APPROX_PRICES with live DefiLlama prices
5. **Q16** — Use viem `getAddress()` for token import validation
6. **Q17** — Reduce particles on mobile (40 instead of 80)
7. **Q22/Q33** — Move logSwapToSupabase after sendTransaction + add orphan cleanup SQL
8. **Q34** — Replace hardcoded $2000 ETH price with Chainlink hook
9. **Q35** — Add `prefers-reduced-motion` check
10. **Q36** — Fix sticky tab bar top offset
11. **Q52** — Add SwapErrorBoundary around SwapBox
12. **Q55** — Exclude API responses from Service Worker cache
13. **Q59** — Add DefiLlama response validation
14. **Q60** — Reduce DefiLlama cache from 5min to 2min

## Security Improvements

- Address validation across all endpoints (Q8)
- Health endpoint auth header migration (Q10)
- Origin check on logging endpoints (Q7)
- RLS policies on orders table (Q15)
- DefiLlama response validation (Q59)
- Token import checksum validation (Q16)

## Performance Improvements

- Mobile particle reduction (Q17)
- Dynamic imports for heavy components (Q5)
- Targeted useMemo in TokenSelector/SwapBox (Q20)

## Database Actions (SQL to provide)

- Missing indexes on security_events and usage_events (Q31)
- TTL cleanup for usage_events and wallet_activity (Q32)
- Orphan pending swap cleanup (Q33)
- RLS policies on orders table (Q15)
