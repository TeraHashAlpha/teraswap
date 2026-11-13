## Feedback: fix/privacy-leftovers-a78b

M and L findings of audit A78b (S-8 to S-12) plus the WalletConnect description. Owner stance: collect nothing beyond what the product needs. Draft PR, Auditor required (Privacy copy). Compare link: last section.

### Checklist
- [x] C1 Privacy copy: S-8 (section 8), S-9 (section 3.3), S-10 (section 6), Help, Docs, product-claims
- [x] C2 S-11 caller guard + landing-import guard, S-12 `checkRateLimitWithin` on log-quote, log-swap, log-activity
- [x] C3 WalletConnect `appDescription` + stale-claim guards
- [ ] Verify (`agent-verify.sh --codeql`, hosts capture, claims checker, `gen-claude-state.mjs --check`), push, compare link

### Premises that were not (fully) true, and what I wrote instead
- **S-10 half 1 is false as worded.** The Analytics tab does not show "wallet addresses as they appear on-chain". It shows type, token pair, route, time-ago and a tx link, newest 10 of the 50 the API returns (`AnalyticsDashboard.tsx:103-137`, `ui/v2/analytics/AnalyticsTab.tsx:83-111`); the API response cuts each wallet to its first 6 and last 4 characters (`api/analytics/route.ts:468-472`, API-MED-07). Written: the tab does not display addresses, the data holds them shortened, a swap you signed yourself is a public transaction that shows your address. Half 2 is true (below).
- **S-9: the old list named three things the code does not store.** Slippage (`SwapBox.tsx:74` `useState`; v2 `SwapCard.tsx:145`), swap history (`useSwapHistory.ts:24`, in-memory zustand, no persist) and active approvals (`useActiveApprovals.ts:9`, in-memory). Sound is not stored either (module-level flag, `ui/v2/shell/music.ts`, `lib/sounds.ts` has no storage call). Said so in the sentence.
- **S-8 Cloudflare is an owner fact; the repo mostly agrees, two places could be read against it.** For: `lib/cloudflare-ips.ts:4`, `lib/trusted-ip.ts:23-34` ("teraswap.app is proxied through Cloudflare"). Possibly against: `lib/fingerprint-validator.ts:66,100,138` and `lib/monitoring-loop.ts:157` say "pre-Cloudflare-migration" (TLS+DNS baseline not seeded, H2 inactive); `FASE-A-CLOUDFLARE-DNS.md:3` is "Status: pendente" (registrar transfer and registry lock, not the proxy). Nothing in the repo shows a Cloudflare analytics beacon; whether the Cloudflare dashboard has Web Analytics / auto-injection on is not provable here (owner to confirm, because "we do not ask them for analytics" rests on it).
- No question asked: the goal's own rule ("if a half is not true, do not write it and say what is true") covered S-10.

### Evidence 1: content-map delta (v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help and Docs read the same constants)
| where | before | after | proof |
|---|---|---|---|
| Privacy 3.3 (`PRIVACY_LOCAL_STORAGE_NOTE`, new) | "uses your browser's local storage to remember your preferences, such as imported tokens, slippage settings, swap history, theme preferences, and active approvals." | the keys of Evidence 2, local vs session, "memory only" for slippage, swap history, approvals, the service-worker cache, wallet libraries' entries "theirs" | table below; guard `ui/v2/docs-legal/browser-storage-list.test.ts` (writers found in `src` == the table; a new writer fails it) |
| 3.3 `PRIVACY_LOCAL_COPIES_NOTE` | "These copies stay in your browser…" | "The copies of your orders and order activity stay in your browser…" (rest unchanged) | referent was the old list; local copies = `useOrderEngine.ts:260`, `analytics-tracker.ts:114` |
| §6 (`PRIVACY_PUBLIC_ANALYTICS_NOTE`, new paragraph) | none | the data behind the Analytics tab is public; lists swaps and order fills by all users with pair, route, time, tx link; no addresses displayed, data holds them shortened (6+4); a swap you signed is a public transaction showing your address; anyone with an address can request its swap statistics and export, no signature | `api/analytics/route.ts:38-40,468-472` (no auth, all confirmed swaps + fills); tab `AnalyticsDashboard.tsx:116-134`; `api/analytics/personal/route.ts:11,47`; `api/analytics/export/route.ts:164,216`; both take `?wallet=` only |
| §8 last sentence | "Any data stored in your browser (…) is used solely for your convenience and remains on your device." | "What the Interface keeps in your browser is listed in section 3.3." | old sentence contradicted the order-read signature (sent as a header, `read-auth.ts:163,172`) and read as "convenience" for an auth item |
| §8 (`PRIVACY_PROVIDERS_NOTE`, new) | none | "Our hosting and network providers, Vercel and Cloudflare, process every request to the Interface, including your IP address, in order to deliver it, under their own policies. We do not ask them for analytics." | Vercel: `vercel.json`, `trusted-ip.ts:23`; Cloudflare: owner fact + `cloudflare-ips.ts:4`; no analytics package or script (`package.json` has no `@vercel/*` analytics, `layout.tsx` has no `<Analytics />`, bundle test `privacy-copy.test.tsx` "no page, layout or provider names the Vercel analytics…") |
| Help "What data does TeraSwap collect?", Docs v1 + v2 privacy note | ended at the wallet-storage note | + the §6 and §8 sentences (same constants) | `help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474`; Docs v1 == v2 parity test green |
| page metadata (`privacy/layout.tsx`, `terms/layout.tsx`) | "how we handle user data and IP proxying." | unchanged | still true; names no analytics, cookie or retention claim |

### Evidence 2: storage-key table (every writer in `src`, non-test; `/api/*` is server code)
| store | key | written at | what it holds | UI |
|---|---|---|---|---|
| local | `teraswap-theme` | `contexts/ThemeContext.tsx:67` | theme | both |
| local | `ts:imported-tokens:v1:<chainId>` | `lib/imported-tokens.ts:24,85` | tokens the visitor imported | both |
| local | `teraswap:v2:fiat-currency` | `ui/v2/fiat/fiat-preference.ts:9,33` | dollars or euros | v2 |
| local | `teraswap:permit2-educated:v1` | `components/Permit2EducationModal.tsx:56`, `ui/v2/modals/Permit2Sheet.tsx:23` | seen the Permit2 explainer | both |
| local | `teraswap_notifications_enabled`, `teraswap_notif_prompt_dismissed` | `hooks/useOrderNotifications.ts:71,209` | notification choice, prompt dismissed | both |
| local (AES-GCM, key from the wallet address) | `teraswap_orders_v4` | `hooks/useOrderEngine.ts:167,260` via `lib/secure-storage.ts:210` | copy of the wallet's orders | both |
| local | `teraswap_dismissed_orders` | `hooks/useOrderEngine.ts:268,286` | ids of dismissed orders | both |
| local (AES-GCM) | `teraswap_analytics_events_v2` | `lib/analytics-tracker.ts:39,114`; callers `ui/v2/dca/DcaCard.tsx:502`, `components/DCAPanel.tsx:213` | local record of order activity | both |
| session | `ts_v2_intro_seen` | `ui/v2/landing/Intro.tsx:10,23` | intro already played | v2 |
| session | `teraswap:rateInverted` | `components/QuoteBreakdown.tsx:89`, `ui/v2/swap/QuotePanel.tsx:13,79` | rate reading direction | both |
| session | `teraswap_wallet_connected_at` | `components/WalletSessionGuard.tsx:32,66` | time of last click/key/scroll/touch while connected (1 h idle timer, `:31,83`) | both |
| session | `teraswap:orders-read:<wallet>` | `lib/order-engine/read-auth.ts:134,163` | signature + issuedAt that authorise order reads; sent to our server as headers (`:172`) | both |
| not live | `teraswap_beta_banner_dismissed` | `components/BetaBanner.tsx:40` | no importer (`@deprecated`) | none |
| not live | `teraswap_source_prefs` | `lib/source-preferences.ts:41` | `saveSourcePreferences` has no caller | none |
| not live | `teraswap_analytics_events` | `lib/analytics-seed.ts:71` | demo data, only `AdminMonitor` (wallet-authenticated /admin) | none |
| not written | `teraswap:limit:orders`, `teraswap:conditional:orders` | constants only (`limit-order-types.ts:74`, `conditional-order-types.ts:76`) | no writer; legacy `teraswap_orders_v3` is only read and removed (`useOrderEngine.ts:193,220`) | none |
| Cache Storage | `teraswap-v1` | `public/sw.js:11-24,51-55` | the site's own static files; API requests are never cached | both |
| wallet libraries | wagmi, RainbowKit, WalletConnect | e.g. wagmi `recentConnectorId` (`lib/lazy-walletconnect.ts:41,57`) | theirs | both |
Cookies: none from the app (`document.cookie =` has no hit in `src`; `ts_ui` is set only by the owner-only `/api/admin/ui-version`). Not read, outside the allow-list: `analytics-tracker.ts:162` `supabaseInsert` runs `getSupabase()` (server env), so in a browser it has no client.

### Evidence 3: S-11 break-it proof, S-12 timings
**S-11** (`src/hooks/useQuote.log-quote.callers.test.ts`, replaces the four-file text check). Two AST scans over every non-test file of `src`: (1) no file but SwapBox, v2 SwapCard, `useQuote.ts`, `lib/analytics.ts` passes an options argument to `useQuote`, builds a `logQuote` object, imports `logQuoteToSupabase` or names `/api/log-quote` (a non-literal options argument counts as logging); (2) the import closure of the landing preview (v1 LandingPage + LandingBelowFold, every file of the v2 landing folder; static, dynamic, re-export) holds no swap screen and no logging module, stopping at `useQuote.ts`. Broken in a scratch worktree (detached at my HEAD, `node_modules` linked, removed afterwards); unbroken baseline 7 passed, restored baseline 7 passed:
- A, a new `src/hooks/useFoo.ts` calling `useQuote(null, null, '1', true, [], { logQuote: true })`: 1 failed, `AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []` with `+ "file": "src/hooks/useFoo.ts"`, `+ "what": "useQuote(...) passes an options argument: { logQuote: true }"`, `+ "what": "object literal with a logQuote property: { logQuote: true }"`.
- B, `LandingPage.tsx` passes `undefined, { logQuote: true }`: 2 failed (the scan above on `src/components/LandingPage.tsx`, and the landing closure: `expected [ 'src/components/LandingPage.tsx' ] to deeply equal []`).
- C, v2 `Hero.tsx` adds `dynamic(() => import('@/ui/v2/swap/SwapCard'))`: 1 failed, `expected [ 'src/ui/v2/swap/SwapCard.tsx', …(1) ] to deeply equal []`.
- D, v2 `Hero.tsx` adds `import '@/lib/analytics'` (the module holding the sink): 1 failed, `expected [ 'src/lib/analytics.ts' ] to deeply equal []`.
Also pinned: the scan sees an alias (`useQuote as q`), a spread, a pass-through variable, and stays quiet on `useQuote(a, b, c, true, excluded)`.

**S-12** (`log-routes.limiter.test.ts`, `log-routes.hung-kv.test.ts`; `/api/log-quote`, `/api/log-swap` POST and PATCH, `/api/log-activity`, one `checkRateLimitWithin` each, same key `log:<hash>`, `LOG_RATE_LIMIT` 120 per 60 s unchanged and pinned). Hung Redis (every call never settles), real timers, answered 200: log-quote POST **1007 ms**, log-swap POST **1004 ms**, log-swap PATCH **1002 ms**, log-activity POST **1005 ms** (bound < 1500). Degraded limit with the hung KV (fake timers): 60 pass, the 61st is 429, for each of the four. Working KV (in-memory sorted set): request 120 passes and 121 is 429 per route; 40 + 40 + 40 over quote, swap and activity exhausts one shared budget and then every route, `log-event` included, answers 429; the args equal what `log-event` sends. Against the OLD routes (the three route edits reverted) 12 of 18 failed: the plain limiter was called, and the hung-KV requests never answered (10 s test timeout, 20 s for the degraded ones).
Doc: `src/app/api/CLAUDE.md` said 18 plain-limiter call sites in `src/app/api` (22 in `src`); my grep of `checkRateLimit(` gave 17 / 22 on main and 14 / 19 now, so I subtracted the three routes (15 / 19) without chasing the 1 difference in method.

### Evidence 3b: WalletConnect description (C3)
| where | before | after | proof |
|---|---|---|---|
| `src/lib/wagmiConfig.ts:117` `appDescription` (shown by wallets at connection) | "Ethereum & Base meta-aggregator: best swap price across 11 liquidity sources." | `TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources.` (today: three chains, the quoting-adapter count) | same two constants and same wording as `SITE_META_DESCRIPTION` (`product-claims.ts:156`); no "best" (the claims file makes no such promise) |
Guards: `wagmiConfig.test.ts` (value equals the derived sentence, names every registry chain, no retired phrasing, no "best", no MEV, no dash, <= 200 chars); `metadata.copy.guard.test.ts` now also scans the strings of `wagmiConfig.ts`; `scripts/check-product-claims.mjs` lists `src/lib/wagmiConfig.ts` as a user-facing file (9 files). Break-it: the old string put back fails 3 tests (`expected 'Ethereum & Base meta-aggregator: best…' to be 'TeraSwap is an EVM meta-aggregator on…'`, `/Ethereum & Base/i: expected … not to match`) and the checker (`src/lib/wagmiConfig.ts:119: hard-coded source count: "11 liquidity sources"`); file restored.
