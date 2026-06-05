# Sprint 17 — Hardening & Tech Debt Cleanup

**Date:** 2026-05-16
**Architect:** Claude (Senior Architect)
**Closes:** B7, B1 (completion), B5, 16B-I-04
**Branch:** `feat/sprint-17-hardening` (single branch, single PR)
**Estimated effort:** ~0.5 pw (4 prompts)

---

## Motivation

With Sprint 16B's surplus instrumentation shipped and the 30-day ADR-006 data
collection running, this sprint tackles the highest-RICE open backlog items
that don't require contract changes or new features. Focus: close security
gaps, reduce tech debt, and improve maintainability.

**Deploy strategy:** Single branch `feat/sprint-17-hardening`, all 4 prompts
committed sequentially, one PR, one Vercel build. P123 is docs-only and
doesn't affect the build.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 120 | Dependabot + npm audit automation | 10 | 1.5 | 0.9 | 0.1 | 135.0 | P0 |
| 121 | Source allow-list guard in /api/swap | 8 | 3 | 0.9 | 0.1 | 216.0 | P0 |
| 122 | Refactor updateSwapStatus → options object | 6 | 1 | 0.9 | 0.15 | 36.0 | P1 |
| 123 | Document executor production config | 8 | 2 | 0.95 | 0.15 | 101.3 | P0 |

---

## Prompt 120 — Dependabot + Dependency Scanning Setup

**Context:** The project has no `.github/dependabot.yml`. The CI workflow runs `npm audit --audit-level=high` as a gate but there is no automated PR creation for outdated or vulnerable dependencies. The `package-lock.json` has 1 HIGH (socket.io-parser) and ~13 MEDIUM vulnerabilities. The project uses npm (not pnpm/yarn) with `min-release-age=7d` in `.npmrc` for supply-chain defence.

**Objective:** Configure Dependabot to create automated PRs for npm dependency updates and GitHub Actions version bumps.

**Requirements:**

1. Create `.github/dependabot.yml`:
   ```yaml
   version: 2
   updates:
     - package-ecosystem: "npm"
       directory: "/"
       schedule:
         interval: "weekly"
         day: "monday"
       open-pull-requests-limit: 5
       labels:
         - "dependencies"
       ignore:
         - dependency-name: "*"
           update-types: ["version-update:semver-major"]
       groups:
         dev-dependencies:
           dependency-type: "development"
     - package-ecosystem: "github-actions"
       directory: "/"
       schedule:
         interval: "weekly"
       labels:
         - "ci"
   ```

2. Key design decisions in the YAML:
   - **Major versions ignored** — major bumps require manual review (breaking changes)
   - **Dev dependencies grouped** — one PR for all dev dep minors/patches (reduces PR noise)
   - **5 PR limit** — avoids flooding with PRs (Vercel deploy budget)
   - **Monday schedule** — early-week PRs get reviewed during work hours
   - **GitHub Actions ecosystem** — keeps CI action versions current (security)

3. No other file changes needed. Dependabot is a GitHub-native feature activated by the YAML file.

**Do NOT:**
- Add Renovate or any other dependency manager
- Change `.npmrc` settings
- Run `npm audit fix` in this commit (separate concern)
- Add any npm scripts for dependency checking

**Files affected:**
- `.github/dependabot.yml` (new)

**Quality criteria:**
- File passes YAML lint
- Dependabot PRs appear within 24h of merge to main
- No major version bumps proposed (verify `ignore` rule)

---

## Prompt 121 — Source Allow-List Guard in /api/swap

**Context:** `/api/swap/route.ts` receives a `source` parameter from the frontend and passes it to `fetchSwapFromSource()` after casting to `AggregatorName`. The function selector is validated post-fetch via `isKnownSwapSelector()` (SC-04 mitigation), and the recipient is validated (R1). However, the `source` string itself is never checked against the known aggregator list before the upstream API call is made. An attacker sending an arbitrary `source` value gets a runtime error deep in the adapter layer rather than a clean 400 at the entry point.

**Objective:** Add a source allow-list guard at the top of the POST handler in `/api/swap/route.ts`, rejecting unknown sources before any upstream call.

**Requirements:**

1. In `src/app/api/swap/route.ts`, at the top of the POST handler (after body parsing, before any `fetchSwapFromSource` call), add a guard:
   ```typescript
   import { AGGREGATOR_APIS } from '@/lib/api'  // or wherever the source map is defined
   
   const ALLOWED_SOURCES = new Set(Object.keys(AGGREGATOR_APIS))
   
   if (!ALLOWED_SOURCES.has(source)) {
     return NextResponse.json(
       { error: 'Unknown aggregator source', code: 'INVALID_SOURCE' },
       { status: 400 }
     )
   }
   ```

2. Find where the canonical list of aggregator source names lives (likely `AGGREGATOR_APIS` in `src/lib/api.ts` or a similar constant). Use that as the single source of truth — do NOT hardcode a separate list.

3. The guard must run BEFORE:
   - `fetchSwapFromSource()` call
   - Any rate limiting deduction (don't count invalid requests)
   - Any logging to Supabase

4. Add 2 tests to the swap route test file:
   - Valid source (e.g. `"1inch"`) → proceeds normally (200 or mock)
   - Invalid source (e.g. `"evil-router"`) → 400 with `INVALID_SOURCE` code

**Do NOT:**
- Change `fetchSwapFromSource` internals
- Modify the aggregator list or add/remove sources
- Change any post-fetch validation (selector, recipient, fee integrity)
- Add rate limiting to this check (it's a fast reject, no cost)

**Files affected:**
- `src/app/api/swap/route.ts` (add guard)
- `src/app/api/swap/route.test.ts` or equivalent (2 new tests)

**Quality criteria:**
- `npm test` passes
- `npx tsc --noEmit` clean
- `curl -X POST /api/swap -d '{"source":"evil"}' → 400 INVALID_SOURCE`

---

## Prompt 122 — Refactor updateSwapStatus to Options Object

**Context:** `updateSwapStatus` in `src/lib/analytics.ts` (or similar) has 7 positional parameters: `(txHash, status, gasUsed, gasPrice, wallet, mevSavingsEstimate, mevSavingsActual)`. Call sites like the CoW path in `useSwap.ts` pass 5 `undefined` placeholders to reach the 7th parameter: `updateSwapStatus(hash, 'confirmed', undefined, undefined, address, undefined, surplus)`. This was flagged as 16B-I-04.

**Objective:** Refactor `updateSwapStatus` to accept an options object instead of positional parameters, improving readability and reducing positional errors.

**Requirements:**

1. Define an interface for the options:
   ```typescript
   interface UpdateSwapStatusParams {
     txHash: string
     status: string
     gasUsed?: string
     gasPrice?: string
     wallet?: string
     mevSavingsEstimate?: string
     mevSavingsActual?: string
   }
   ```

2. Change `updateSwapStatus` function signature to accept `(params: UpdateSwapStatusParams)`. Update the function body to destructure from the object.

3. Update ALL call sites that invoke `updateSwapStatus`. Search the entire codebase for calls. Each call should change from positional args to a named object. For example:
   ```typescript
   // Before:
   updateSwapStatus(hash, 'confirmed', undefined, undefined, address, undefined, surplus)
   // After:
   updateSwapStatus({ txHash: hash, status: 'confirmed', wallet: address, mevSavingsActual: surplus })
   ```

4. Update existing tests to use the new signature.

5. The PATCH request body construction inside `updateSwapStatus` must remain unchanged — only the function signature and call sites change.

**Do NOT:**
- Change the PATCH endpoint logic in `/api/log-swap`
- Change what fields are sent in the PATCH body (same behavior)
- Add new fields to the options object beyond the existing 7
- Change the function name

**Files affected:**
- `src/lib/analytics.ts` (or wherever `updateSwapStatus` is defined)
- `src/hooks/useSwap.ts` (CoW path + standard path call sites)
- Any other files that call `updateSwapStatus` (search codebase)
- Related test files

**Quality criteria:**
- `npm test` passes
- `npx tsc --noEmit` clean
- Zero `undefined` placeholder arguments in any `updateSwapStatus` call
- `git grep 'updateSwapStatus(' | grep 'undefined'` returns nothing

---

## Prompt 123 — Document Executor Production Configuration

**Context:** The self-hosted executor (`contracts/order-engine/executor/`) has a `.env.executor` template with `CHAIN_ID=1` and plaintext key references. The hard-fail on missing KMS config (commit `539bd02`) prevents accidental mainnet use with plaintext keys. However, there is NO documentation of how the executor actually runs in production — what config it uses, how it's deployed, how to restart it, what monitoring exists.

**Objective:** Create a production configuration and operations document for the executor.

**Requirements:**

1. Create `docs/Runbooks/EXECUTOR-OPERATIONS.md` with:

   **Section 1 — Architecture Overview:**
   - What the executor does (poll Supabase → check canExecute → executeOrder on-chain)
   - Poll interval (30s), gas cap (100 gwei), stale lock recovery (60s)
   - Dependency chain: Supabase (order source) → Ethereum RPC → Contract → Supabase (status update)

   **Section 2 — Environment Variables:**
   - Document every env var the executor needs (from `.env.executor` template):
     - `CHAIN_ID`, `RPC_URL`, `EXECUTOR_PRIVATE_KEY` (or KMS reference), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CONTRACT_ADDRESS`, `MAX_GAS_PRICE_GWEI`
   - Mark which are secrets vs config
   - Note: plaintext `EXECUTOR_PRIVATE_KEY` triggers hard-fail on mainnet — KMS/Vault required

   **Section 3 — Deployment:**
   - PM2 process management (`pm2 start`, `pm2 restart`, `pm2 logs`)
   - How to verify it's running (`pm2 status`, health endpoint)
   - Log location and rotation

   **Section 4 — Monitoring & Alerting:**
   - Reference existing Telegram alerting via `on-chain-monitor.ts`
   - What triggers alerts: executor down, gas cap hit, execution failure streak
   - Where to check: Supabase `order_executions` table, `orders` status column

   **Section 5 — Incident Response:**
   - Cross-reference `docs/Runbooks/executor-compromise.md` for security incidents
   - Restart procedure
   - How to pause execution (kill PM2 process, or set orders to `paused` in Supabase)
   - How to resume after gas spike subsides

   **Section 6 — Key Rotation:**
   - Procedure for rotating executor wallet key
   - Update contract's `setExecutor()` call (timelocked 48h)
   - Update `.env` / KMS with new key
   - Verify with test execution on next poll cycle

2. Use the existing runbook style (match format of `KV-troubleshooting.md` and `executor-compromise.md`).

**Do NOT:**
- Include actual secrets, addresses, or keys in the document
- Change any executor code
- Create new monitoring or alerting (document what exists)
- Duplicate content already in `executor-compromise.md` — cross-reference it

**Files affected:**
- `docs/Runbooks/EXECUTOR-OPERATIONS.md` (new)

**Quality criteria:**
- Document covers all 6 sections
- No secrets or real addresses in the document
- Cross-references existing runbooks where appropriate
- A new team member could deploy and operate the executor following this doc alone

---

## Execution order

All 4 prompts on the same branch `feat/sprint-17-hardening`:

1. P120 first (Dependabot — independent, no code risk)
2. P121 second (source guard — security improvement)
3. P122 third (updateSwapStatus refactor — depends on understanding call sites from P121 context)
4. P123 last (docs — no code changes, no build impact)

One commit per prompt, one PR at the end, one deploy.

## Post-sprint

- [ ] Verify Dependabot PRs appear on GitHub within 24h
- [ ] Confirm source guard rejects unknown sources in staging
- [ ] Review updateSwapStatus call sites — zero `undefined` placeholders
- [ ] Executor ops doc reviewed by TeraHash for accuracy against real prod config
- [ ] Update AUDIT-TOTAL.md: close B1, B5, B7; note 16B-I-04 resolved

## Post-sprint checklist

- [ ] Dependabot PRs appearing on GitHub
- [ ] `/api/swap` rejects unknown `source` with 400
- [ ] Zero `undefined` placeholders in `updateSwapStatus` calls
- [ ] `EXECUTOR-OPERATIONS.md` covers all 6 sections
- [ ] AUDIT-TOTAL.md updated with closures
