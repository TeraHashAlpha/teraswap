## Feedback: fix/privacy-no-usage-tracking

Owner decision: the site stops recording how visitors use it; keeps orders, swap history, quotes (with the wallet address) and Vercel Web Analytics' aggregate page-view counter (Privacy §8). v1 and v2 together.

### Checklist
- [x] C1 remove our own usage tracking (commit recorded below)
- [x] C2 Privacy §3 says what is true (v1 == v2) + aligned statements
- [x] C3 em-dash guard hand-off: done after PR #680 merged. origin/main (84cf362) has `src/ui/v2/__tests__/no-em-dash.guard.test.tsx`. Merged origin/main into this branch (normal merge, no rebase). Conflicts: `src/config/product-claims.test.ts` (kept main's dash-free describe title, kept this branch's it-title), `CLAUDE.md` and `AGENTS.md` (took main's file, then regenerated: `gen-claude-state.mjs --write`, `check-agents-parity.mjs --write`; vitest count 476). `product-claims.ts` auto-merged. The `PRIVACY_TERMS_EXEMPT` constant and its three uses (file list, `PRIVACY_` key prefix, the `These copies stay…` source node) and the "exemption is exactly" test are deleted from the guard; the header now points Privacy/Terms render coverage at `privacy-copy.test.tsx`. Deleting it made the guard fail on two real hits, both the `description` metadata of `src/app/privacy/layout.tsx` and `src/app/terms/layout.tsx` (em dash); fixed with a colon (the Privacy one also lost the word "analytics").
- [x] Owner decisions round 2 (2026-11-12): (a) §3.2 and §8 name Vercel's aggregate breakdown, cited below; (b) §6 reservation sentence; (c) no database change, retention stays the owner's; (d) `wallet_activity` stays as left.
- [x] Verify (`scripts/agent-verify.sh --codeql`), hosts capture, compare link

### Owner answer (premise)
`src/lib/wallet-activity-tracker.ts` (not named in the goal) also stored the same `teraswap_session_id` and posts wallet-keyed
swap/approval/quote/order/error/`ui` events to `/api/log-activity` (table `wallet_activity`). Owner: **drop the session id only**; the
wallet-keyed product events stay and Privacy §3.2 must disclose them.

### Evidence 1: what the tracker sent, and proof nothing is sent now
- Sent to `/api/log-event` (`archive/src/components/UsageTracker.tsx`): `session_id` (random UUID in `sessionStorage` `teraswap_session_id`, :6-13),
  `event_type` (`page_view` / `click` / `session_end`), `page` (pathname), `referrer` (`document.referrer`), `screen_w` (`window.innerWidth`),
  `user_agent` (`navigator.userAgent`), `duration_ms` (time on page), and for clicks `click_target` (label/text ≤ 80), `click_tag`, `click_id`, `click_class`.
- Now: `UsageTracker` is no longer imported or mounted (`src/app/providers.tsx`); the file lives at `archive/src/components/UsageTracker.tsx` (git rename).
  `POST /api/log-event` answers 204, never reads the body, requests no DB client (`src/app/api/log-event/route.ts`); rate limit (`log:<ip>`) and the header-only size guard kept.
- Proof: `src/app/providers.no-usage-tracking.test.tsx` mounts the real `Providers`, changes route, clicks 13 times, hides the tab, runs 30 s of timers: zero
  fetch/sendBeacon to `/api/log-event`, no `teraswap_session_id`. Mutation check: re-mounting the archived tracker made both tests fail. `route.test.ts` (204, body not read, no DB).
  `wallet-activity-tracker.no-session-id.test.ts` and `log-activity/route.no-session-id.test.ts` (session id not sent, stored as null even from an old bundle).

### Evidence 2: readers of the usage-event data (table `usage_events`)
| reader | before | after |
|---|---|---|
| `src/app/api/monitor/route.ts` (`GET /api/monitor`, Bearer MONITOR_SECRET) | selected 10 000 rows, built `usage{totals,totalClicks,avgSessionDurationSec,devices,pageBreakdown,topClicks,dailyUsageTimeseries}` | no query; `usage: { collected: false, note: 'not collected' }` (`route.usage-not-collected.test.ts`) |
| `AdminMonitor.tsx`, `/status`, `source-health-monitor`, watchdog, health report | none read `usage` (grep for the keys over src, scripts, workers, .github: no other hit) | unchanged |
Nothing a visitor sees read it. **Database untouched:** table `usage_events` (rows from before this change, plus its TTL/index SQL in `supabase/improvements.sql`, comment in `supabase/schema.sql:125`) stays; retention is the owner's decision. `wallet_activity` stays too.

### Findings / extra reads
- Allow-listed reads I first skipped and then did (late, after the Stop hook flagged it): `docs/Runbooks/agent-harness.md` (layer 0 refuses the bare word `security` in command text, so a grep pattern containing it was blocked; rewrite the pattern), and `e2e/third-party-hosts/{allow-list,capture.pw}.ts` plus a grep of the whole directory. Finding: the rig already records same-origin `/api/*` calls per path (`rig.ts`, `sameOriginApi`), so `capture.pw.ts` now also asserts `/api/log-event` is never called in a real v1/v2 page load on all 3 chains (6 passed, 2026-11-12). That assertion was not mutation-checked (a rebuild with the old tracker was not run); the Providers unit test was.
- Extra read beyond the allow-list: `src/lib/wallet-activity-tracker.ts`, `src/app/api/log-activity/route.ts`, `src/components/AdminMonitor.tsx`, `src/app/admin/page.tsx`, rpc-budget tests (they mocked `@/components/UsageTracker`; mocks removed).
- Test gap noted: no test existed for `/api/monitor`; only the usage section is covered now.

### Evidence 3: content-map delta (Privacy v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help, Docs and Terms inherit the constants)
Grep for any wallet-screening call (`chainalysis|trm|elliptic|scorechain|ofac|sanctions list|blockchain analytics` over src, workers, scripts, supabase, .github): **no hit in code**, only in the Privacy/Terms copy itself. So the screening and analytics-sharing sentences were false.
| where | before | after | proof |
|---|---|---|---|
| §3.1 | "we access publicly-available blockchain data, including your wallet address and transaction history … We may screen wallet addresses using third-party blockchain analytics providers" | "we read publicly-available blockchain data for the connected address, such as balances, orders, and swap history, to show them to you." (screening sentence removed) | balances `usePortfolio.ts:304` (`useBalance`, via /api/rpc), orders `order-engine/supabase.ts:99`, history `WalletHistory.tsx:131`, `use-wallet-history.ts:28`; screening: grep above |
| §3.2 (heading now "Data We Collect and Store") | "we may automatically collect … device type, operating system, browser type and version, and general usage patterns" | "Our own code does not collect your device type, operating system, browser, clicks, or usage patterns, and the Interface sets no tracking cookies. Page views are counted by Vercel Web Analytics, which uses no cookies and reports them in aggregate by country, device type, operating system, and browser (see section 8)." (round 2: "Our own code", and the Vercel clause) | Evidence 1; only cookie is `ts_ui`, set by the owner-only `api/admin/ui-version/route.ts:61`; `<Analytics />` `layout.tsx:106` |
| §3.2 IP sentence | unchanged (`PRIVACY_IP_STORAGE_NOTE`) | unchanged | `client-ip-key.ts:8` |
| §3.2 / Help / Docs note (`PRIVACY_WALLET_STORAGE_NOTE`) | "We do store wallet addresses for orders, swap history and activity." | "We store your wallet address with your orders, swap history and quotes, because the Orders, History and Analytics tabs are built from them, and with a log of the steps of each swap, approval, quote and order (including errors), which we use for debugging and support." | orders `api/orders/route.ts`, swaps `log-swap/route.ts:134`, quotes `log-quote/route.ts:59-71` (read by `/api/stats` `stats/route.ts:24,40`, fetched by the Analytics tab `use-public-stats.ts:22`), log = `wallet_activity` `log-activity/route.ts:106`, `wallet-activity-server.ts:41` |
| §3.3 (`PRIVACY_LOCAL_COPIES_NOTE`) | same meaning; "…; separately, … (see 3.2) [em dash] that server record…" | same meaning, em dash and semicolon replaced by two sentences and a semicolon | `privacy-copy.test.tsx` §3.3 |
| §4 | list had "Screen wallets for compliance …" and "Analyze usage patterns …" | both removed; added "Show you the orders, swap history, and analytics for your connected wallet" | screening: grep above; usage: Evidence 1 |
| §6 | "We may share wallet addresses with blockchain analytics providers to comply with applicable laws and regulations." | round 1: sentence removed. Round 2 (owner): added after "We do not sell, rent, or trade …": "We may disclose the records described in section 3.2 when a law or a valid legal order requires it." A reservation, no analytics provider named | grep above; `privacy-copy.test.tsx` §6 test (also asserts no "analytics provider" / "screen") |
| §8 | "…Page views are counted by Vercel Web Analytics, our hosting provider's analytics, which is loaded from our own domain. No third-party error-reporting …" | adds: "It uses no cookies, and it reports page views in aggregate by country, device type, operating system, and browser. TeraSwap's own code does not collect or store any of that." | Vercel docs below; `privacy-copy.test.tsx` §8 test |
| §10 | "We retain automatically collected technical data only for as long as necessary …" | "We retain the records described in section 3.2 only for as long as necessary …" | no technical data collected any more |
| §11 | "…minimal personal data and most data is stored locally on your device, you can exercise most of these rights by clearing …local storage." | "…minimal personal data, you can exercise some of these rights by clearing …local storage. For the records we store with your wallet address (see section 3.2), or any other data-related request, please contact us…" | server records exist (§3.2) |
| Last updated | March 16, 2026 | November 12, 2026 (unchanged in round 2, same day) | |
| Terms | no sentence about collected data (only "not set or collected by TeraSwap", validator fees) | unchanged | grep |
Dashes: the only U+2014 in rendered Privacy/Terms/`PRIVACY_*` was `PRIVACY_LOCAL_COPIES_NOTE`; a test now covers v1+v2 Privacy and Terms and every `PRIVACY_*` constant. Help/Docs read the same constants (`help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474`); `check-product-claims.mjs` green.
Vercel's aggregate breakdown (owner decision 2026-11-12, verified against Vercel's documentation, read 2026-11-12; the Docs/API pages read through `search_vercel_documentation` and a web fetch of the three pages below):
- No cookies: https://vercel.com/docs/analytics says "Web Analytics only stores anonymized data and does not use cookies" and "Instead of relying on cookies like many analytics products, visitors are identified by a hash created from the incoming request. The generated hash is valid for a single day, at which point it is automatically reset." https://vercel.com/docs/analytics/privacy-policy says "without using any third-party cookies, instead end users are identified by a hash created from the incoming request."
- Country, device, OS, browser: https://vercel.com/docs/analytics says the dashboard shows "additional information such as the country, OS, and device or browser of your visitors"; https://vercel.com/docs/analytics/filtering lists Country, Browsers, Devices, Operating System as filters; the privacy-policy page's data-point table lists Geolocation, Device OS & Version, Browser & Version and "Device Type | Mobile (or Desktop/Tablet)"; the REST/MCP query API groups by `country`, `deviceType`, `osName`, `browserName`.
- Aggregate: privacy-policy page: "By default, Vercel Web Analytics allows you to use only aggregated data that can not identify or re-identify customers' end users" and "A minimal amount of data is collected and it is used for aggregated statistics only."
- Limits of that evidence (so the copy does not claim more): the pages never say "no first-party storage" (the privacy page says "third-party cookies", the main page says "does not use cookies"); the data-point table lists per-event fields and the docs do not say whether a per-visitor view exists in the dashboard or API. The copy therefore says "uses no cookies" and "reports ... in aggregate", and says nothing about per-visitor storage. The API also documents `visitorId`/`userId` fields in its aggregate response schema; the owner may want to read that against "aggregate" before an Auditor signs off.
CLAUDE.md/AGENTS.md: the generated "Test files: vitest" count is 476 after the merge (main 471 + five new test files); regenerated, not hand-merged.

### Evidence 4: verify (`scripts/agent-verify.sh --codeql`, head 632324d, base origin/main 0062400)
suite PASS 10348 tests, 0 failed, 473 files · lint-delta PASS +0 err +0 warn · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 33 · CodeQL security-extended PASS head 13 / base 13 / new 0
Also: `check-product-claims.mjs` PASS; `gen-claude-state.mjs --check` PASS; `check-agents-parity.mjs` PASS; third-party-hosts capture (marker build, `e2e/third-party-hosts`, v1+v2, 3 chains, wallets, bundle) 13 passed.
First verify run (0dbf387) failed 3: my Providers test imported `ui/v2` (isolation + parity), and the archived tracker raised one `react-hooks/purity` warning at its new path; both fixed in the last commit.
Diff: 23 files, +432 -266 (`git diff --stat origin/main...HEAD`). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-no-usage-tracking
Auditor required: yes, Privacy copy and a retired telemetry route; no fund-flow change. Owner decisions left: retention of table `usage_events` (and `wallet_activity`), the §6 legal reservation, and whether §3.2 should also mention Vercel's aggregate device/browser breakdown.

### Evidence 5: verify after merging origin/main (round 2; `scripts/agent-verify.sh --codeql`, head a839029, base origin/main 84cf362)
suite PASS 10394 tests, 0 failed, 476 files · lint-delta PASS +0 err +0 warn · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 33 · CodeQL security-extended PASS head 13 / base 13 / new 0 · `check-product-claims.mjs` PASS · `gen-claude-state.mjs --check` and `check-agents-parity.mjs` PASS (regenerated, not hand-merged).
Diff vs origin/main: 27 files, +485 -309. No database, orders, swap history, quote logging, Vercel Web Analytics, CSP, rate-limit, signing or dependency change. Hosts capture not re-run in round 2 (no network-path code changed since the 6 passed on 8476cc3).
Owner decisions still open: retention of `usage_events` and `wallet_activity`; Auditor pass (Privacy copy plus a retired telemetry route).

## Round 3: A78 (0C/1H) fixes, owner rulings 2026-11-12
Commits on top of 381cf84, all SSH-signed, no rebase: 185d5b6 (S-1/S-4 quote logging), f31f129 (Vercel Web Analytics removed), 253dccd (copy S-1/S-2/S-3/S-5/S-6), d34ac41 (S-7 log-event), d140175 (isolation fix to my own guard).
- [x] C1 quote logging  - [x] C2 analytics removal  - [x] C3 copy  - [x] C4 log-event  - [x] verify, hosts capture, claims, state check

### Evidence 1: S-1/S-4 quote logging
- `useQuote` logs only with `{ logQuote: true }` (default off). On: `SwapBox` (v1), `SwapCard` (v2). Off: v1 `LandingPage`, v2 `Hero`.
- `useQuote.log-quote.test.ts` (real hook + real logger, valid echoing quote): landing, no wallet, three 15 s refreshes = 4 quotes stored, **0** `/api/log-quote`; landing with a wallet 0; swap screen no wallet = 1 request, 11 fields, no wallet/session/device/referrer; with wallet = carries it; each swap-screen refresh = 1. Mutation (default on) fails 2 tests. Caller guard pins the opt-in on all four files.
- Capture `quote-logging.pw.ts` (real Chromium, production build, `/api/quote` answers a valid quote): v1 and v2 both landing 35 s = 3 `/api/quote`, **0** `/api/log-quote`; swap screen, amount typed = 1 `/api/quote`, **1** `/api/log-quote`, body fields `allQuotes amountIn bestAmountOut bestSource responseTimeMs sourcesQueried sourcesResponded tokenIn tokenInSymbol tokenOut tokenOutSymbol`. (Old head: the landing posted on every refresh, A78 measurement.)
- Readers of `quotes` and what changes (rows stop growing per landing visitor; old rows stay):
  | reader | use | change |
  |---|---|---|
  | `GET /api/stats` (`stats/route.ts:24,40`) | public Analytics tab "Total quotes" (count), "Top quote winners" (last 1000 rows) | total grows only with swap-screen quotes; winners now reflect real pairs, not the 0.5 ETH→USDC preview |
  | `GET /api/monitor` (`monitor/route.ts:138`, Bearer) | per-source quotes/wins/failures/avg ms over the last 2000 rows | same sample basis shift: swap-screen quotes only |
  | `GET /api/monitor?wallet=` (`:79`) | that wallet's last 100 quotes | unchanged; preview rows never carried a wallet unless connected |
  | `GET /api/health` (`health/route.ts:67`) | table-exists probe, no numbers | none |
  | view `quote_price_source_daily_stats` (migration 20260912120000) | per-day per-source response counts; no code reader | lower daily counts |
  | `log-quote` side effects (`wallet_activity` `quote_requested`, `trackQuoteFailure`) | fire only from that route | same reduction |

### Evidence 2: analytics removal
- Diff: `src/app/layout.tsx` -2 (import + `<Analytics />`), `package.json` -1, `package-lock.json` -55 (npm 11.10.1 wrote it: the `@vercel/analytics` entry plus four `libc` fields npm dropped from optional platform packages; not hand-edited). No CSP or allow-list entry existed: it was same-origin `/_vercel/insights`, covered by `connect-src 'self'`.
- Grep: `grep -rn "vercel/analytics\|_vercel/insights\|va.vercel-scripts" src package.json csp-policy.js next.config.js e2e` = only the new bundle test and the Privacy test that asserts absence. New bundle test (`bundle.pw.ts`): old build chunk `audit-privacy-a78/.next/static/chunks/2dbz28y4_u9e1.js` contains `_vercel/insights` (positive control); new build 0 files.

### Evidence 3: content-map delta (v1 == v2; Help and Docs read the same constants)
| where | before | after | proof |
|---|---|---|---|
| Privacy 3.1 | "…such as balances, orders, and swap history, to show them to you." | "…such as token balances and allowances, and we look up the orders and swap history our server holds for that address (see 3.2), to show them to you." | balances/allowances: wagmi reads via `/api/rpc`; orders/history: `/api/orders`, `/api/history` (`privacy-copy.test.tsx` §3.3 block) |
| Privacy 3.2 first sentence | "Our own code does not collect your device type, operating system, browser, clicks, or usage patterns, and the Interface sets no tracking cookies. Page views are counted by Vercel Web Analytics…(see section 8)." | "Our own code does not record the pages you view or your clicks, and it does not collect your device type, operating system, or browser. The Interface sets no tracking cookies and uses no analytics service." | `providers.no-usage-tracking.test.tsx`, `log-event/route.test.ts`, capture asserts `/api/log-event` = 0; analytics removed (Evidence 2) |
| wallet-storage note (3.2, Help "What data…", Docs v1/v2) | ends "…debugging and support." | + "Each quote you request on the swap screen, including its automatic refresh, is logged with its token pair, amount, and the sources' answers; the log carries your wallet address when a wallet is connected and no identifier when none is." | Evidence 1 (tests + capture); `product-claims.test.ts`, `help-content.test.ts` pin the string |
| Privacy 8 | cookies/ads sentence + two sentences on Vercel Web Analytics + "(via localStorage)" | "The Interface sets no cookies for visitors, uses no analytics service, and runs no advertising scripts. No third-party error-reporting or session-replay service runs in your browser. Any data stored in your browser (local storage, session storage, and the wallet libraries' own storage) is used solely for your convenience and remains on your device." | only cookie writer in `src` is `api/admin/ui-version/route.ts` (owner-only), tested; Sentry not initialised (`sentry-not-initialised.test.ts`, `docs/security/SENTRY-STATUS.md`); no third-party host (capture); no ad script (CSP + capture) |
| Privacy 10 | "We retain the records described in section 3.2 only for as long as necessary to fulfill the purposes outlined in this Privacy Policy." | "We keep the records described in section 3.2 until you ask us to delete them (see section 11) or we no longer need them; no fixed deletion period applies." (blockchain sentence kept) | no deletion job exists in `src`/`supabase`; the sentence promises none |
| page metadata | privacy/terms `description` | unchanged: names no analytics, no cookie or retention claim | grep |
IP sentence unchanged. In JSX the apostrophes render typographic (`&rsquo;`) as elsewhere; the constant keeps the owner's straight apostrophe. Premise note: the goal's "§3.1 … (see 3.2)" and "§8 claims nothing the code does not prove": the kept sentence "runs no advertising scripts" rests on CSP + capture, not on a named test.

### Evidence 4: verify, S-7, diff
- S-7: `log-event/route.ts` uses `checkRateLimitWithin`; `route.hung-kv.test.ts` (real limiter, every Redis call hangs) answers 204 in ~1.0 s (< 1.5 s asserted); same test against the old route times out at 10 s. `log-routes.hardening.test.ts` mock extended. Not changed (outside the ruling): `log-quote`, `log-swap`, `log-activity` still await `checkRateLimit` (same ~4.5 s when Redis is down); say if you want them moved.
- `scripts/agent-verify.sh --codeql` head d140175 base origin/main 84cf362: suite PASS 10410/0 failed, 478 files · lint-delta PASS +0/+0 · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 33 · CodeQL PASS head 13 / base 13 / new 0. First run failed 2 (my guard named the v2 path in a v1-side file; fixed in d140175).
- Hosts capture (build with the CI env incl. Base/Arbitrum FeeCollector and marker values): 16 passed (bundle ×2, capture ×6, cow ×2, quote-logging ×2, wallet ×4). A first run on a build without the FeeCollector vars failed 6 (Base/Arbitrum options disabled): environment, not code.
- `check-product-claims.mjs` PASS · `gen-claude-state.mjs --check` PASS · `check-agents-parity.mjs` PASS (regenerated in 253dccd and d34ac41). No change to orders, swap history, swap-screen quote logging, wallet activity log, rate-limit numbers, signing, database.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-no-usage-tracking. Auditor required: yes (privacy copy, telemetry removal).
- Not run: `goal-lint` on the goal text (no `CONTROL:` first line, same as earlier rounds).
