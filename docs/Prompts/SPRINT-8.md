# Sprint 8 — @vercel/kv → @upstash/redis Migration

**Sprint window:** 2026-04-21 → 2026-04-22 (COMPLETE)
**Sprint goal:** Replace the deprecated `@vercel/kv` package with `@upstash/redis`. The `@vercel/kv` package was deprecated in December 2024 and will stop receiving security patches. The underlying infrastructure is already Upstash Redis — this is a client-side migration only.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 7 COMPLETE + APPROVED. Vercel breach rotation COMPLETE.

---

## Migration scope

**14 source files** import `import { kv } from '@vercel/kv'`:

| # | File | KV usage |
|---|------|----------|
| 1 | `src/lib/source-state-machine.ts` | get/set/del, sadd/smembers (index), pipeline |
| 2 | `src/lib/monitoring-loop.ts` | get/set (tick lock, cache) |
| 3 | `src/lib/kv-rate-limiter.ts` | zadd/zcard/zrem/zremrangebyscore, pipeline |
| 4 | `src/lib/alert-wrapper.ts` | get/set (dedup, escalate cooldown) |
| 5 | `src/lib/grace-period.ts` | get/set (grace state) |
| 6 | `src/lib/quorum-check.ts` | get/set (quorum cache) |
| 7 | `src/lib/circuit-breaker.ts` | get/set (trip state, audit) |
| 8 | `src/lib/on-chain-monitor.ts` | get/set (last block, event log) |
| 9 | `src/lib/post-execution-validator.ts` | get/set (validation results, audit) |
| 10 | `src/app/api/monitor/heartbeat/route.ts` | get (public health) |
| 11 | `src/app/api/monitor/heartbeat/admin/route.ts` | get (admin health) |
| 12 | `src/app/api/monitor/status/route.ts` | get (public status) |
| 13 | `src/app/api/admin/kill-switch/route.ts` | get/set (kill-switch state) |
| 14 | `src/app/api/telegram/webhook/route.ts` | get/set (callback dedup) |

**12 test files** mock `@vercel/kv` with `vi.mock('@vercel/kv', ...)`.

**Total: 26 files, ~28 occurrences.**

---

## API compatibility

`@upstash/redis` exposes the same Redis commands as `@vercel/kv` (both are HTTP-based Upstash clients):

| Method | @vercel/kv | @upstash/redis | Compatible? |
|--------|-----------|----------------|-------------|
| `get(key)` | ✅ | ✅ | Identical |
| `set(key, value, opts?)` | ✅ | ✅ | Identical |
| `del(key)` | ✅ | ✅ | Identical |
| `keys(pattern)` | ✅ | ✅ | Identical |
| `incr(key)` | ✅ | ✅ | Identical |
| `expire(key, secs)` | ✅ | ✅ | Identical |
| `pipeline()` | ✅ | ✅ | Identical |
| `zadd(key, {score, member})` | ✅ | ✅ | Identical |
| `zcard(key)` | ✅ | ✅ | Identical |
| `zrem(key, member)` | ✅ | ✅ | Identical |
| `zremrangebyscore(key, min, max)` | ✅ | ✅ | Identical |
| `zrange(key, start, stop, opts?)` | ✅ | ✅ | Identical |
| `sadd(key, member)` | ✅ | ✅ | Identical |
| `smembers(key)` | ✅ | ✅ | Identical |

**Key difference:** `@vercel/kv` auto-configures from `KV_REST_API_URL` + `KV_REST_API_TOKEN`. `@upstash/redis` uses `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or explicit constructor args).

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 59 | Create KV client wrapper | Centralised Redis client module | ✅ DONE (`42f5f5a`) |
| 60 | Migrate all imports | Replace @vercel/kv with wrapper in 14 source files | ✅ DONE (`7923e1f`) |
| 61 | Update tests | Replace vi.mock('@vercel/kv') in 12 test files | ✅ DONE (`d8f456a`) |
| 62 | Package + env var cleanup | Remove @vercel/kv, add @upstash/redis, rename env vars | ✅ DONE (`6a7a6b4`) |

---

## Prompt 59 — Create centralised KV client wrapper

**Status:** Pending

**Context:** Currently, all 14 source files import `{ kv } from '@vercel/kv'` directly. This tight coupling means any future KV client change requires touching every file. This migration is a good opportunity to introduce a single-point-of-entry module.

**Objective:** Create a `src/lib/kv.ts` module that exports a pre-configured Redis client instance, used by all other modules.

**Requirements:**

1. **Create `src/lib/kv.ts`:**
   ```typescript
   import { Redis } from '@upstash/redis'

   /**
    * Centralised KV client.
    * All modules MUST import from here — never import @upstash/redis directly.
    *
    * Env vars (auto-provisioned by Vercel Marketplace Upstash integration):
    *   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
    *   UPSTASH_REDIS_REST_TOKEN — Upstash REST auth token
    *
    * Falls back to KV_REST_API_URL / KV_REST_API_TOKEN for backward compatibility
    * during the migration window (remove fallback after env vars are renamed).
    */
   export const kv = new Redis({
     url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL!,
     token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN!,
   })
   ```

2. **Backward-compatible env vars:** The fallback to `KV_REST_API_URL` / `KV_REST_API_TOKEN` allows the migration to work without immediately renaming env vars in Vercel. The fallback should be removed in Prompt 62.

3. **Export name:** Keep the export name as `kv` so downstream imports only change the path, not the variable name:
   ```typescript
   // Before: import { kv } from '@vercel/kv'
   // After:  import { kv } from '@/lib/kv'
   ```

**Files affected:**
- `src/lib/kv.ts` (new)

**Do NOT:**
- Do NOT export the Redis class or constructor — only the singleton instance.
- Do NOT add any caching, wrapping, or abstraction beyond the raw client.
- Do NOT change any other files in this prompt — only create the new module.

**Quality criteria:**
- `src/lib/kv.ts` exists with a single export `kv`.
- Fallback env var logic is present.
- JSDoc comment explains the env var convention.
- `npm run build` passes (unused export is OK at this stage).

---

## Prompt 60 — Migrate all source file imports

**Status:** Pending

**Context:** With the centralised `src/lib/kv.ts` in place, all 14 source files need to switch from `@vercel/kv` to the local wrapper.

**Objective:** Replace every `import { kv } from '@vercel/kv'` with `import { kv } from '@/lib/kv'` across all source files.

**Requirements:**

1. **Replace imports in all 14 files:**
   ```
   src/lib/source-state-machine.ts
   src/lib/monitoring-loop.ts
   src/lib/kv-rate-limiter.ts
   src/lib/alert-wrapper.ts
   src/lib/grace-period.ts
   src/lib/quorum-check.ts
   src/lib/circuit-breaker.ts
   src/lib/on-chain-monitor.ts
   src/lib/post-execution-validator.ts
   src/app/api/monitor/heartbeat/route.ts
   src/app/api/monitor/heartbeat/admin/route.ts
   src/app/api/monitor/status/route.ts
   src/app/api/admin/kill-switch/route.ts
   src/app/api/telegram/webhook/route.ts
   ```

2. **Each file:** Change only the import line:
   ```typescript
   // Before
   import { kv } from '@vercel/kv'
   // After
   import { kv } from '@/lib/kv'
   ```

3. **No logic changes.** Every file must behave identically — only the import path changes.

4. **Update `kv-rate-limiter.ts` comment** (line 51): change `// @vercel/kv uses HTTP-based Redis` to `// @upstash/redis uses HTTP-based Redis`.

**Files affected:**
- 14 source files (import change only)

**Do NOT:**
- Do NOT change any business logic, method calls, or variable names.
- Do NOT change function signatures or return types.
- Do NOT touch test files (Prompt 61).

**Quality criteria:**
- `grep -r "@vercel/kv" src/` returns ZERO results in non-test files.
- `npm run build` passes.
- `npm run lint` clean.

---

## Prompt 61 — Update test mocks

**Status:** Pending

**Context:** 12 test files mock `@vercel/kv` with `vi.mock('@vercel/kv', ...)`. These need to mock `@/lib/kv` instead.

**Objective:** Update all test mocks to use the new module path.

**Requirements:**

1. **Replace mocks in all 12 test files:**
   ```
   src/lib/monitoring-loop.test.ts
   src/lib/alert-channels/telegram.test.ts
   src/lib/circuit-breaker.test.ts
   src/lib/on-chain-monitor.test.ts
   src/lib/source-thresholds.test.ts
   src/lib/alert-wrapper.test.ts
   src/lib/post-execution-validator.test.ts
   src/lib/quorum-check.test.ts
   src/app/api/telegram/webhook/route.test.ts
   src/app/api/monitor/heartbeat/route.test.ts
   src/app/api/admin/kill-switch/route.test.ts
   src/app/api/monitor/status/route.test.ts
   ```

2. **Each file:** Change the mock target:
   ```typescript
   // Before
   vi.mock('@vercel/kv', () => ({
     kv: { get: vi.fn(), set: vi.fn(), ... }
   }))
   // After
   vi.mock('@/lib/kv', () => ({
     kv: { get: vi.fn(), set: vi.fn(), ... }
   }))
   ```

3. **Keep the mock structure identical.** Only change `'@vercel/kv'` to `'@/lib/kv'`. Do not alter mock implementations or assertions.

**Files affected:**
- 12 test files (mock path change only)

**Do NOT:**
- Do NOT change any test logic, assertions, or mock implementations.
- Do NOT add or remove tests.

**Quality criteria:**
- `grep -r "@vercel/kv" src/` returns ZERO results.
- `npm run test` — all ~323 tests pass.
- No test timeout or flake introduced.

---

## Prompt 62 — Package and env var cleanup

**Status:** Pending

**Context:** With all imports migrated, the old package can be removed and env vars updated.

**Objective:** Remove `@vercel/kv`, install `@upstash/redis`, and clean up env var references.

**Requirements:**

1. **Install new package:**
   ```bash
   npm install @upstash/redis
   ```

2. **Remove old package:**
   ```bash
   npm uninstall @vercel/kv
   ```

3. **Update `src/lib/kv.ts`** — remove the fallback env vars (assumes env vars have been renamed in Vercel by this point):
   ```typescript
   import { Redis } from '@upstash/redis'

   /**
    * Centralised KV client — all modules import from here.
    *
    * Env vars (Vercel Marketplace Upstash integration):
    *   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
    *   UPSTASH_REDIS_REST_TOKEN — Upstash REST auth token
    */
   export const kv = new Redis({
     url: process.env.UPSTASH_REDIS_REST_URL!,
     token: process.env.UPSTASH_REDIS_REST_TOKEN!,
   })
   ```

4. **Update KV troubleshooting runbook** (`docs/Runbooks/KV-troubleshooting.md`) — change references from `@vercel/kv` to `@upstash/redis` and update env var names.

**Files affected:**
- `package.json` (remove @vercel/kv, add @upstash/redis)
- `package-lock.json` (auto-updated)
- `src/lib/kv.ts` (remove fallback)
- `docs/Runbooks/KV-troubleshooting.md` (update references)

**Do NOT:**
- Do NOT run this prompt until env vars are renamed in Vercel (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
- Do NOT change any other source files — imports were already migrated in Prompt 60.
- Do NOT change KV data or keys — the data layer is unchanged.

**Pre-requisite (manual step before this prompt):**
- In Vercel → Environment Variables:
  - Create `UPSTASH_REDIS_REST_URL` with the same value as `KV_REST_API_URL` (mark Sensitive)
  - Create `UPSTASH_REDIS_REST_TOKEN` with the same value as `KV_REST_API_TOKEN` (mark Sensitive)
  - Keep old vars temporarily (for rollback safety)

**Quality criteria:**
- `@vercel/kv` does NOT appear in `package.json`.
- `@upstash/redis` is in `dependencies`.
- `grep -r "@vercel/kv" src/` returns ZERO results.
- `npm run build` passes.
- `npm run test` — all tests pass.
- `npm run lint` clean.
- KV troubleshooting runbook references `@upstash/redis`.

---

## Auditor review — Sprint 8

**Scope:** Review all changes from Prompts 59-62.

**Checklist:**

1. **Centralised client (P59):**
   - [ ] `src/lib/kv.ts` exports singleton `kv` instance
   - [ ] Uses `@upstash/redis` Redis constructor
   - [ ] No business logic in the wrapper

2. **Source migration (P60):**
   - [ ] Zero `@vercel/kv` imports in source files
   - [ ] All 14 files use `import { kv } from '@/lib/kv'`
   - [ ] No logic changes — import path only

3. **Test migration (P61):**
   - [ ] Zero `@vercel/kv` references in test files
   - [ ] All mocks target `@/lib/kv`
   - [ ] All ~323 tests pass

4. **Package cleanup (P62):**
   - [ ] `@vercel/kv` removed from dependencies
   - [ ] `@upstash/redis` added to dependencies
   - [ ] Env var fallback removed from `kv.ts`
   - [ ] KV runbook updated

5. **Regression:**
   - [ ] Rate limiter (sorted sets) works correctly
   - [ ] Source state machine persists across cold starts
   - [ ] Kill-switch operational
   - [ ] Telegram bot responds
   - [ ] Status page shows data

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

### Auditor verdict (2026-04-22)

**✅ APPROVED** — Surgical import-path migration, zero logic changes, zero API changes. `@vercel/kv` (deprecated) fully removed. `@upstash/redis` 1.37.0 is the native SDK for the same Upstash backend. 14 source files + 12 test files migrated. KV runbook updated. Package clean. 399/401 tests pass (2 pre-existing failures unrelated to migration). 1 INFO observation (worktree stale — housekeeping, zero security/functional impact).

---

## See also

- Sprint 7: `docs/Prompts/SPRINT-7.md` — COMPLETE + APPROVED
- KV troubleshooting: `docs/Runbooks/KV-troubleshooting.md`
- ADR-004: `docs/ADR/ADR-004-upstash-kv-over-redis-cloud.md`
- Vercel deprecation warning: `@vercel/kv@3.0.0 is deprecated`
