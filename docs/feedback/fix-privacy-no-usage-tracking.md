## Feedback — fix/privacy-no-usage-tracking

Owner decision: the site stops recording how visitors use it; keeps orders, swap history, quotes (with the wallet address) and Vercel Web Analytics' aggregate page-view counter (Privacy §8). v1 and v2 together.

### Checklist
- [x] C1 remove our own usage tracking (commit recorded below)
- [ ] C2 Privacy §3 says what is true (v1 == v2) + aligned statements
- [ ] C3 hand-off: `fix/ui-v2-walkthrough-polish` guard test (not on origin/main at the time of writing, see C3 below)
- [ ] Verify (`scripts/agent-verify.sh --codeql`), compare link

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
