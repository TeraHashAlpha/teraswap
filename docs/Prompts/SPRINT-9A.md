# Sprint 9A — Quick-Win Security Fixes

**Sprint window:** 2026-04-23 → 2026-04-23 (COMPLETE)
**Sprint goal:** Close 3 findings from the external technical analysis (H-01, H-02, H-03). These are the highest risk-reduction-per-effort items that don't require smart contract changes.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 8 COMPLETE + APPROVED. External analysis reviewed.
**Reference:** `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf`, response `Audits/TeraSwap-Analysis-Response-2026-04-23.docx`

---

## Sprint status table

| # | Prompt | Finding | Description | Status |
|---|--------|---------|------------|--------|
| 63 | Circuit breaker alert-and-halt | H-03 | Convert systemic CB from alert-only to halt (KV flag + HTTP 503) | ✅ DONE (`926cd7b`) |
| 64 | KV rate limiter in-memory fallback | H-01 | Add conservative in-memory fallback when Upstash is down | ✅ DONE (`aaa1f19`) |
| 65 | Split swap MEV warning | H-02 | Add explicit non-atomicity and MEV risk warning in SplitRouteVisualizer | ✅ DONE (`bbedec0`) |

**NOTE:** Finding L-03 (Telegram callback admin validation) was initially planned for this sprint but on code review was found to be **already mitigated** — `ADMIN_CALLBACK_ACTIONS` set at line 90 of `src/app/api/telegram/webhook/route.ts` already restricts `activate`, `keep`, and `escalate` to admin users. Only `ack` (acknowledge alert) is open to all group members, which is intentional.

---

## Prompt 63 — Circuit breaker: convert alert-only to alert-and-halt

**Status:** Pending

**Context:** The systemic circuit breaker (`src/lib/circuit-breaker.ts`, P46) detects mass source disablement (≥6 majority OR ≥4 cascade in 10min) and emits a P0 alert via Telegram. However, it does NOT stop the system from routing swaps through the remaining (potentially manipulated) sources. Finding H-03 in the external analysis identifies this as a HIGH risk gap.

**Objective:** When the circuit breaker trips, set a KV flag that causes `/api/quote` and `/api/swap` to return HTTP 503 (Service Unavailable) with a maintenance message. The flag requires manual clearance via the Telegram bot `/cleartrip` command.

**Requirements:**

1. **Add KV maintenance flag to `circuit-breaker.ts`:**
   - In `executeTrip()`, after writing audit trail and setting cooldown, also set a new KV key:
     ```typescript
     const HALT_KEY = 'teraswap:circuit-breaker:halt'
     await kv.set(HALT_KEY, {
       timestamp: new Date().toISOString(),
       reason: result.triggerReason,
       disabledSources: result.disabledSources,
     })
     // No TTL — requires manual clearance
     ```
   - Export a function `isSystemHalted()` that reads this key and returns `boolean`.
   - Export a function `clearHalt()` that deletes the key (for admin use).

2. **Guard `/api/quote` and `/api/swap`:**
   - At the top of both route handlers (before any processing), call `isSystemHalted()`.
   - If halted, return:
     ```json
     { "error": "System temporarily paused for safety. Please try again later.", "halted": true }
     ```
     with HTTP 503 and `Retry-After: 300` header.
   - This check must be BEFORE rate limiting (no point rate-limiting during halt).

3. **Add `/cleartrip` admin command to Telegram webhook:**
   - Admin-only command (same `isAdmin()` check as `/disable`, `/lock`).
   - Calls `clearHalt()` from circuit-breaker.ts.
   - Responds with confirmation: "Circuit breaker halt cleared. Swap routing resumed."
   - Add to the help text.

4. **Update existing tests:**
   - In `circuit-breaker.test.ts`, add tests for:
     - `isSystemHalted()` returns true after `executeTrip()`
     - `clearHalt()` removes the flag
     - The halt key has no TTL (persists until cleared)

**Files affected:**
- `src/lib/circuit-breaker.ts` (add HALT_KEY, isSystemHalted, clearHalt)
- `src/app/api/quote/route.ts` (add halt guard at top)
- `src/app/api/swap/route.ts` (add halt guard at top)
- `src/app/api/telegram/webhook/route.ts` (add /cleartrip command)
- `src/lib/circuit-breaker.test.ts` (add halt tests)

**Do NOT:**
- Do NOT add a TTL to the halt key — it must require manual clearance.
- Do NOT change the existing circuit breaker evaluation logic or thresholds.
- Do NOT halt the monitoring endpoints (/api/monitor/tick, /heartbeat, /status) — monitoring must continue running during halt to detect recovery.
- Do NOT halt the kill-switch endpoint.

**Quality criteria:**
- `npm run build` passes.
- `npm run test` — all tests pass (including new halt tests).
- When CB trips: `/api/quote` and `/api/swap` return 503 with `halted: true`.
- When admin sends `/cleartrip`: flag cleared, endpoints resume.
- Monitoring endpoints unaffected by halt.
- Commit message: `feat(circuit-breaker): convert alert-only to alert-and-halt with /cleartrip admin command [H-03]`

---

## Prompt 64 — KV rate limiter in-memory fallback

**Status:** Pending

**Context:** `src/lib/kv-rate-limiter.ts` implements sliding-window rate limiting via Upstash sorted sets. When KV is unavailable, it fails open (`{ allowed: true, remaining: -1, resetAt: 0 }`). Finding H-01 in the external analysis identifies this as a HIGH risk — INC-2026-04-14-002 showed KV can fail silently for 13 days, leaving all endpoints unprotected.

**Objective:** Add a conservative in-memory fallback rate limiter that activates when KV is unavailable. Log the KV fallback activation as a warning event.

**Requirements:**

1. **Add in-memory fallback to `kv-rate-limiter.ts`:**
   - Create a simple in-memory `Map<string, { count: number; windowStart: number }>` at module scope.
   - In the `catch` block of `checkRateLimit()` (where it currently fails open), instead use the in-memory map:
     ```typescript
     // Fallback: in-memory rate limiter with conservative limits (50% of normal)
     const fallbackLimit = Math.ceil(limit / 2)
     const entry = fallbackMap.get(key) || { count: 0, windowStart: Date.now() }
     
     // Reset window if expired
     if (Date.now() - entry.windowStart > windowMs) {
       entry.count = 0
       entry.windowStart = Date.now()
     }
     
     entry.count++
     fallbackMap.set(key, entry)
     
     if (entry.count > fallbackLimit) {
       console.warn(`[RATE-LIMIT] KV unavailable, in-memory fallback BLOCKED request for ${key}`)
       return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs }
     }
     
     console.warn(`[RATE-LIMIT] KV unavailable, using in-memory fallback for ${key}: ${entry.count}/${fallbackLimit}`)
     return { allowed: true, remaining: fallbackLimit - entry.count, resetAt: entry.windowStart + windowMs }
     ```
   - Add periodic cleanup of the map (prune entries older than 2x windowMs) to prevent memory leaks. Run cleanup every 100th check.

2. **Emit P0 alert on first KV failure per window:**
   - Track KV failure state with a module-level boolean `kvFailureAlerted`.
   - On first KV failure, log at `console.error` level (not just warn): `[RATE-LIMIT] KV UNAVAILABLE — switched to in-memory fallback. Rate limits reduced to 50%.`
   - Reset `kvFailureAlerted` when KV succeeds again.

3. **Do NOT change the happy path** — when KV works, behaviour is identical.

**Files affected:**
- `src/lib/kv-rate-limiter.ts` (add fallback logic)

**Do NOT:**
- Do NOT change the sorted-set logic for the KV-based rate limiter.
- Do NOT change the exported rate limit constants (SWAP_RATE_LIMIT, etc.).
- Do NOT add external dependencies.
- Do NOT use the fallback map as persistent state — it resets on cold start (this is acceptable as a degraded mode).

**Quality criteria:**
- `npm run build` passes.
- `npm run test` — all tests pass.
- When KV is unavailable: requests are rate-limited at 50% of normal limits via in-memory map.
- When KV is unavailable: console.error logged on first failure.
- When KV recovers: normal sorted-set rate limiting resumes.
- No memory leak from the fallback map (cleanup runs periodically).
- Commit message: `feat(rate-limiter): add in-memory fallback when KV unavailable [H-01]`

---

## Prompt 65 — Split swap MEV warning

**Status:** Pending

**Context:** `src/components/SplitRouteVisualizer.tsx` shows a split-routing comparison UI when the split engine finds a multi-leg route with better output. However, it does not warn users that split swaps are non-atomic — each leg is a separate on-chain transaction, and partial failure leaves the user with incomplete positions. Each leg is also independently visible to MEV searchers. Finding H-02 in the external analysis identifies this as a HIGH risk.

**Objective:** Add an explicit warning in SplitRouteVisualizer about non-atomicity and per-leg MEV exposure when split routing is active (toggle ON).

**Requirements:**

1. **Add warning below the split toggle in `SplitRouteVisualizer.tsx`:**
   - When `useSplit` is true (user has toggled split routing ON), show a warning banner:
     ```
     ⚠️ Split routes execute as separate transactions. If one leg fails, you may 
     end up with a partial swap. Each leg is independently visible to MEV bots.
     ```
   - Use the existing warning styling pattern from SwapBox (amber border, amber text, `text-xs`):
     ```tsx
     {useSplit && (
       <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
         <span className="font-semibold">⚠️ Non-atomic execution:</span> Split routes execute as separate transactions. 
         If one leg fails, you may end up with a partial swap. Each leg is independently visible to MEV searchers.
       </div>
     )}
     ```

2. **Place it after the split toggle, before the leg breakdown.**

**Files affected:**
- `src/components/SplitRouteVisualizer.tsx` (add warning JSX)

**Do NOT:**
- Do NOT change any split routing logic, thresholds, or the split engine.
- Do NOT disable split routing — it remains opt-in.
- Do NOT change any other components.

**Quality criteria:**
- `npm run build` passes.
- `npm run lint` clean.
- Warning is visible ONLY when split toggle is ON.
- Warning disappears when toggle is OFF.
- Commit message: `feat(split-route): add non-atomicity and MEV risk warning [H-02]`

---

## Auditor review — Sprint 9A

**Scope:** Review all changes from Prompts 63-65.

**Checklist:**

1. **Circuit breaker halt (P63):**
   - [ ] HALT_KEY set on trip, no TTL
   - [ ] `/api/quote` and `/api/swap` return 503 when halted
   - [ ] Monitoring endpoints NOT halted
   - [ ] `/cleartrip` command works, admin-only
   - [ ] Tests cover halt + clear

2. **KV rate limiter fallback (P64):**
   - [ ] In-memory map activates on KV failure
   - [ ] Limits at 50% of normal
   - [ ] Memory cleanup prevents leaks
   - [ ] console.error on first failure
   - [ ] Normal path unchanged when KV works

3. **Split swap warning (P65):**
   - [ ] Warning visible when split toggle ON
   - [ ] Warning hidden when toggle OFF
   - [ ] Mentions non-atomicity and MEV risk

4. **Regression:**
   - [ ] All tests pass
   - [ ] Build clean
   - [ ] Lint clean
   - [ ] Monitoring operational
   - [ ] Swap flow unaffected

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- External analysis: `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf`
- Response: `Audits/TeraSwap-Analysis-Response-2026-04-23.docx`
- Sprint 8: `docs/Prompts/SPRINT-8.md` — COMPLETE + APPROVED
- Circuit breaker (P46): `src/lib/circuit-breaker.ts`
- Rate limiter: `src/lib/kv-rate-limiter.ts`
- Split routing: `src/components/SplitRouteVisualizer.tsx`
