## Feedback: fix/privacy-leftovers-a78b

A78b M and L findings S-8 to S-12 plus the WalletConnect description. Draft PR, Auditor required (Privacy copy, v1 == v2). No PR opened by me. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-leftovers-a78b

- [x] C1 copy S-8, S-9, S-10 (+ Help, Docs, product-claims) · [x] C2 S-11 guard, S-12 limiter · [x] C3 WalletConnect description · [x] verify, hosts capture, push
- **Premise false, asked once, owner answer 2026-11-13: "Keep it".** S-10 half 1 ("addresses as they appear on-chain") is not true: the tab shows pair, route, time, tx link; the API cuts each wallet to 6 + 4 characters (`api/analytics/route.ts:468-472`). Section 6 says that; half 2 (anyone with an address can request its statistics) is true (`analytics/personal/route.ts:11,47`, `export/route.ts:164,216`).
- **S-9:** the old list named slippage (`SwapBox.tsx:74`), swap history (`useSwapHistory.ts:24`) and approvals (`useActiveApprovals.ts:9`) as stored; all three are memory only. Sound is not stored either (`lib/sounds.ts` has no storage call).
- **S-8, what could contradict "Cloudflare in front":** for it, `lib/cloudflare-ips.ts:4`, `lib/trusted-ip.ts:23-34`. Against or unproven: `lib/fingerprint-validator.ts:66,100,138` and `lib/monitoring-loop.ts:157` ("pre-Cloudflare-migration", TLS/DNS baseline unseeded); `FASE-A-CLOUDFLARE-DNS.md:3` "Status: pendente" (registrar, not the proxy). No Cloudflare analytics beacon exists in the repo; the dashboard toggle behind "we do not ask them for analytics" is not provable here.
- **Extra read, not in the allow-list:** `analytics-tracker.ts:162` (`supabaseInsert` has no client in a browser, untouched), `public/sw.js`, `WalletSessionGuard.tsx`, `read-auth.ts`, `lib/trusted-ip.ts`.
- **Found while verifying:** first run (4f304ea) failed `client-ip-key.guard.test.ts` (`expected 14 to be greater than 15`): it scanned only `checkRateLimit(`, so the migrated log routes left its scan. Fixed in its own commit (regex matches both names).
- **For the owner:** Cloudflare analytics toggle; `/api/analytics` still returns the shortened address plus tx hash (dropping the field is a separate change).

### Evidence 1: content-map delta (v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help and Docs read the same constants)
| where | before | after | proof |
|---|---|---|---|
| 3.3 (`PRIVACY_LOCAL_STORAGE_NOTE`, new) | "uses your browser's local storage to remember your preferences, such as imported tokens, slippage settings, swap history, theme preferences, and active approvals." | the entries of Evidence 2, local vs session, "memory only" for slippage, swap history, approvals, the service-worker cache, wallet libraries' entries "theirs" | Evidence 2; guard `ui/v2/docs-legal/browser-storage-list.test.ts` (writers found in `src` == the table) |
| 3.3 `PRIVACY_LOCAL_COPIES_NOTE` | "These copies stay in your browser…" | "The copies of your orders and order activity stay in your browser…" (rest unchanged) | `useOrderEngine.ts:260`, `analytics-tracker.ts:114` |
| 6 (`PRIVACY_PUBLIC_ANALYTICS_NOTE`, new) | none | Analytics data is public; swaps and order fills by all users with pair, route, time, tx link; no addresses displayed, data holds them shortened (6 + 4); a swap you signed is a public transaction showing your address; anyone with an address can request its swap statistics and export, no signature | `api/analytics/route.ts:38-40,468-472`; `AnalyticsDashboard.tsx:116-134`; `analytics/personal/route.ts:11,47`; `analytics/export/route.ts:164,216` |
| 8 last sentence | "Any data stored in your browser (…) is used solely for your convenience and remains on your device." | "What the Interface keeps in your browser is listed in section 3.3." | the old one contradicted the order-read signature, sent as a header (`read-auth.ts:163,172`) |
| 8 (`PRIVACY_PROVIDERS_NOTE`, new) | none | "Our hosting and network providers, Vercel and Cloudflare, process every request to the Interface, including your IP address, in order to deliver it, under their own policies. We do not ask them for analytics." | `vercel.json`, `trusted-ip.ts:23`, `cloudflare-ips.ts:4`, owner fact; no analytics package or script (`package.json`, `layout.tsx`, test "no page, layout or provider names the Vercel analytics" in `privacy-copy.test.tsx`) |
| Help "What data does TeraSwap collect?", Docs v1 + v2 note | ended at the wallet-storage note | + the 6 and 8 sentences (same constants) | `help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474` |
| privacy/terms metadata | "how we handle user data and IP proxying." | unchanged | still true |
| `wagmiConfig.ts:117` `appDescription` (shown by wallets) | "Ethereum & Base meta-aggregator: best swap price across 11 liquidity sources." | `TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources.` | same constants and wording as `SITE_META_DESCRIPTION` (`product-claims.ts:156`); no "best" |

### Evidence 2: storage-key table (every writer in `src`; guard `ui/v2/docs-legal/browser-storage-list.test.ts` fails on a new one)
local: `teraswap-theme` `contexts/ThemeContext.tsx:67` · `ts:imported-tokens:v1:<chainId>` `lib/imported-tokens.ts:24,85` · `teraswap:v2:fiat-currency` (v2) `ui/v2/fiat/fiat-preference.ts:9,33` · `teraswap:permit2-educated:v1` `components/Permit2EducationModal.tsx:56`, `ui/v2/modals/Permit2Sheet.tsx:23` · `teraswap_notifications_enabled`, `teraswap_notif_prompt_dismissed` `hooks/useOrderNotifications.ts:71,209` · `teraswap_dismissed_orders` `hooks/useOrderEngine.ts:268,286`
local, AES-GCM (key from the wallet address): `teraswap_orders_v4` `hooks/useOrderEngine.ts:167,260` via `lib/secure-storage.ts:210` · `teraswap_analytics_events_v2` `lib/analytics-tracker.ts:39,114` (callers `ui/v2/dca/DcaCard.tsx:502`, `components/DCAPanel.tsx:213`)
session: `ts_v2_intro_seen` (v2) `ui/v2/landing/Intro.tsx:10,23` · `teraswap:rateInverted` `components/QuoteBreakdown.tsx:89`, `ui/v2/swap/QuotePanel.tsx:13,79` · `teraswap_wallet_connected_at` (time of last click/key/scroll/touch while connected; 1 h idle timer) `components/WalletSessionGuard.tsx:31-32,66,83` · `teraswap:orders-read:<wallet>` (signature, sent to our server as headers) `lib/order-engine/read-auth.ts:134,163,172`
not live (no importer or caller): `teraswap_beta_banner_dismissed` `components/BetaBanner.tsx:40` · `teraswap_source_prefs` `lib/source-preferences.ts:41` · `teraswap_analytics_events` `lib/analytics-seed.ts:71` (admin demo seed only) · limit/conditional keys are constants with no writer (`limit-order-types.ts:74`, `conditional-order-types.ts:76`)
other: Cache Storage `teraswap-v1`, static files only, API never cached (`public/sw.js:11-24,51-55`) · wallet libraries' own entries, e.g. wagmi `recentConnectorId` (`lib/lazy-walletconnect.ts:41,57`) · cookies: none from the app (`ts_ui` only from owner-only `/api/admin/ui-version`)

### Evidence 3: S-11 break-it, S-12 timings, C3 break-it
- **S-11** `src/hooks/useQuote.log-quote.callers.test.ts` (AST scan of every non-test file in `src` + import closure of the v1/v2 landing preview, stops at `useQuote.ts`). Scratch worktree, baseline 7 passed, restored 7 passed. A, new `src/hooks/useFoo.ts` passing `{ logQuote: true }`: `AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []`, `+ "file": "src/hooks/useFoo.ts"`. B, `LandingPage.tsx` passes it: 2 failed, `expected [ 'src/components/LandingPage.tsx' ] to deeply equal []`. C, v2 `Hero.tsx` dynamic-imports `SwapCard`: `expected [ 'src/ui/v2/swap/SwapCard.tsx', …(1) ] to deeply equal []`. D, v2 `Hero.tsx` imports `@/lib/analytics`: `expected [ 'src/lib/analytics.ts' ] to deeply equal []`.
- **S-12** `log-routes.limiter.test.ts`, `log-routes.hung-kv.test.ts`; same key `log:<hash>` and `LOG_RATE_LIMIT` 120 per 60 s as log-event. Hung Redis, real timers, answered 200 in: log-quote **1007 ms**, log-swap POST **1004 ms**, PATCH **1002 ms**, log-activity **1005 ms** (bound 1500). Degraded: 60 pass, 61st is 429, per route. Working KV: 120th passes, 121st is 429; 40 + 40 + 40 across routes exhausts one budget, `log-event` then 429. Old routes: 12 of 18 failed (plain limiter called; hung requests never answered, 10 s and 20 s timeouts). `src/app/api/CLAUDE.md` count 18 / 22 became 15 / 19.
- **C3** old `appDescription` put back: 3 tests fail (`expected 'Ethereum & Base meta-aggregator: best…' to be 'TeraSwap is an EVM meta-aggregator on…'`) and the checker (`src/lib/wagmiConfig.ts:119: hard-coded source count: "11 liquidity sources"`); restored.

### Evidence 4: verify, diff --stat, compare link
`scripts/agent-verify.sh --codeql` at 9d23b75 (base origin/main 649105f): suite PASS 10650 / 0 failed / 497 files · lint-delta PASS +0/+0 · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 36 · CodeQL PASS head 13 / base 13 / new 0. Hosts capture (production build, CI marker env): 16 passed. `check-product-claims.mjs`, `gen-claude-state.mjs --check`, `check-agents-parity.mjs`: PASS. No U+2014 or spaced U+2013 on added lines. Unchanged: logging, storage, orders, swap history, signing, CSP, rate-limit numbers, database, dependencies. Not run: `--keeper`, `goal-lint` (no `CONTROL:` line).
`git diff --stat origin/main...HEAD` excluding `docs/feedback/` (taken at bee1b829):
```
 AGENTS.md                                          |   2 +-
 CLAUDE.md                                          |   2 +-
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
 27 files changed, 686 insertions(+), 60 deletions(-)
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-leftovers-a78b

- [x] C1 copy S-8, S-9, S-10 (+ Help, Docs, product-claims) · [x] C2 S-11 guard, S-12 limiter · [x] C3 WalletConnect description · [x] verify, hosts capture, push
- **Premise false, asked once, owner answer 2026-11-13: "Keep it".** S-10 half 1 ("addresses as they appear on-chain") is not true: the tab shows pair, route, time, tx link; the API cuts each wallet to 6 + 4 characters (`api/analytics/route.ts:468-472`). Section 6 says that; half 2 (anyone with an address can request its statistics) is true (`analytics/personal/route.ts:11,47`, `export/route.ts:164,216`).
- **S-9:** the old list named slippage (`SwapBox.tsx:74`), swap history (`useSwapHistory.ts:24`) and approvals (`useActiveApprovals.ts:9`) as stored; all three are memory only. Sound is not stored either (`lib/sounds.ts` has no storage call).
- **S-8, what could contradict "Cloudflare in front":** for it, `lib/cloudflare-ips.ts:4`, `lib/trusted-ip.ts:23-34`. Against or unproven: `lib/fingerprint-validator.ts:66,100,138` and `lib/monitoring-loop.ts:157` ("pre-Cloudflare-migration", TLS/DNS baseline unseeded); `FASE-A-CLOUDFLARE-DNS.md:3` "Status: pendente" (registrar, not the proxy). No Cloudflare analytics beacon exists in the repo; the dashboard toggle behind "we do not ask them for analytics" is not provable here.
- **Extra read, not in the allow-list:** `analytics-tracker.ts:162` (`supabaseInsert` has no client in a browser, untouched), `public/sw.js`, `WalletSessionGuard.tsx`, `read-auth.ts`, `lib/trusted-ip.ts`.
- **Found while verifying:** first run (4f304ea) failed `client-ip-key.guard.test.ts` (`expected 14 to be greater than 15`): it scanned only `checkRateLimit(`, so the migrated log routes left its scan. Fixed in its own commit (regex matches both names).
- **For the owner:** Cloudflare analytics toggle; `/api/analytics` still returns the shortened address plus tx hash (dropping the field is a separate change).

### Evidence 1: content-map delta (v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help and Docs read the same constants)
| where | before | after | proof |
|---|---|---|---|
| 3.3 (`PRIVACY_LOCAL_STORAGE_NOTE`, new) | "uses your browser's local storage to remember your preferences, such as imported tokens, slippage settings, swap history, theme preferences, and active approvals." | the entries of Evidence 2, local vs session, "memory only" for slippage, swap history, approvals, the service-worker cache, wallet libraries' entries "theirs" | Evidence 2; guard `ui/v2/docs-legal/browser-storage-list.test.ts` (writers found in `src` == the table) |
| 3.3 `PRIVACY_LOCAL_COPIES_NOTE` | "These copies stay in your browser…" | "The copies of your orders and order activity stay in your browser…" (rest unchanged) | `useOrderEngine.ts:260`, `analytics-tracker.ts:114` |
| 6 (`PRIVACY_PUBLIC_ANALYTICS_NOTE`, new) | none | Analytics data is public; swaps and order fills by all users with pair, route, time, tx link; no addresses displayed, data holds them shortened (6 + 4); a swap you signed is a public transaction showing your address; anyone with an address can request its swap statistics and export, no signature | `api/analytics/route.ts:38-40,468-472`; `AnalyticsDashboard.tsx:116-134`; `analytics/personal/route.ts:11,47`; `analytics/export/route.ts:164,216` |
| 8 last sentence | "Any data stored in your browser (…) is used solely for your convenience and remains on your device." | "What the Interface keeps in your browser is listed in section 3.3." | the old one contradicted the order-read signature, sent as a header (`read-auth.ts:163,172`) |
| 8 (`PRIVACY_PROVIDERS_NOTE`, new) | none | "Our hosting and network providers, Vercel and Cloudflare, process every request to the Interface, including your IP address, in order to deliver it, under their own policies. We do not ask them for analytics." | `vercel.json`, `trusted-ip.ts:23`, `cloudflare-ips.ts:4`, owner fact; no analytics package or script (`package.json`, `layout.tsx`, test "no page, layout or provider names the Vercel analytics" in `privacy-copy.test.tsx`) |
| Help "What data does TeraSwap collect?", Docs v1 + v2 note | ended at the wallet-storage note | + the 6 and 8 sentences (same constants) | `help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474` |
| privacy/terms metadata | "how we handle user data and IP proxying." | unchanged | still true |
| `wagmiConfig.ts:117` `appDescription` (shown by wallets) | "Ethereum & Base meta-aggregator: best swap price across 11 liquidity sources." | `TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources.` | same constants and wording as `SITE_META_DESCRIPTION` (`product-claims.ts:156`); no "best" |

### Evidence 2: storage-key table (every writer in `src`; guard `ui/v2/docs-legal/browser-storage-list.test.ts` fails on a new one)
local: `teraswap-theme` `contexts/ThemeContext.tsx:67` · `ts:imported-tokens:v1:<chainId>` `lib/imported-tokens.ts:24,85` · `teraswap:v2:fiat-currency` (v2) `ui/v2/fiat/fiat-preference.ts:9,33` · `teraswap:permit2-educated:v1` `components/Permit2EducationModal.tsx:56`, `ui/v2/modals/Permit2Sheet.tsx:23` · `teraswap_notifications_enabled`, `teraswap_notif_prompt_dismissed` `hooks/useOrderNotifications.ts:71,209` · `teraswap_dismissed_orders` `hooks/useOrderEngine.ts:268,286`
local, AES-GCM (key from the wallet address): `teraswap_orders_v4` `hooks/useOrderEngine.ts:167,260` via `lib/secure-storage.ts:210` · `teraswap_analytics_events_v2` `lib/analytics-tracker.ts:39,114` (callers `ui/v2/dca/DcaCard.tsx:502`, `components/DCAPanel.tsx:213`)
session: `ts_v2_intro_seen` (v2) `ui/v2/landing/Intro.tsx:10,23` · `teraswap:rateInverted` `components/QuoteBreakdown.tsx:89`, `ui/v2/swap/QuotePanel.tsx:13,79` · `teraswap_wallet_connected_at` (time of last click/key/scroll/touch while connected; 1 h idle timer) `components/WalletSessionGuard.tsx:31-32,66,83` · `teraswap:orders-read:<wallet>` (signature, sent to our server as headers) `lib/order-engine/read-auth.ts:134,163,172`
not live (no importer or caller): `teraswap_beta_banner_dismissed` `components/BetaBanner.tsx:40` · `teraswap_source_prefs` `lib/source-preferences.ts:41` · `teraswap_analytics_events` `lib/analytics-seed.ts:71` (admin demo seed only) · limit/conditional keys are constants with no writer (`limit-order-types.ts:74`, `conditional-order-types.ts:76`)
other: Cache Storage `teraswap-v1`, static files only, API never cached (`public/sw.js:11-24,51-55`) · wallet libraries' own entries, e.g. wagmi `recentConnectorId` (`lib/lazy-walletconnect.ts:41,57`) · cookies: none from the app (`ts_ui` only from owner-only `/api/admin/ui-version`)

### Evidence 3: S-11 break-it, S-12 timings, C3 break-it
- **S-11** `src/hooks/useQuote.log-quote.callers.test.ts` (AST scan of every non-test file in `src` + import closure of the v1/v2 landing preview, stops at `useQuote.ts`). Scratch worktree, baseline 7 passed, restored 7 passed. A, new `src/hooks/useFoo.ts` passing `{ logQuote: true }`: `AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []`, `+ "file": "src/hooks/useFoo.ts"`. B, `LandingPage.tsx` passes it: 2 failed, `expected [ 'src/components/LandingPage.tsx' ] to deeply equal []`. C, v2 `Hero.tsx` dynamic-imports `SwapCard`: `expected [ 'src/ui/v2/swap/SwapCard.tsx', …(1) ] to deeply equal []`. D, v2 `Hero.tsx` imports `@/lib/analytics`: `expected [ 'src/lib/analytics.ts' ] to deeply equal []`.
- **S-12** `log-routes.limiter.test.ts`, `log-routes.hung-kv.test.ts`; same key `log:<hash>` and `LOG_RATE_LIMIT` 120 per 60 s as log-event. Hung Redis, real timers, answered 200 in: log-quote **1007 ms**, log-swap POST **1004 ms**, PATCH **1002 ms**, log-activity **1005 ms** (bound 1500). Degraded: 60 pass, 61st is 429, per route. Working KV: 120th passes, 121st is 429; 40 + 40 + 40 across routes exhausts one budget, `log-event` then 429. Old routes: 12 of 18 failed (plain limiter called; hung requests never answered, 10 s and 20 s timeouts). `src/app/api/CLAUDE.md` count 18 / 22 became 15 / 19.
- **C3** old `appDescription` put back: 3 tests fail (`expected 'Ethereum & Base meta-aggregator: best…' to be 'TeraSwap is an EVM meta-aggregator on…'`) and the checker (`src/lib/wagmiConfig.ts:119: hard-coded source count: "11 liquidity sources"`); restored.

### Evidence 4: verify, diff --stat, compare link
`scripts/agent-verify.sh --codeql` at 9d23b75 (base origin/main 649105f): suite PASS 10650 / 0 failed / 497 files · lint-delta PASS +0/+0 · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 36 · CodeQL PASS head 13 / base 13 / new 0. Hosts capture (production build, CI marker env): 16 passed. `check-product-claims.mjs`, `gen-claude-state.mjs --check`, `check-agents-parity.mjs`: PASS. No U+2014 or spaced U+2013 on added lines. Unchanged: logging, storage, orders, swap history, signing, CSP, rate-limit numbers, database, dependencies. Not run: `--keeper`, `goal-lint` (no `CONTROL:` line).
`git diff --stat origin/main...HEAD` (before the feedback edits): 28 files changed, 763 insertions(+), 60 deletions(-): product-claims.ts +21, LegalPage.tsx 13, LegalPageV2.tsx 13, DocsPage.tsx 4, DocsTabV2.tsx 4, help-content.ts 4, wagmiConfig.ts 8, log-quote/log-swap/log-activity route.ts 4 each, CLAUDE.md, AGENTS.md, `src/app/api/CLAUDE.md`, `scripts/check-product-claims.mjs` +2, new tests `useQuote.log-quote.callers` 202, `log-routes.limiter` 144, `browser-storage-list` 100, `log-routes.hung-kv` 83, and edits to `privacy-copy.test` 51, `wagmiConfig.test` 21, `metadata.copy.guard.test` 19, `help-content.test` 7, `useQuote.log-quote.test` 21, `client-ip-key.guard.test` 3, four small log-route test mocks. Full per-file stat and verbose tables: `fix-privacy-leftovers-a78b.evidence.md`.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-leftovers-a78b
