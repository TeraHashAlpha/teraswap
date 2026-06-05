# Sprint 6B — API Authentication + Monitoring Hardening

**Sprint window:** 2026-04-16 → TBD
**Sprint goal:** Close the remaining CRITICAL (API-C-01) and all 4 HIGH API/monitoring findings from the comprehensive audit. Includes cold-start calibration observed in production 2026-04-16.
**Owner:** TeraHash (founder/architect) + code agent
**Audit report:** `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
**Prerequisite:** Sprint 6A COMPLETE (all 4 SC findings closed).

---

## Sprint status table

| # | Prompt | Finding(s) | Severity | Status |
|---|--------|-----------|----------|--------|
| 39 | Tick endpoint auth + GET removal | API-C-01 | CRITICAL | Pending |
| 40 | Heartbeat endpoint split (public/admin) | API-H-01 | HIGH | Pending |
| 41 | Quorum minimum + outlier detection | API-H-02 | HIGH | Pending |
| 42 | Grace period: emit tagged alerts during grace | API-H-03 | HIGH | Pending |
| 43 | Dedup: counter-based + shorter TTL | API-H-04 | HIGH | Pending |
| 44 | Cold-start warm-up discard (production observation) | N/A (ops) | MEDIUM | Pending |

---

## Prompt 39 — Authenticate tick endpoint + remove GET handler (API-C-01, CRITICAL)

**Status:** Pending.

**Context:** The monitoring tick endpoint (`src/app/api/monitor/tick/route.ts`) has a POST handler with Bearer token auth that **short-circuits if `MONITOR_CRON_SECRET` is not set** (line 21). The GET handler (lines 41-53) has **zero authentication** — anyone can trigger a monitoring tick via GET request. An attacker can: (a) trigger ticks at arbitrary frequency causing state machine transitions, (b) flood alerts exhausting Telegram rate limits, (c) amplify KV writes increasing costs.

The Cloudflare Worker calls POST with Bearer token. The GET handler was added for "manual debugging" but is a security hole.

**Objective:** Enforce authentication on all tick invocations. Remove the unauthenticated GET handler.

**Requirements:**

1. **Remove the GET handler entirely** — delete `export async function GET(...)` (lines 41-53). Manual debugging should use curl with the Bearer token, not an open endpoint.

2. **Make POST auth mandatory** — change the auth check (lines 18-23) so that if `MONITOR_CRON_SECRET` is not set, the endpoint returns 503 Service Unavailable (not silently skip auth):
   ```typescript
   const secret = process.env.MONITOR_CRON_SECRET
   if (!secret) {
     console.error('[TICK] MONITOR_CRON_SECRET not configured')
     return NextResponse.json({ error: 'not configured' }, { status: 503 })
   }
   
   const authHeader = req.headers.get('authorization')
   if (authHeader !== `Bearer ${secret}`) {
     return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
   }
   ```

3. **Use constant-time comparison** — the current check uses `!==` (line 23) which is timing-vulnerable. Apply the same SHA-256 + timingSafeEqual pattern used in kill-switch and Telegram webhook:
   ```typescript
   import { timingSafeEqual, createHash } from 'node:crypto'
   
   function verifyBearerToken(provided: string, expected: string): boolean {
     if (!provided || !expected) return false
     const hashA = createHash('sha256').update(provided).digest()
     const hashB = createHash('sha256').update(expected).digest()
     return timingSafeEqual(hashA, hashB)
   }
   ```
   Extract the Bearer token from the header, then compare with `verifyBearerToken(token, secret)`.

4. **Update Cloudflare Worker** — verify that `wrangler.toml` / Worker code sends `Authorization: Bearer {TICK_AUTH_TOKEN}` on the POST request. If the Worker uses a different secret name than `MONITOR_CRON_SECRET`, align them.

5. **Update `.env.example`** — ensure `MONITOR_CRON_SECRET` is documented.

**Files affected:**
- `src/app/api/monitor/tick/route.ts` (remove GET, harden POST auth)
- Cloudflare Worker source if auth header needs updating
- `.env.example`

**Do NOT:**
- Do NOT add a replacement GET handler. Debugging is done via curl with auth.
- Do NOT change the monitoring tick logic (H1/H2/H5 phases). Only the auth layer.
- Do NOT change the response format — downstream (heartbeat, watchdog) may depend on it.

**Quality criteria:**
- GET request returns 405 Method Not Allowed (Next.js default for missing handler).
- POST without auth header returns 401.
- POST with wrong token returns 401.
- POST with correct token returns 200 + tick result.
- POST when MONITOR_CRON_SECRET is unset returns 503.
- Constant-time comparison verified (import crypto, SHA-256 pre-hash).
- All existing monitoring tests pass.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 40 — Split heartbeat into public and admin endpoints (API-H-01, HIGH)

**Status:** Pending.

**Context:** The heartbeat endpoint (`src/app/api/monitor/heartbeat/route.ts`) returns detailed per-source state information publicly with 30s cache. An attacker can see which sources are degraded/disabled, their reasons, quorum outlier counts, and grace period status. This enables timing attacks (exploit when a key source is down) or targeted DoS (focus on degrading sources near the disable threshold).

**Objective:** Split into a minimal public endpoint and a detailed admin-only endpoint.

**Requirements:**

1. **Public heartbeat** (`/api/monitor/heartbeat` — keep existing path):
   Return ONLY:
   ```json
   {
     "healthy": true,
     "ageSeconds": 45,
     "tickFresh": true
   }
   ```
   - `healthy`: boolean (same logic: grace OR tickFresh)
   - `ageSeconds`: seconds since last tick
   - `tickFresh`: boolean (age < 180s)
   - Cache-Control: `public, max-age=30` (keep existing)
   - NO source counts, NO quorum data, NO grace flag

2. **Admin heartbeat** (`/api/monitor/heartbeat/admin/route.ts` — new):
   Return the FULL current response (sources, quorum, grace, etc.)
   - Auth: Bearer token using `MONITOR_CRON_SECRET` (same as tick endpoint) with constant-time comparison
   - Cache-Control: `no-store` (admin data should not be cached)
   - If `MONITOR_CRON_SECRET` not set: return 503

3. **Update GitHub Actions watchdog** — if the watchdog (`*/5 * * * *`) parses the heartbeat response, verify it only needs `healthy` + `ageSeconds`. If it needs more, add the Bearer token to the watchdog workflow secrets.

4. **Update Telegram `/heartbeat` command** — the bot command handler (`src/app/api/telegram/webhook/route.ts`, `handleHeartbeat()` function) reads KV directly, not the heartbeat endpoint. Verify it still works — it should, since it doesn't call the HTTP endpoint.

**Files affected:**
- `src/app/api/monitor/heartbeat/route.ts` (strip to minimal public response)
- `src/app/api/monitor/heartbeat/admin/route.ts` (new — full response with auth)
- `.github/workflows/` (watchdog — verify compatibility)

**Do NOT:**
- Do NOT change the KV reads or heartbeat logic — only the response shape and routing.
- Do NOT change the Telegram bot's `/heartbeat` command (it reads KV directly).
- Do NOT expose source names, states, or reasons in the public endpoint.

**Quality criteria:**
- Public GET `/api/monitor/heartbeat` returns only `healthy`, `ageSeconds`, `tickFresh`.
- Admin GET `/api/monitor/heartbeat/admin` with Bearer returns full data.
- Admin GET without auth returns 401.
- Watchdog still functions (verify in test or verify it only checks `healthy`).
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 41 — Increase quorum minimum + add IQR outlier pre-filter (API-H-02, HIGH)

**Status:** Pending.

**Context:** The quorum check (`src/lib/quorum-check.ts`) requires a minimum of 3 active sources (line 279). With exactly 3 sources, a single compromised source can shift the median by up to 50%, masking price manipulation. The correlated threshold (≥3 flagged = kill-switch) also means that with only 3 sources, ALL must be flagged to trigger kill-switch — a 2-source attack evades it.

The code comment at line 273-278 acknowledges this: "3-source minimum acceptable for MVP... revisit if source count drops below 5 sustained."

**Objective:** Increase the minimum quorum threshold and add IQR-based outlier pre-filtering to improve manipulation resistance.

**Requirements:**

1. **Increase minimum active sources from 3 to 5:**
   - Change the check at line 279: `if (activeSources.length < 5)`
   - Update skip reason: `Insufficient active sources: ${activeSources.length} (need ≥5)`
   - With 10-11 sources typically active, 5 is a safe floor. If we drop below 5 active, quorum is unreliable anyway and should be skipped.

2. **Per-pair minimum stays at 3** — not all sources support all pairs, so 3 quotes per pair is still reasonable.

3. **Add IQR pre-filter before median calculation:**
   After collecting quotes for a pair but before computing median deviation:
   - Sort amounts, compute Q1 (25th percentile) and Q3 (75th percentile)
   - IQR = Q3 - Q1
   - Flag any quote < Q1 - 1.5×IQR or > Q3 + 1.5×IQR as "statistical outlier"
   - Statistical outliers are removed from median calculation but still checked against the deviation threshold
   - This prevents 1-2 extreme values from pulling the median toward the attacker's price

4. **Update the quorum result to include IQR data:**
   - Add `iqrFiltered: number` to pair results (how many were filtered)
   - Add `iqrRange: { q1: bigint, q3: bigint }` for debugging

5. **Update Telegram `/quorum` command** to show IQR filtered count if > 0.

6. **Constants:**
   ```typescript
   const MIN_ACTIVE_SOURCES = 5
   const MIN_QUOTES_PER_PAIR = 3
   const IQR_MULTIPLIER = 1.5
   ```

**Files affected:**
- `src/lib/quorum-check.ts` (min threshold, IQR filter)
- `src/app/api/telegram/webhook/route.ts` (`handleQuorum()` — show IQR data)

**Do NOT:**
- Do NOT change the deviation thresholds (5% for WETH→USDC, 2% for USDC→USDT). Those are per-pair tolerance, not statistical filtering.
- Do NOT change the correlated kill-switch logic (≥3 flagged = P0 disable). That's correct.
- Do NOT change BigInt arithmetic — all calculations must stay BigInt-safe.

**Quality criteria:**
- Test: quorum skipped when <5 active sources.
- Test: IQR filter removes statistical outliers before median calc.
- Test: 1 extreme value in 5 quotes → filtered out, median unaffected.
- Test: all values similar → 0 filtered.
- Existing quorum tests updated for new minimum.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 42 — Grace period: emit tagged alerts instead of suppressing (API-H-03, HIGH)

**Status:** Pending.

**Context:** The alert wrapper (`src/lib/alert-wrapper.ts`, lines 84-88) suppresses non-P0 alerts entirely during grace period. State transitions still occur and persist in KV — but operators get NO notification. A real incident during a maintenance window would be invisible until grace expires.

**Objective:** During grace, still emit alerts but tag them as grace-period alerts. Operators see what's happening but know it's during planned maintenance.

**Requirements:**

1. **Replace suppression with tagging** — change the grace period check (lines 84-88):
   Instead of `return` (suppress), add a `[GRACE]` prefix to the alert and still send it:
   ```typescript
   let graceTag = ''
   if (await isInGracePeriodAsync() && !critical) {
     graceTag = '⏸️ [GRACE] '
   }
   ```
   Then prefix the alert message with `graceTag` when building the payload.

2. **Reduce alert channels during grace** — to avoid alert fatigue, grace-period alerts go to Telegram ONLY (skip Email and Discord). P0 alerts still go to all channels regardless of grace.

3. **Visual distinction in Telegram:**
   - Grace alerts use a different emoji prefix: `⏸️` instead of `🟠`/`🔴`
   - Add "(during maintenance grace)" to the reason line
   - Do NOT include action buttons on grace alerts (no [Reactivate] etc.) — the operator set the grace, they don't need to act on expected transitions

4. **Keep the existing grace skip for dedup** — grace-period alerts should NOT consume the dedup slot. If a source degrades during grace and then again after grace expires, the post-grace alert should still fire.

5. **Test scenarios:**
   - During grace: non-P0 alert → sent to Telegram only with `[GRACE]` tag, no buttons
   - During grace: P0 alert → sent to ALL channels without tag (bypasses grace entirely)
   - After grace: same source same transition → fires normally (dedup not consumed by grace alert)

**Files affected:**
- `src/lib/alert-wrapper.ts` (replace suppress with tag, conditional channel routing)
- `src/lib/alert-channels/telegram.ts` (accept grace flag to skip inline keyboard)

**Do NOT:**
- Do NOT change P0 alert behaviour — P0 always bypasses grace entirely.
- Do NOT change the grace period mechanism itself (KV + env var). Only change what happens when an alert hits the grace check.
- Do NOT add buttons to grace-period alerts.

**Quality criteria:**
- Test: grace active + non-P0 → Telegram sent with `[GRACE]` prefix, no buttons, Email/Discord skipped.
- Test: grace active + P0 → all channels, no tag, buttons present.
- Test: grace alert does not consume dedup slot.
- All existing alert tests pass.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 43 — Counter-based dedup with shorter TTL (API-H-04, HIGH)

**Status:** Pending.

**Context:** The alert dedup (`src/lib/alert-wrapper.ts`) uses binary sent/not-sent with a 1-hour TTL (line 37). A source oscillating rapidly (active→degraded→active→degraded) fires the first alert, then all subsequent transitions within the hour are silently dropped. Operators miss the pattern of instability.

**Objective:** Replace binary dedup with counter-based: allow up to N alerts per window, with escalating intervals.

**Requirements:**

1. **Counter-based dedup** — replace the binary KV check with a counter:
   - KV key: `teraswap:alert:dedup:{sourceId}:{from}:{to}` (same format)
   - KV value: `{ count: number, firstAt: string, lastAt: string }`
   - TTL: **15 minutes** (reduced from 1 hour)
   - Allow:
     - 1st alert: always send immediately
     - 2nd alert within 15min: send with note "(2nd occurrence in {N}min)"
     - 3rd alert within 15min: send with note "(3rd occurrence — source unstable)"
     - 4th+ within 15min: suppress, but after TTL expires, next occurrence resets counter

2. **Max alerts per window:** 3 (constant `MAX_ALERTS_PER_WINDOW = 3`)

3. **P0 dedup unchanged** — P0 alerts already bypass dedup (line 91). Keep that behaviour.

4. **Oscillation warning** — when the counter hits 3 within a window, add a message to the alert: "⚠️ Source {id} is oscillating — {count} transitions in {minutes}min. Consider maintenance grace (`/grace {minutes}`)."

5. **Update `isDuplicate()` and `markSent()`:**
   - `isDuplicate()` → `shouldSuppress()`: reads counter, returns true only if count ≥ MAX_ALERTS_PER_WINDOW
   - `markSent()` → `incrementCounter()`: increments count, updates lastAt. If key doesn't exist, creates with count=1 and TTL.

6. **Fail-open preserved** — if KV read fails, allow the alert (current behaviour).

**Files affected:**
- `src/lib/alert-wrapper.ts` (dedup logic rewrite)

**Do NOT:**
- Do NOT change P0 behaviour (always bypasses dedup).
- Do NOT change grace period logic (handled in Prompt 42).
- Do NOT change alert channel routing or content formatting.
- Do NOT change the KV key namespace (keep `teraswap:alert:dedup:*`).

**Quality criteria:**
- Test: 1st alert → sent.
- Test: 2nd alert same transition within 15min → sent with "(2nd occurrence)" note.
- Test: 3rd alert → sent with oscillation warning.
- Test: 4th alert within 15min → suppressed.
- Test: after TTL expires → counter resets, next alert sent normally.
- Test: P0 alert → always sent regardless of counter.
- Test: KV failure → alert sent (fail-open).
- All existing dedup tests updated.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 44 — Cold-start warm-up discard (production observation)

**Status:** Pending.

**Context:** Production monitoring on 2026-04-16 showed balancer, openocean, and teraswap-self all degrading simultaneously with ~8000ms p95. The pattern: teraswap-self (own endpoint) degrades at the same time as external sources → indicates a Vercel Hobby cold start inflating ALL measurements in the same tick. The first request after a cold start takes ~8s, which exceeds all p95 thresholds. Auto-recovery follows in ~10 minutes as subsequent ticks are warm.

This creates false degraded alerts that waste operator attention.

**Objective:** Detect cold-start ticks and either discard latency measurements or adjust thresholds for the first measurement.

**Requirements:**

1. **Cold-start detection** — at the start of `runMonitoringTick()`, measure the tick's own startup time:
   ```typescript
   const tickStart = Date.now()
   // ... after all health checks complete:
   const tickDuration = Date.now() - tickStart
   ```
   If `tickDuration > COLD_START_THRESHOLD_MS` (e.g., 10000ms), flag the tick as cold-start.

2. **Discard latency history for cold-start ticks** — when a tick is flagged as cold-start:
   - Still run all health checks (don't skip — we want to know if sources are reachable)
   - But do NOT update `latencyHistory` for any source in that tick
   - DO update `failureCount` / `successCount` based on HTTP status (availability still counts)
   - Log: `[TICK] Cold start detected (${tickDuration}ms) — latency measurements discarded`

3. **Alternative approach (simpler):** Instead of detecting cold starts, always discard the first measurement after a gap. Track `lastTickAt` — if the gap between ticks is >5 minutes (indicating a cold start or long pause), mark the tick as "warmup" and skip latency recording. This is simpler and handles more edge cases.

4. **Choose approach 2 or 3 based on implementation complexity.** The architect prefers approach 3 (gap-based) as it's more reliable.

5. **Heartbeat annotation** — when a tick is flagged as warmup, include in heartbeat response: `"lastTickWarmup": true`.

6. **Constant:** `const WARMUP_GAP_MS = 5 * 60 * 1000 // 5 minutes`

**Files affected:**
- `src/lib/monitoring-loop.ts` (warmup detection, skip latency recording)
- `src/lib/source-state-machine.ts` (conditional latency history update)
- `src/app/api/monitor/heartbeat/route.ts` or admin endpoint (warmup annotation)

**Do NOT:**
- Do NOT skip health checks entirely on warmup — availability (pass/fail) must still be recorded.
- Do NOT change p95 thresholds — the thresholds are correct for warm ticks.
- Do NOT change the Cloudflare Worker schedule — the cold start is a Vercel issue, not a scheduling issue.

**Quality criteria:**
- Test: tick after 10min gap → flagged as warmup, latency not recorded.
- Test: tick after 50s gap → normal, latency recorded.
- Test: warmup tick still records success/failure counts.
- Cold-start false degradation pattern eliminated.
- `npm run build` passes. `npm run lint` clean.

---

## Auditor review — Sprint 6B

**Scope:** Review all changes from Prompts 39-44.

**Checklist:**

1. **API-C-01 (tick auth):**
   - [ ] GET handler removed entirely
   - [ ] POST returns 503 if MONITOR_CRON_SECRET not set
   - [ ] POST returns 401 for wrong/missing token
   - [ ] Constant-time comparison (SHA-256 + timingSafeEqual)
   - [ ] Cloudflare Worker still authenticates correctly

2. **API-H-01 (heartbeat):**
   - [ ] Public endpoint returns ONLY healthy/ageSeconds/tickFresh
   - [ ] Admin endpoint returns full data behind Bearer auth
   - [ ] No source names, states, or reasons in public response
   - [ ] Watchdog still functions with minimal response

3. **API-H-02 (quorum min):**
   - [ ] Minimum raised from 3 to 5 active sources
   - [ ] IQR pre-filter removes statistical outliers before median
   - [ ] BigInt arithmetic preserved throughout
   - [ ] Correlated kill-switch logic unchanged (≥3 flagged)

4. **API-H-03 (grace period):**
   - [ ] Grace alerts tagged with [GRACE], sent to Telegram only
   - [ ] P0 alerts bypass grace entirely (unchanged)
   - [ ] Grace alerts do NOT consume dedup slot
   - [ ] No action buttons on grace alerts

5. **API-H-04 (dedup):**
   - [ ] Counter-based: 3 alerts per 15min window
   - [ ] Oscillation warning on 3rd alert
   - [ ] 4th+ suppressed until TTL expires
   - [ ] P0 bypasses dedup (unchanged)
   - [ ] Fail-open on KV failure

6. **Cold-start (Prompt 44):**
   - [ ] Warmup detection based on tick gap (>5min)
   - [ ] Latency discarded on warmup, availability still recorded
   - [ ] No false degradation on cold starts

7. **Cross-cutting:**
   - [ ] Pre-existing 8 test failures investigated or documented
   - [ ] All new tests pass
   - [ ] `npm run build` clean. `npm run lint` clean.

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- Sprint 6A: `docs/Prompts/SPRINT-6A.md` — COMPLETE (all 4 SC findings closed)
- Comprehensive audit: `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
- Sprint 6C (next): API-M-01 through M-04, FE-M-01, FE-M-02
- Sprint 6D: FE-L-01 (CSP/HSTS), monitoring dashboard, threshold review
- ADR-001: monitoring architecture decisions
- Cold-start observation: production alerts 2026-04-16 12:22-16:45 UTC
