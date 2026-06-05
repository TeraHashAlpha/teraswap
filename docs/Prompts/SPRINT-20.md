# Sprint 20 — External LOW Findings Triage & Fix

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** EXT-L-01, EXT-L-02, EXT-L-04 (external analysis backlog)
**Branch:** `fix/external-lows` (single branch, single PR)
**Estimated effort:** ~0.15 pw (3 prompts)

---

## Motivation

The external technical analysis (2026-04-22) identified 4 Low findings. EXT-L-03
(Telegram callback admin validation) was already mitigated on review. The remaining
3 have been in backlog since Sprint 17. This sprint closes all of them.

**Deploy strategy:** Single branch `fix/external-lows`, one commit per prompt,
one PR. Two files are production code changes (CORS + analytics-tracker), both
low-risk and backwards-compatible.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 128 | Restrict CORS on logging endpoints (EXT-L-01) | 10 | 1 | 0.95 | 0.05 | 190.0 | P0 |
| 129 | Proactive localStorage cap in analytics-tracker (EXT-L-02) | 6 | 1 | 0.90 | 0.05 | 108.0 | P1 |
| 130 | Move seed data to dev-only module (EXT-L-04) | 4 | 1 | 0.85 | 0.05 | 68.0 | P2 |

---

## Prompt 128 — Restrict CORS on Logging Endpoints (EXT-L-01)

**Context:** `src/app/api/log-activity/route.ts` (line 8) and `src/app/api/log-event/route.ts` (line 7) both set `Access-Control-Allow-Origin: '*'`. This allows any origin to submit fake analytics data. The comment says this was intentional for "local dev / preview deploys", but preview deploys run on `*.vercel.app` subdomains which can be allow-listed.

**Objective:** Replace the wildcard CORS with an origin allow-list.

**Requirements:**

1. Create a shared CORS utility at `src/lib/cors.ts`:

   ```typescript
   const ALLOWED_ORIGINS = [
     'https://teraswap.app',
     'https://www.teraswap.app',
   ]

   /** Returns CORS origin header value, or null if origin not allowed */
   export function getAllowedOrigin(request: Request): string | null {
     const origin = request.headers.get('origin')
     if (!origin) return null

     // Allow exact matches
     if (ALLOWED_ORIGINS.includes(origin)) return origin

     // Allow Vercel preview deploys
     if (origin.endsWith('.vercel.app')) return origin

     // Allow localhost for development
     if (origin.startsWith('http://localhost:')) return origin

     return null
   }
   ```

2. In both `log-activity/route.ts` and `log-event/route.ts`:
   - Import `getAllowedOrigin` from `@/lib/cors`
   - Replace the static `CORS_HEADERS` object with a function that takes the request:
     ```typescript
     function corsHeaders(request: Request) {
       const origin = getAllowedOrigin(request) || 'https://teraswap.app'
       return {
         'Access-Control-Allow-Origin': origin,
         'Access-Control-Allow-Methods': 'POST, OPTIONS',
         'Access-Control-Allow-Headers': 'Content-Type',
         'Vary': 'Origin',
       }
     }
     ```
   - Update all `Response` constructors to use `corsHeaders(request)` instead of `CORS_HEADERS`
   - The `OPTIONS` handler and `POST` handler both receive `request` — pass it through

3. Add the `Vary: Origin` header to prevent CDN caching issues with different origins.

4. Run `npx tsc --noEmit` and `npm test` to verify.

**Do NOT:**
- Change any other API routes (only log-activity and log-event)
- Add authentication to these endpoints (they're public analytics)
- Block requests from unknown origins with 403 — just default to the production origin (browser will enforce CORS)

**Files affected:**
- `src/lib/cors.ts` (NEW — shared utility)
- `src/app/api/log-activity/route.ts` (replace wildcard CORS)
- `src/app/api/log-event/route.ts` (replace wildcard CORS)

**Quality criteria:**
- `npx tsc --noEmit` clean
- `npm test` passes (746 tests)
- No `'*'` in any CORS header in the two affected files
- `Vary: Origin` present in all responses

---

## Prompt 129 — Proactive localStorage Cap in analytics-tracker (EXT-L-02)

**Context:** `src/lib/analytics-tracker.ts` uses localStorage as an offline cache for trade events. The current `saveEvents()` (line 31-43) has a try-catch that trims to 5000 events only AFTER `setItem` throws a quota error. There is no proactive cap — events grow unbounded until the ~5-10MB quota is hit, at which point `JSON.parse` of a multi-MB string can crash the dashboard.

The `loadEvents()` function (line 20-28) already has a try-catch around `JSON.parse` which is good. But the real fix is preventing unbounded growth.

**Objective:** Add a proactive rolling window cap to `saveEvents()`.

**Requirements:**

1. In `src/lib/analytics-tracker.ts`, add a constant near the top:
   ```typescript
   /** Max events to keep in localStorage (proactive cap — EXT-L-02) */
   const MAX_LOCAL_EVENTS = 2000
   ```

2. Modify `saveEvents()` to proactively trim BEFORE writing:
   ```typescript
   function saveEvents(events: TradeEvent[]): void {
     if (typeof window === 'undefined') return
     // Proactive cap — keep most recent events only (EXT-L-02)
     const capped = events.length > MAX_LOCAL_EVENTS
       ? events.slice(-MAX_LOCAL_EVENTS)
       : events
     try {
       localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(capped))
     } catch {
       // Quota still exceeded — trim further
       const trimmed = capped.slice(-500)
       try {
         localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(trimmed))
       } catch {
         // give up
       }
     }
   }
   ```

3. This is backwards-compatible — old data loads fine, just gets capped on next write.

4. Run `npx tsc --noEmit` and `npm test` to verify.

**Do NOT:**
- Change the Supabase sync logic
- Change `loadEvents()` (it's already safe)
- Add any new dependencies
- Change the `trackTrade()` function signature

**Files affected:**
- `src/lib/analytics-tracker.ts` (add MAX_LOCAL_EVENTS constant + proactive trim)

**Quality criteria:**
- `npx tsc --noEmit` clean
- `npm test` passes (746 tests)
- `saveEvents` caps at 2000 before attempting write

---

## Prompt 130 — Move Seed Data to Dev-Only Module (EXT-L-04)

**Context:** `src/lib/analytics-tracker.ts` lines 368-524 contain ~150 lines of seed data generation (`seedDemoData()`, `SEED_WALLETS`, `SEED_PAIRS`, etc.). The function has a `process.env.NODE_ENV === 'production'` runtime guard, and the comment claims tree-shaking strips it when `seedDemoData` is not imported. However, the module-level constants (`SEED_WALLETS`, `SEED_PAIRS`, `SEED_SOURCES`, `SEED_TYPES`) and helper functions are declared at module scope and may survive tree-shaking if any other export from the file is imported (which it is — `trackTrade`, `computeDashboard`, etc. are imported in production code).

**Objective:** Move all seed data to a separate dev-only module so it is never bundled in production, regardless of tree-shaking behaviour.

**Requirements:**

1. Create `src/lib/analytics-seed.ts` with ALL seed-related code extracted from `analytics-tracker.ts`:
   - Move the `SEED_WALLETS`, `SEED_PAIRS`, `SEED_SOURCES`, `SEED_TYPES` constants
   - Move the helper functions: `randomEl`, `randomBetween`, `randomTxHash`
   - Move the `seedDemoData()` function (keep the NODE_ENV guard as defence-in-depth)
   - Import `saveEvents` — but `saveEvents` is not exported. Instead, have `seedDemoData` import `trackTrade` from `analytics-tracker` to record each event, OR export a minimal `_overwriteEventsForTesting` helper. **Preferred approach:** import the types and `ANALYTICS_STORAGE_KEY` from `analytics-types`, and write directly to localStorage in the seed module (it's a dev-only utility):
     ```typescript
     import type { TradeEvent, TradeType } from './analytics-types'
     import { ANALYTICS_STORAGE_KEY } from './analytics-types'
     import type { AggregatorName } from './constants'
     ```

2. In `analytics-tracker.ts`:
   - Remove everything from line 368 (`// ══════════════════`) to the end of the file (line 524)
   - Remove the `seedDemoData` export

3. Find all imports of `seedDemoData` in the codebase and update them:
   ```bash
   grep -rn "seedDemoData\|analytics-tracker.*seed" src/
   ```
   Update any imports to use `from './analytics-seed'` (or `from '@/lib/analytics-seed'`).

4. Run `npx tsc --noEmit` and `npm test` to verify.

**Do NOT:**
- Change the `seedDemoData` behaviour or its output
- Remove the NODE_ENV production guard (keep it as defence-in-depth)
- Change any production analytics logic in analytics-tracker.ts
- Add the new file to any production import chain

**Files affected:**
- `src/lib/analytics-seed.ts` (NEW — dev-only seed data)
- `src/lib/analytics-tracker.ts` (remove seed block)
- Any file importing `seedDemoData` (update import path)

**Quality criteria:**
- `npx tsc --noEmit` clean
- `npm test` passes (746 tests)
- `grep -rn "SEED_WALLETS\|SEED_PAIRS\|seedDemoData" src/lib/analytics-tracker.ts` returns nothing
- `seedDemoData` still works in dev: function exists in analytics-seed.ts with NODE_ENV guard

---

## Execution order

All 3 prompts on the same branch `fix/external-lows`:

1. P128 first (CORS — new shared utility, then route updates)
2. P129 second (localStorage cap — single-file change)
3. P130 third (seed module split — depends on P129 not changing lines after 368)

One commit per prompt, one PR at the end.

## Post-sprint checklist

- [ ] No wildcard CORS in log-activity or log-event routes
- [ ] `Vary: Origin` header present in logging responses
- [ ] localStorage events capped at 2000 proactively
- [ ] Seed data lives in `analytics-seed.ts`, not `analytics-tracker.ts`
- [ ] `npm test` → 746 pass
- [ ] `npx tsc --noEmit` clean
- [ ] AUDIT-TOTAL.md updated: EXT-L-01, EXT-L-02, EXT-L-04 → CLOSED
