## Evidence 2 to 4: fix/privacy-leftovers-a78b

Companion of `fix-privacy-leftovers-a78b.md` (that file: one-screen summary + Evidence 1, the content-map delta). The goal asks for these in FEEDBACK and for FEEDBACK to stay within one screen plus the content-map delta; they cannot both hold, so the storage table, the break-it proof and the verify output live here.

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
| session | `teraswap:orders-read:<wallet>` | `lib/order-engine/read-auth.ts:134,163` | signature + issuedAt authorising order reads; sent to our server as headers (`:172`) | both |
| not live | `teraswap_beta_banner_dismissed` | `components/BetaBanner.tsx:40` | no importer (`@deprecated`) | none |
| not live | `teraswap_source_prefs` | `lib/source-preferences.ts:41` | `saveSourcePreferences` has no caller | none |
| not live | `teraswap_analytics_events` | `lib/analytics-seed.ts:71` | demo data, only `AdminMonitor` (wallet-authenticated /admin) | none |
| not written | `teraswap:limit:orders`, `teraswap:conditional:orders` | constants only (`limit-order-types.ts:74`, `conditional-order-types.ts:76`) | no writer; legacy `teraswap_orders_v3` only read and removed (`useOrderEngine.ts:193,220`) | none |
| Cache Storage | `teraswap-v1` | `public/sw.js:11-24,51-55` | the site's own static files; API requests never cached | both |
| wallet libraries | wagmi, RainbowKit, WalletConnect | e.g. wagmi `recentConnectorId` (`lib/lazy-walletconnect.ts:41,57`) | theirs | both |
Cookies: none from the app (no `document.cookie =` in `src`; `ts_ui` only from the owner-only `/api/admin/ui-version`).

### Evidence 3: S-11 break-it proof, S-12 timings
**S-11** `src/hooks/useQuote.log-quote.callers.test.ts` (replaces the four-file text check): AST scan of every non-test file in `src` (only SwapBox, v2 SwapCard, `useQuote.ts`, `lib/analytics.ts` may pass or name `logQuote`, import `logQuoteToSupabase` or name `/api/log-quote`; a non-literal options argument counts as logging) and the import closure of the v1 and v2 landing preview (static, dynamic, re-export; stops at `useQuote.ts`). Scratch worktree, baseline 7 passed, restored baseline 7 passed:
- A, new `src/hooks/useFoo.ts` with `useQuote(null, null, '1', true, [], { logQuote: true })`: `AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []`, `+ "file": "src/hooks/useFoo.ts"`, `+ "what": "useQuote(...) passes an options argument: { logQuote: true }"`.
- B, `LandingPage.tsx` passes `undefined, { logQuote: true }`: 2 failed, `expected [ 'src/components/LandingPage.tsx' ] to deeply equal []`.
- C, v2 `Hero.tsx` adds `dynamic(() => import('@/ui/v2/swap/SwapCard'))`: `expected [ 'src/ui/v2/swap/SwapCard.tsx', …(1) ] to deeply equal []`.
- D, v2 `Hero.tsx` adds `import '@/lib/analytics'`: `expected [ 'src/lib/analytics.ts' ] to deeply equal []`.

**S-12** `log-routes.limiter.test.ts`, `log-routes.hung-kv.test.ts` (log-quote, log-swap POST and PATCH, log-activity; one `checkRateLimitWithin`, same key `log:<hash>` as log-event, `LOG_RATE_LIMIT` 120 per 60 s pinned). Hung Redis, real timers, answered 200: log-quote **1007 ms**, log-swap POST **1004 ms**, log-swap PATCH **1002 ms**, log-activity **1005 ms** (bound 1500). Degraded limit (fake timers): 60 pass, the 61st is 429, per route. Working KV: 120th passes, 121st is 429, per route; 40 + 40 + 40 across routes exhausts one budget and `log-event` then answers 429. Against the old routes: 12 of 18 failed (plain limiter called; hung requests never answered, 10 s and 20 s test timeouts). `src/app/api/CLAUDE.md` plain-limiter count 18 / 22 became 15 / 19 (my grep: 17 / 22 before, 14 / 19 after; method difference of 1 not chased).
**C3 break-it:** the old `appDescription` put back fails 3 tests (`expected 'Ethereum & Base meta-aggregator: best…' to be 'TeraSwap is an EVM meta-aggregator on…'`) and the checker (`src/lib/wagmiConfig.ts:119: hard-coded source count: "11 liquidity sources"`); restored. `check-product-claims.mjs` now lists `wagmiConfig.ts` (9 files).

### Evidence 4: verify, diff --stat, compare link
`scripts/agent-verify.sh --codeql`, head 9d23b75, base origin/main 649105f: suite PASS 10650 / 0 failed / 497 files · lint-delta PASS +0 err +0 warn · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 36 · CodeQL security-extended PASS head 13 / base 13 / new 0 · RESULT PASS. Hosts capture (production build, CI marker env, `e2e/third-party-hosts`): 16 passed. `check-product-claims.mjs` PASS (9 files) · `gen-claude-state.mjs --check` PASS · `check-agents-parity.mjs` PASS. No U+2014 or spaced U+2013 on added lines. Unchanged: what is logged or stored, orders, swap history, signing, CSP, rate-limit numbers, database, dependencies. Not run: `--keeper` (no keeper code), `goal-lint` (goal text has no `CONTROL:` line).
```
git diff --stat origin/main...HEAD   (before this file's last edit; the feedback file itself is +77 there)
 AGENTS.md                                          |   2 +-
 CLAUDE.md                                          |   2 +-
 docs/feedback/fix-privacy-leftovers-a78b.md        |  77 ++++++++
 scripts/check-product-claims.mjs                   |   2 +
 src/app/api/CLAUDE.md                              |   4 +-
 .../api/log-activity/route.no-session-id.test.ts   |   3 +-
 src/app/api/log-activity/route.ts                  |   4 +-
 src/app/api/log-quote/route.ts                     |   4 +-
 src/app/api/log-routes.hardening.test.ts           |   2 +-
 src/app/api/log-routes.hung-kv.test.ts             |  83 +++++++++
 src/app/api/log-routes.limiter.test.ts             | 144 +++++++++++++++
 src/app/api/log-swap/route.test.ts                 |   1 +
 src/app/api/log-swap/route.ts                      |   4 +-
 src/app/metadata.copy.guard.test.ts                |  19 +-
 src/components/DocsPage.tsx                        |   4 +-
 src/components/LegalPage.tsx                       |  13 +-
 src/config/product-claims.ts                       |  21 ++-
 src/hooks/useQuote.log-quote.callers.test.ts       | 202 +++++++++++++++++++++
 src/hooks/useQuote.log-quote.test.ts               |  21 +--
 src/lib/client-ip-key.guard.test.ts                |   3 +-
 src/lib/help-content.test.ts                       |   7 +-
 src/lib/help-content.ts                            |   4 +-
 src/lib/wagmiConfig.test.ts                        |  21 +++
 src/lib/wagmiConfig.ts                             |   8 +-
 src/ui/v2/docs-legal/DocsTabV2.tsx                 |   4 +-
 src/ui/v2/docs-legal/LegalPageV2.tsx               |  13 +-
 src/ui/v2/docs-legal/browser-storage-list.test.ts  | 100 ++++++++++
 src/ui/v2/docs-legal/privacy-copy.test.tsx         |  51 +++++-
 28 files changed, 763 insertions(+), 60 deletions(-)
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-leftovers-a78b
