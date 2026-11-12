## Feedback — fix/privacy-no-usage-tracking

Owner decision: the site stops recording how visitors use it; keeps orders, swap history, quotes (with the wallet address) and Vercel Web Analytics' aggregate page-view counter (Privacy §8). v1 and v2 together.

### Checklist
- [x] C1 remove our own usage tracking (commit recorded below)
- [x] C2 Privacy §3 says what is true (v1 == v2) + aligned statements
- [x] C3 hand-off: not done, by design. `fix/ui-v2-walkthrough-polish` is pushed but its guard test is NOT on origin/main (checked 2026-11-12 after `git fetch`), so nothing was merged and no exemption exists to delete here. Follow-up when that PR lands: merge origin/main into this branch, delete the Privacy/Terms exemption, run `privacy-copy.test.tsx` (it already asserts no U+2014 and no spaced U+2013 in Privacy, Terms and every `PRIVACY_*` constant, v1 and v2).
- [x] Verify (`scripts/agent-verify.sh --codeql`), hosts capture, compare link

### Owner answer (premise)
`src/lib/wallet-activity-tracker.ts` (not named in the goal) also stored the same `teraswap_session_id` and posts wallet-keyed
swap/approval/quote/order/error/`ui` events to `/api/log-activity` (table `wallet_activity`). Owner: **drop the session id only**; the
wallet-keyed product events stay and Privacy §3.2 must disclose them.

### Evidence 1 — what the tracker sent, and proof nothing is sent now
- Sent to `/api/log-event` (`archive/src/components/UsageTracker.tsx`): `session_id` (random UUID in `sessionStorage` `teraswap_session_id`, :6-13),
  `event_type` (`page_view` / `click` / `session_end`), `page` (pathname), `referrer` (`document.referrer`), `screen_w` (`window.innerWidth`),
  `user_agent` (`navigator.userAgent`), `duration_ms` (time on page), and for clicks `click_target` (label/text ≤ 80), `click_tag`, `click_id`, `click_class`.
- Now: `UsageTracker` is no longer imported or mounted (`src/app/providers.tsx`); the file lives at `archive/src/components/UsageTracker.tsx` (git rename).
  `POST /api/log-event` answers 204, never reads the body, requests no DB client (`src/app/api/log-event/route.ts`); rate limit (`log:<ip>`) and the header-only size guard kept.
- Proof: `src/app/providers.no-usage-tracking.test.tsx` mounts the real `Providers`, changes route, clicks 13 times, hides the tab, runs 30 s of timers: zero
  fetch/sendBeacon to `/api/log-event`, no `teraswap_session_id`. Mutation check: re-mounting the archived tracker made both tests fail. `route.test.ts` (204, body not read, no DB).
  `wallet-activity-tracker.no-session-id.test.ts` and `log-activity/route.no-session-id.test.ts` (session id not sent, stored as null even from an old bundle).

### Evidence 2 — readers of the usage-event data (table `usage_events`)
| reader | before | after |
|---|---|---|
| `src/app/api/monitor/route.ts` (`GET /api/monitor`, Bearer MONITOR_SECRET) | selected 10 000 rows, built `usage{totals,totalClicks,avgSessionDurationSec,devices,pageBreakdown,topClicks,dailyUsageTimeseries}` | no query; `usage: { collected: false, note: 'not collected' }` (`route.usage-not-collected.test.ts`) |
| `AdminMonitor.tsx`, `/status`, `source-health-monitor`, watchdog, health report | none read `usage` (grep for the keys over src, scripts, workers, .github: no other hit) | unchanged |
Nothing a visitor sees read it. **Database untouched:** table `usage_events` (rows from before this change, plus its TTL/index SQL in `supabase/improvements.sql`, comment in `supabase/schema.sql:125`) stays; retention is the owner's decision. `wallet_activity` stays too.

### Findings / extra reads
- Extra read beyond the allow-list: `src/lib/wallet-activity-tracker.ts`, `src/app/api/log-activity/route.ts`, `src/components/AdminMonitor.tsx`, `src/app/admin/page.tsx`, rpc-budget tests (they mocked `@/components/UsageTracker`; mocks removed).
- Test gap noted: no test existed for `/api/monitor`; only the usage section is covered now.

### Evidence 3 — content-map delta (Privacy v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help, Docs and Terms inherit the constants)
Grep for any wallet-screening call (`chainalysis|trm|elliptic|scorechain|ofac|sanctions list|blockchain analytics` over src, workers, scripts, supabase, .github): **no hit in code**, only in the Privacy/Terms copy itself. So the screening and analytics-sharing sentences were false.
| where | before | after | proof |
|---|---|---|---|
| §3.1 | "we access publicly-available blockchain data, including your wallet address and transaction history … We may screen wallet addresses using third-party blockchain analytics providers" | "we read publicly-available blockchain data for the connected address, such as balances, orders, and swap history, to show them to you." (screening sentence removed) | balances `usePortfolio.ts:304` (`useBalance`, via /api/rpc), orders `order-engine/supabase.ts:99`, history `WalletHistory.tsx:131`, `use-wallet-history.ts:28`; screening: grep above |
| §3.2 (heading now "Data We Collect and Store") | "we may automatically collect … device type, operating system, browser type and version, and general usage patterns" | "We do not collect your device type, operating system, browser, clicks, or usage patterns, and the Interface sets no tracking cookies. Page views are counted in aggregate by Vercel Web Analytics (see section 8)." | Evidence 1; only cookie is `ts_ui`, set by the owner-only `api/admin/ui-version/route.ts:61`; `<Analytics />` `layout.tsx:106` |
| §3.2 IP sentence | unchanged (`PRIVACY_IP_STORAGE_NOTE`) | unchanged | `client-ip-key.ts:8` |
| §3.2 / Help / Docs note (`PRIVACY_WALLET_STORAGE_NOTE`) | "We do store wallet addresses for orders, swap history and activity." | "We store your wallet address with your orders, swap history and quotes, because the Orders, History and Analytics tabs are built from them, and with a log of the steps of each swap, approval, quote and order (including errors), which we use for debugging and support." | orders `api/orders/route.ts`, swaps `log-swap/route.ts:134`, quotes `log-quote/route.ts:59-71` (read by `/api/stats` `stats/route.ts:24,40`, fetched by the Analytics tab `use-public-stats.ts:22`), log = `wallet_activity` `log-activity/route.ts:106`, `wallet-activity-server.ts:41` |
| §3.3 (`PRIVACY_LOCAL_COPIES_NOTE`) | same meaning; "…; separately, … (see 3.2) — that server record…" | same meaning, em dash and semicolon replaced by two sentences and a semicolon | `privacy-copy.test.tsx` §3.3 |
| §4 | list had "Screen wallets for compliance …" and "Analyze usage patterns …" | both removed; added "Show you the orders, swap history, and analytics for your connected wallet" | screening: grep above; usage: Evidence 1 |
| §6 | "We may share wallet addresses with blockchain analytics providers to comply with applicable laws and regulations." | sentence removed ("We do not sell, rent, or trade …" kept) | grep above. Judgement call: if the owner wants a legal-compliance reservation back, it must be worded as a reservation, not a practice |
| §10 | "We retain automatically collected technical data only for as long as necessary …" | "We retain the records described in section 3.2 only for as long as necessary …" | no technical data collected any more |
| §11 | "…minimal personal data and most data is stored locally on your device, you can exercise most of these rights by clearing …local storage." | "…minimal personal data, you can exercise some of these rights by clearing …local storage. For the records we store with your wallet address (see section 3.2), or any other data-related request, please contact us…" | server records exist (§3.2) |
| Last updated | March 16, 2026 | November 12, 2026 | |
| Terms | no sentence about collected data (only "not set or collected by TeraSwap", validator fees) | unchanged | grep |
Dashes: the only U+2014 in rendered Privacy/Terms/`PRIVACY_*` was `PRIVACY_LOCAL_COPIES_NOTE`; a test now covers v1+v2 Privacy and Terms and every `PRIVACY_*` constant. Help/Docs read the same constants (`help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474`); `check-product-claims.mjs` green.
Concern for the owner: Vercel's own Web Analytics dashboard breaks page views down by country, OS, browser and device in aggregate. "We do not collect your device type, operating system, browser" is true of TeraSwap's own code; if the owner wants the sentence to cover Vercel's aggregate counter too, §8 needs one more clause.
CLAUDE.md/AGENTS.md: the generated "Test files: vitest" count moved 468 to 473 (five new test files); regenerated with `gen-claude-state.mjs --write` + `check-agents-parity.mjs --write`.

### Evidence 4 — verify (`scripts/agent-verify.sh --codeql`, head 632324d, base origin/main 0062400)
suite PASS 10348 tests, 0 failed, 473 files · lint-delta PASS +0 err +0 warn · tsc PASS 0 · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 33 · CodeQL security-extended PASS head 13 / base 13 / new 0
Also: `check-product-claims.mjs` PASS; `gen-claude-state.mjs --check` PASS; `check-agents-parity.mjs` PASS; third-party-hosts capture (marker build, `e2e/third-party-hosts`, v1+v2, 3 chains, wallets, bundle) 13 passed.
First verify run (0dbf387) failed 3: my Providers test imported `ui/v2` (isolation + parity), and the archived tracker raised one `react-hooks/purity` warning at its new path; both fixed in the last commit.
Diff: 23 files, +432 -266 (`git diff --stat origin/main...HEAD`). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-no-usage-tracking
Auditor required: yes, Privacy copy and a retired telemetry route; no fund-flow change. Owner decisions left: retention of table `usage_events` (and `wallet_activity`), the §6 legal reservation, and whether §3.2 should also mention Vercel's aggregate device/browser breakdown.
