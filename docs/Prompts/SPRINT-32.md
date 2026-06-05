# Sprint 32 — Security Hardening (Post-Audit)

> **Objective:** Close the highest-priority security and CI findings from the FULL-AUDIT-2026-05-26.md report. Focus on items that harden fund-flow paths, improve forensic reliability, and add missing CI gates.
>
> **Prerequisite:** Sprint 31 (Portfolio tab) merged to main.
>
> **Audit references:** SEC-02, SEC-03, SEC-04, SEC-05, INF-02, INF-03, INF-06, INF-09.

---

## P169 — Fix nested multicall depth fail-open (SEC-04)

### Context

`src/lib/calldata-recipient.ts:340-346` — the `decodeMulticallRecipient()` function stops recursive decoding at `depth > 0` and returns `{ valid: true, extracted: null }`. This means a nested `multicall(multicall(swap()))` silently passes recipient validation without the inner `swap()` ever being checked. The router whitelist mitigates this (only known-good aggregators reach this path), but the validator should not fail-open.

### Objective

Make the nested multicall case fail-closed: reject any multicall with `depth > 0` and log a security event instead of silently accepting.

### Requirements

1. In `decodeMulticallRecipient()` at line 340, change the `depth > 0` branch from:
   ```ts
   return { valid: true, extracted: null, implicitRecipient: false, reason: 'Nested multicall — skipping recursive decode' }
   ```
   to:
   ```ts
   return { valid: false, extracted: null, implicitRecipient: false, reason: 'Nested multicall rejected — depth > 0 (fail-closed)' }
   ```
2. Add a `console.warn('[SEC-04] Nested multicall rejected at depth', depth, ...)` log so this surfaces in Vercel Function Logs if it ever triggers.
3. Add a unit test in the existing test file for `calldata-recipient` that constructs a `multicall(multicall(swap))` calldata and asserts `valid: false`.

### Do NOT

- Do NOT increase the depth limit to 2 — the simpler fail-closed approach is safer.
- Do NOT change the `depth === 0` (normal) multicall path — only the nested case.

### Files affected

- `src/lib/calldata-recipient.ts` — EDIT (2 lines: return + log)
- Test file for calldata-recipient — EDIT (add nested multicall test)

### Expected output

1 commit. `npm run typecheck` passes. `npm test` passes.

### Quality criteria

- Nested multicall returns `valid: false`.
- Normal (depth 0) multicall still works exactly as before.
- New test covers the regression.

---

## P170 — Telegram audit key collision fix (SEC-02)

### Context

`src/app/api/telegram/webhook/route.ts:582` — the audit trail key is `${ACTION_AUDIT_PREFIX}${timestamp}` where `timestamp` is `new Date().toISOString()`. Under Vercel multi-instance autoscale, two callbacks in the same millisecond on different processes produce identical ISO strings, causing one audit row to overwrite the other. Audit row loss defeats forensic replay.

### Objective

Append a random suffix to the KV audit key so collisions are practically impossible.

### Requirements

1. In the `logAuditTrail()` function (line ~580), change the key from:
   ```ts
   await kv.set(`${ACTION_AUDIT_PREFIX}${timestamp}`, { ... })
   ```
   to:
   ```ts
   const suffix = crypto.randomUUID().slice(0, 8)
   await kv.set(`${ACTION_AUDIT_PREFIX}${timestamp}:${suffix}`, { ... })
   ```
2. Import `crypto` from Node.js built-in if not already available (in Next.js API routes, `crypto.randomUUID()` is available globally via the Web Crypto API — verify and use `globalThis.crypto.randomUUID()` if needed).
3. No test needed for this change — it's a key-format change in a fire-and-forget audit logger.

### Do NOT

- Do NOT change the audit data shape (only the key).
- Do NOT use a module-level counter (that's per-process and doesn't solve multi-instance collision).
- Do NOT modify any other KV key patterns in the file.

### Files affected

- `src/app/api/telegram/webhook/route.ts` — EDIT (2 lines in `logAuditTrail`)

### Expected output

1 commit. `npm run typecheck` passes.

### Quality criteria

- Audit key format is now `teraswap:telegram:action:<ISO>:<8-char-uuid>`.
- Existing audit entries (with old format) are unaffected — KV is append-only.

---

## P171 — Kill-switch rate limiter size cap (SEC-03)

### Context

`src/app/api/admin/kill-switch/route.ts:36-59` — the in-memory rate limiter uses a `Map` without a size cap. Under sustained probing from random IPs, the map grows unboundedly until the process restarts. The route is auth-gated (only authenticated admin callers), so the blast radius is limited, but a compromised admin credential could DoS the process.

### Objective

Add a hard `MAX_MAP_SIZE` with LRU-style eviction.

### Requirements

1. Add a constant `const MAX_MAP_SIZE = 1000` above the `rateLimitMap` declaration.
2. In `isRateLimited()`, before `rateLimitMap.set(...)`, check if the map has reached `MAX_MAP_SIZE`. If so, delete the oldest entry (earliest `windowStart`) before inserting the new one:
   ```ts
   if (rateLimitMap.size >= MAX_MAP_SIZE) {
     let oldestKey = ''
     let oldestTime = Infinity
     for (const [key, val] of rateLimitMap) {
       if (val.windowStart < oldestTime) {
         oldestTime = val.windowStart
         oldestKey = key
       }
     }
     if (oldestKey) rateLimitMap.delete(oldestKey)
   }
   ```
3. Add a comment documenting the constraint: `// SEC-03: Hard cap prevents unbounded growth under sustained probing.`

### Do NOT

- Do NOT migrate to Upstash KV for this — it's an admin-only endpoint with tiny traffic. In-memory is fine with the cap.
- Do NOT change the rate limit window or max count values.

### Files affected

- `src/app/api/admin/kill-switch/route.ts` — EDIT (~10 lines)

### Expected output

1 commit. `npm run typecheck` passes.

### Quality criteria

- Map never exceeds 1000 entries.
- Existing rate-limit logic unchanged.
- Comment references SEC-03.

---

## P172 — Add CodeQL workflow for JS/TS SAST (INF-02)

### Context

No CodeQL workflow exists. ESLint is the only static analysis gate. CodeQL catches taint flows, logic bugs, and security patterns that ESLint misses. GitHub provides CodeQL free for private repos with a reasonable rate limit.

### Objective

Add a CodeQL analysis GitHub Actions workflow for JavaScript/TypeScript.

### Requirements

1. Create `.github/workflows/codeql.yml`:
   ```yaml
   name: CodeQL
   
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
     schedule:
       - cron: '0 6 * * 1'  # Weekly Monday 6am UTC
   
   permissions:
     security-events: write
     contents: read
   
   jobs:
     analyze:
       name: Analyze
       runs-on: ubuntu-latest
       timeout-minutes: 15
       strategy:
         fail-fast: false
         matrix:
           language: ['javascript-typescript']
       steps:
         - name: Checkout
           uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
         
         - name: Initialize CodeQL
           uses: github/codeql-action/init@b56ba49b26e50535fa1e7f7db0f4f7b4bf65d80d # v3.28.10
           with:
             languages: ${{ matrix.language }}
             queries: security-extended
         
         - name: Autobuild
           uses: github/codeql-action/autobuild@b56ba49b26e50535fa1e7f7db0f4f7b4bf65d80d # v3.28.10
         
         - name: Perform Analysis
           uses: github/codeql-action/analyze@b56ba49b26e50535fa1e7f7db0f4f7b4bf65d80d # v3.28.10
           with:
             category: '/language:${{ matrix.language }}'
   ```
2. Pin all actions to commit SHAs (consistent with existing workflows in `ci.yml`).
3. Only `javascript-typescript` — do NOT add `swift` (Capacitor iOS scaffolding was deleted, no Xcode on runner).

### Do NOT

- Do NOT add `actions` language (GitHub Actions scanning) — not needed.
- Do NOT modify existing workflows.
- Do NOT set `security-events: write` at job level — it's at workflow level.

### Files affected

- `.github/workflows/codeql.yml` — **NEW**

### Expected output

1 commit. File created. The workflow will auto-run on next push to main.

### Quality criteria

- All action refs are commit-SHA-pinned.
- Only `javascript-typescript` in the language matrix.
- Runs on push + PR to main + weekly schedule.
- `security-extended` query suite (broader than default).

---

## P173 — Add gitleaks secret scanning (INF-03)

### Context

No secrets scanning exists in CI. Env-var discipline is strong in code, but a pre-commit + CI gate is cheap insurance against accidental leaks. `gitleaks` is the standard open-source tool for this.

### Objective

Add `gitleaks` as a GitHub Actions workflow and document pre-commit usage.

### Requirements

1. Create `.github/workflows/gitleaks.yml`:
   ```yaml
   name: Gitleaks
   
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   
   permissions:
     contents: read
   
   jobs:
     scan:
       name: Secret Scanning
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - name: Checkout
           uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
           with:
             fetch-depth: 0
         
         - name: Run Gitleaks
           uses: gitleaks/gitleaks-action@44c470ffc35caa8b1eb3e8012ca53c2f9bea4eb5 # v2.3.7
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```
2. Create `.gitleaks.toml` at project root with a minimal config that extends the default ruleset:
   ```toml
   [extend]
   # Uses the default gitleaks config which covers 100+ secret patterns.
   # Add project-specific allowlists below if needed.
   
   [allowlist]
   description = "TeraSwap false positive allowlist"
   paths = [
     '''\.env\.example''',
     '''contracts/order-engine/''',
   ]
   ```
3. Pin the gitleaks action to a commit SHA.

### Do NOT

- Do NOT add a pre-commit hook (requires `gitleaks` binary installed locally — document it in CONTRIBUTING.md later, not now).
- Do NOT scan `contracts/order-engine/` — it has Hardhat test fixtures with fake private keys.

### Files affected

- `.github/workflows/gitleaks.yml` — **NEW**
- `.gitleaks.toml` — **NEW**

### Expected output

1 commit. Both files created. The workflow will auto-run on next push to main.

### Quality criteria

- Action ref is commit-SHA-pinned.
- `.env.example` and `contracts/order-engine/` are allowlisted.
- `fetch-depth: 0` for full history scan.

---

## P174 — Sync .env.example with actual code reads (INF-09)

### Context

`.env.example` declares ~31 variables but drifts from actual `process.env.*` usage in `src/`. Missing: `ODOS_API_KEY`, `ADMIN_API_KEYS_SECRET`, `EXECUTOR_VALIDATION_SECRET`, `MONITOR_SECRET`. Possibly stale: `FLASHBOTS_RPC_URL`, `NEXT_PUBLIC_LAUNCH_DATE` (declared but never read in `src/`).

### Objective

Synchronize `.env.example` with the actual codebase. Add missing variables, mark stale ones, keep documentation format consistent.

### Requirements

1. Add the following variables to `.env.example` in their appropriate category sections:
   - `ODOS_API_KEY=` — under API keys section
   - `ADMIN_API_KEYS_SECRET=` — under Admin/Security section
   - `EXECUTOR_VALIDATION_SECRET=` — under Admin/Security section
   - `MONITOR_SECRET=` — under Monitoring section
2. For any variables declared in `.env.example` that are NOT read anywhere in `src/`, add a `# UNUSED — candidate for removal` comment. Verify by grepping before marking.
3. Keep the existing category headers and documentation format.
4. Do NOT change any values — this is a documentation-only change.

### Do NOT

- Do NOT remove variables — only mark unused ones with a comment.
- Do NOT change any actual env var reads in source code.
- Do NOT modify `.env.local` or any runtime env files.

### Files affected

- `.env.example` — EDIT

### Expected output

1 commit. Documentation-only change. No code changes.

### Quality criteria

- Every `process.env.X` in `src/` has a matching entry in `.env.example`.
- Unused entries are clearly marked.
- Format consistent with existing sections.

---

## Sprint 32 — Summary

| Prompt | Scope | Finding | Type | Risk |
|--------|-------|---------|------|------|
| P169 | Nested multicall fail-closed | SEC-04 | Security fix + test | Medium — fund-flow validator |
| P170 | Telegram audit key collision | SEC-02 | Security fix | Medium — forensic reliability |
| P171 | Kill-switch rate limiter cap | SEC-03 | Security fix | Medium — DoS resistance |
| P172 | CodeQL workflow | INF-02 | CI gate | High — SAST coverage gap |
| P173 | Gitleaks secret scanning | INF-03 | CI gate | High — leak prevention |
| P174 | .env.example sync | INF-09 | Documentation | Low — DX |

**Code Agent:** P169 → P170 → P171 → P172 → P173 → P174 (sequential, each independent).

**Total:** 6 prompts, ~5 files edited + 3 new files. 0 new dependencies. Security hardening sprint.

**Note:** This sprint addresses 6 of the 8 "Critical/High" recommendations from FULL-AUDIT-2026-05-26.md. The remaining 2 (wagmi 2→3 scope + security-critical test coverage) are Sprint 33/34 scope — they require multi-sprint planning.
