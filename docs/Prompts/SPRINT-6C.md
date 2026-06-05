# Sprint 6C — Medium Priority Fixes

**Sprint window:** 2026-04-16 → TBD
**Sprint goal:** Close remaining MEDIUM findings from the comprehensive audit. 3 of 6 are already resolved — scope reduced to 3 code prompts + 1 refactor.
**Owner:** TeraHash (founder/architect) + code agent
**Audit report:** `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
**Prerequisite:** Sprint 6B COMPLETE + APPROVED.

---

## Audit finding validation

| # | Finding | Audit severity | Code status | Action |
|---|---------|---------------|-------------|--------|
| API-M-01 | alertKVFailure() bypasses fan-out | MEDIUM | **ALREADY FIXED** — `alertKVFailure()` calls `emitTransitionAlert()` (line 217). No direct Telegram sends. | No action |
| API-M-02 | Calldata unknown selectors fail-open | MEDIUM | **CONFIRMED OPEN** — line 417-423: unknown selectors return `valid: true`. | Prompt 46 |
| API-M-03 | Tick concurrency, no distributed lock | MEDIUM | **CONFIRMED OPEN** — no mutex or KV lock in `runMonitoringTick()`. | Prompt 47 |
| API-M-04 | Escalate callback no rate-limit | MEDIUM | **CONFIRMED OPEN** — lines 631-660: unlimited escalation, all channels, no throttle. | Prompt 48 |
| FE-M-01 | npm ci runs lifecycle scripts | MEDIUM | **MITIGATED BY DESIGN** — intentional for `prisma generate`. Mitigations: lockfile-lint + npm audit gate + Dependabot. | No action |
| FE-M-02 | follow-redirects CVE | MEDIUM | **MITIGATED** — v1.15.11 pinned, `npm audit --audit-level=high` in CI blocks build on known vulns. | No action |
| N-04 | Auth helper duplication (6B auditor note) | INFO | Refactor opportunity. | Prompt 49 |

**Net sprint scope:** 4 prompts.

---

## Sprint status table

| # | Prompt | Finding(s) | Severity | Status |
|---|--------|-----------|----------|--------|
| 46 | Calldata validation fail-closed for unknown selectors | API-M-02 | MEDIUM | ✅ `3ca61a5` — 20 tests |
| 47 | Distributed lock for tick concurrency | API-M-03 | MEDIUM | ✅ `8f2a6ae` — 26 tests |
| 48 | Rate-limit escalate callbacks | API-M-04 | MEDIUM | ✅ `3aef46e` — 84 tests |
| 49 | Extract shared auth helper (N-04 refactor) | INFO | LOW | ✅ `a4bba0a` — 11 tests + 3 routes refactored |

---

## Prompt 46 — Calldata validation: fail-closed for unknown selectors (API-M-02)

**Status:** ✅ COMPLETE — `3ca61a5`. 20 tests. Odos/KyberSwap/ParaSwap promoted to `TRUSTED_ROUTER_SELECTORS` with `implicitRecipient: true`. `VALIDATED_SELECTORS` exported as `ReadonlySet<string>` (19 selectors). Unknown selectors logged via `console.warn`.

**Context:** The calldata recipient validation (`src/lib/calldata-recipient.ts`) returns `valid: true` for unknown function selectors (line 417-423) and unsupported proprietary selectors (lines 359-367). This is a fail-open design — any novel attack using an uncommon selector would bypass recipient validation entirely.

**Objective:** Change to fail-closed: unknown selectors default to `valid: false`. Maintain an explicit allowlist of validated selectors.

**Requirements:**

1. **Change unknown selector handling** (lines 417-423) to fail-closed:
   ```typescript
   // Unknown selector — fail closed
   return {
     valid: false,
     extracted: null,
     implicitRecipient: false,
     reason: `Unknown selector ${selector} — validation required`,
   }
   ```

2. **Change unsupported selector handling** (lines 359-367) to fail-closed:
   ```typescript
   if (UNSUPPORTED_SELECTORS.has(selector)) {
     return {
       valid: false,
       extracted: null,
       implicitRecipient: false,
       reason: 'Recipient extraction not supported for this selector — blocked by default',
     }
   }
   ```

3. **Ensure existing validated selectors still work** — the explicit selector handlers (Uniswap, 0x, etc.) should continue to return `valid: true` with proper recipient extraction. Only the fallback path changes.

4. **Impact assessment:** Review which sources use unsupported selectors (Odos, KyberSwap, ParaSwap are mentioned in code). If blocking their selectors breaks swap execution for those sources, add them to the validated set with `implicitRecipient: true` (meaning the router contract itself is trusted to send to `msg.sender`). Document which selectors are trusted-by-design vs validated-by-extraction.

5. **Add constant for the validated selector list** — explicit allowlist that can be audited:
   ```typescript
   /** Selectors with validated recipient extraction */
   const VALIDATED_SELECTORS: ReadonlySet<string> = new Set([
     '0x...', // Uniswap exactInputSingle
     '0x...', // 0x transformERC20
     // ... all currently handled selectors
   ])
   ```

6. **Logging:** When a swap is blocked due to unknown selector, log the selector + source for future analysis. This helps build the allowlist over time.

**Files affected:**
- `src/lib/calldata-recipient.ts` (change default from fail-open to fail-closed)

**Do NOT:**
- Do NOT remove the existing selector handlers — they are correct.
- Do NOT block selectors that are currently in production use without adding them to the allowlist first.
- Do NOT change the return type or interface — only the `valid` boolean and `reason` string for the fallback paths.

**Quality criteria:**
- Test: known selector (e.g., Uniswap) → `valid: true`, recipient extracted.
- Test: unknown selector → `valid: false`, reason explains why.
- Test: unsupported selector → `valid: false`.
- All existing calldata tests pass (validated selectors unaffected).
- Verify which sources use unsupported selectors — ensure they have a path to validity.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 47 — Distributed lock for tick concurrency (API-M-03)

**Status:** ✅ COMPLETE — `8f2a6ae`. 26 tests (5 new). KV SET NX with 55s TTL. Skipped ticks return `{ ok: true, skipped: true }`. No heartbeat update on skip. Fail-open on KV error.

**Context:** `runMonitoringTick()` in `src/lib/monitoring-loop.ts` has no distributed lock. If Vercel triggers overlapping tick invocations (cron retries, clock skew, or manual trigger), two ticks execute in parallel on separate Lambda instances, causing: race conditions on state transitions, duplicate alerts, inconsistent KV updates, and double health checks to same sources.

**Objective:** Add a KV-based distributed lock (SET NX with TTL) at tick start to ensure only one tick executes at a time.

**Requirements:**

1. **KV lock at tick entry** — at the start of `runMonitoringTick()`, before `beginTick()`:
   ```typescript
   const LOCK_KEY = 'teraswap:monitor:tick-lock'
   const LOCK_TTL_SECONDS = 55 // Must be < 60s tick interval
   
   // Attempt to acquire lock (SET NX = only if not exists)
   const acquired = await kv.set(LOCK_KEY, Date.now().toString(), { nx: true, ex: LOCK_TTL_SECONDS })
   
   if (!acquired) {
     console.log('[TICK] Skipped — another tick is in progress')
     return { skipped: true, reason: 'concurrent-tick-lock' }
   }
   ```

2. **Auto-release via TTL** — the 55s TTL ensures the lock expires before the next tick (60s). No explicit unlock needed, which prevents deadlocks if the function crashes.

3. **No explicit unlock** — deliberately do NOT release the lock at the end of the tick. The TTL handles cleanup. An explicit delete creates a window where a crash between lock-acquire and lock-release leaves no protection.

4. **Update `MonitoringTickResult` type** to include `skipped?: boolean` and `reason?: string` for locked ticks.

5. **Update tick API route** — if the tick was skipped, return a 200 with `{ ok: true, skipped: true }` (not an error — skipping is correct behaviour).

6. **Heartbeat consideration** — skipped ticks should NOT update `lastTick` timestamp. Only completed ticks update it. This ensures the watchdog detects if ALL ticks are being locked out (stale heartbeat).

**Files affected:**
- `src/lib/monitoring-loop.ts` (add lock acquire at entry)
- `src/app/api/monitor/tick/route.ts` (handle skipped result)

**Do NOT:**
- Do NOT add an explicit unlock at the end — TTL is the release mechanism.
- Do NOT use a Redis WATCH/MULTI pattern — SET NX is simpler and sufficient.
- Do NOT change the tick interval or Cloudflare Worker schedule.
- Do NOT block the tick if KV is unreachable (fail-open: if SET NX fails due to KV error, proceed with the tick — better to risk a duplicate than miss a tick entirely).

**Quality criteria:**
- Test: first tick acquires lock → executes normally.
- Test: concurrent tick while lock held → skipped with reason.
- Test: lock expires after TTL → next tick proceeds.
- Test: KV failure on lock acquire → tick proceeds (fail-open).
- Test: skipped tick does NOT update lastTick.
- All existing monitoring tests pass.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 48 — Rate-limit escalate callbacks (API-M-04)

**Status:** ✅ COMPLETE — `3aef46e`. 84 tests (5 new). 5min cooldown per source. KV fail-open. Cooldown message with remaining seconds.

**Context:** The escalate button handler in the Telegram webhook (`src/app/api/telegram/webhook/route.ts`, lines 631-660) bypasses grace period and dedup, sending alerts to ALL channels (Telegram, Email, Discord) with no throttle. An admin with a compromised device could trigger unlimited alert fan-out by spamming the escalate button. Even without compromise, accidental double-taps send duplicate escalations.

**Objective:** Rate-limit escalation to max 1 per source per 5 minutes.

**Requirements:**

1. **KV-based rate limit** — before executing escalation, check:
   ```typescript
   const ESCALATE_COOLDOWN_SECONDS = 300 // 5 minutes
   const escalateKey = `teraswap:telegram:escalate:${sourceId}`
   
   const lastEscalation = await kv.get<string>(escalateKey)
   if (lastEscalation) {
     const elapsed = Math.round((Date.now() - new Date(lastEscalation).getTime()) / 1000)
     const remaining = ESCALATE_COOLDOWN_SECONDS - elapsed
     await answerCallbackQuery(query.id, `⏳ Escalation cooldown — retry in ${remaining}s`, true)
     return
   }
   ```

2. **Set cooldown after escalation:**
   ```typescript
   await kv.set(escalateKey, new Date().toISOString(), { ex: ESCALATE_COOLDOWN_SECONDS })
   ```

3. **Cooldown is per-source** — different sources can be escalated simultaneously. Only repeated escalation of the SAME source is throttled.

4. **KV failure → allow escalation** (fail-open) — escalation is an emergency action, better to allow a duplicate than block a legitimate one.

5. **Audit trail** — the existing `logButtonAction()` already logs all escalations. No change needed.

**Files affected:**
- `src/app/api/telegram/webhook/route.ts` (add rate-limit check in escalate case)

**Do NOT:**
- Do NOT rate-limit other button actions (activate, keep, ack). Only escalate needs throttling.
- Do NOT change the escalation fan-out logic (bypass grace + dedup is correct for emergencies).
- Do NOT add rate limiting to the text commands (`/disable`, `/lock`) — those already have P0/non-P0 semantics.

**Quality criteria:**
- Test: first escalation → succeeds, all channels notified.
- Test: second escalation within 5min for same source → rejected with cooldown message.
- Test: escalation of DIFFERENT source within 5min → succeeds (per-source limit).
- Test: after 5min cooldown → escalation succeeds again.
- Test: KV failure → escalation proceeds (fail-open).
- All existing callback tests pass.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 49 — Extract shared auth helper (N-04 refactor)

**Status:** ✅ COMPLETE — `a4bba0a`. 11 tests. `verifyBearerToken()` in `src/lib/auth.ts`. Refactored tick, heartbeat/admin, kill-switch. Kill-switch had length leak (early return) — now uses SHA-256 + timingSafeEqual. Telegram webhook auth unchanged.

**Context:** Sprint 6B auditor noted (N-04) that the SHA-256 + timingSafeEqual Bearer token verification pattern is duplicated across 3 files: kill-switch route, tick route, and heartbeat admin route. Each has its own copy of the hash-then-compare logic.

**Objective:** Extract a shared `verifyBearerToken()` utility and use it across all authenticated endpoints.

**Requirements:**

1. **Create `src/lib/auth.ts`** with:
   ```typescript
   import { timingSafeEqual, createHash } from 'node:crypto'
   
   /**
    * Constant-time Bearer token verification.
    * SHA-256 pre-hash eliminates length leak from timingSafeEqual.
    */
   export function verifyBearerToken(authHeader: string | null, expectedSecret: string): boolean {
     if (!authHeader || !expectedSecret) return false
     const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
     if (!token) return false
     const hashA = createHash('sha256').update(token).digest()
     const hashB = createHash('sha256').update(expectedSecret).digest()
     return timingSafeEqual(hashA, hashB)
   }
   ```

2. **Replace duplicated auth logic in:**
   - `src/app/api/admin/kill-switch/route.ts`
   - `src/app/api/monitor/tick/route.ts`
   - `src/app/api/monitor/heartbeat/admin/route.ts`
   - `src/app/api/telegram/webhook/route.ts` (already has `verifyWebhookSecret` — keep that separate as it compares raw strings, not Bearer headers)

3. **Keep the Telegram webhook auth separate** — it uses a different header (`X-Telegram-Bot-Api-Secret-Token`) and compares raw values, not Bearer-prefixed. Don't force it into the same helper.

4. **Tests:** Existing auth tests should still pass. Add unit tests for `verifyBearerToken()` in isolation.

**Files affected:**
- `src/lib/auth.ts` (new)
- `src/app/api/admin/kill-switch/route.ts` (replace inline auth)
- `src/app/api/monitor/tick/route.ts` (replace inline auth)
- `src/app/api/monitor/heartbeat/admin/route.ts` (replace inline auth)

**Do NOT:**
- Do NOT change the Telegram webhook auth (different pattern).
- Do NOT change any auth behaviour — only extract and reuse.

**Quality criteria:**
- All 3 endpoints use the shared helper.
- All existing auth tests pass.
- New unit tests for `verifyBearerToken()`.
- `npm run build` passes. `npm run lint` clean.

---

## Auditor review — Sprint 6C

**Scope:** Review all changes from Prompts 46-49.

**Checklist:**

1. **API-M-02 (calldata fail-closed):**
   - [ ] Unknown selectors return `valid: false`
   - [ ] Unsupported selectors return `valid: false`
   - [ ] Currently-used selectors still return `valid: true` with proper extraction
   - [ ] No production swap paths broken (sources with unsupported selectors handled)
   - [ ] Logging for blocked selectors

2. **API-M-03 (tick lock):**
   - [ ] KV SET NX with 55s TTL at tick start
   - [ ] No explicit unlock (TTL-only release)
   - [ ] Skipped ticks return `{ ok: true, skipped: true }`
   - [ ] Skipped ticks do NOT update lastTick
   - [ ] KV failure → tick proceeds (fail-open)

3. **API-M-04 (escalate rate-limit):**
   - [ ] 5min cooldown per source
   - [ ] Different sources can escalate simultaneously
   - [ ] KV failure → escalation proceeds (fail-open)
   - [ ] Cooldown message shows remaining time

4. **N-04 (auth helper):**
   - [ ] `verifyBearerToken()` in `src/lib/auth.ts`
   - [ ] Used by kill-switch, tick, heartbeat admin
   - [ ] Telegram webhook auth unchanged
   - [ ] No auth behaviour changes

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- Sprint 6B: `docs/Prompts/SPRINT-6B.md` — COMPLETE + APPROVED
- Sprint 6A: `docs/Prompts/SPRINT-6A.md` — COMPLETE + APPROVED
- Comprehensive audit: `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
- Sprint 6D (next): FE-L-01 (CSP/HSTS headers), monitoring dashboard
- Sprint 7: Forensic & post-execution security (P45-P49)
