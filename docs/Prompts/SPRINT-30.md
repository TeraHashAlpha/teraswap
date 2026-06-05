# Sprint 30 — Operational Backlog Cleanup

> **Objective:** Clear the operational debt accumulated during Sprints 26-29 before starting new features. Security (least-privilege), observability (Vercel Analytics), and DX (lint fix).
>
> **Prerequisite:** Sprint 26 (FeeCollector V2 activation) complete. Main branch green.

---

## P165 — Integrate `@vercel/analytics` into layout.tsx

### Context

`@vercel/analytics` v2.0.1 is already installed in `package.json` and `node_modules`, but the `<Analytics />` component is **not** rendered anywhere. Vercel Web Analytics is enabled on the dashboard (user confirmed 2026-05-26). Without the component in the React tree, no page-view data is collected.

`src/app/layout.tsx` is a Server Component that renders `<html>` → `<body>` → `<ServiceWorkerRegistration />` + `<ClientProviders>{children}</ClientProviders>`.

### Objective

Add the `<Analytics />` component from `@vercel/analytics/next` to the root layout so page views are tracked automatically.

### Requirements

1. Import `{ Analytics }` from `'@vercel/analytics/next'` at the top of `layout.tsx`.
2. Render `<Analytics />` inside `<body>`, **after** `<ClientProviders>`:
   ```tsx
   <body>
     <ServiceWorkerRegistration />
     <ClientProviders>{children}</ClientProviders>
     <Analytics />
   </body>
   ```
3. That's it. The component is a zero-config tracker — no props needed. It works as a Server Component import in Next.js 16.

### Do NOT

- Do NOT add `@vercel/speed-insights` — not installed, not requested.
- Do NOT wrap `<Analytics />` in `<Suspense>` — it handles its own loading.
- Do NOT add any environment variables — Vercel injects the analytics ID automatically.
- Do NOT modify any other file.

### Files affected

- `src/app/layout.tsx` — EDIT (2 lines: import + component)

### Expected output

1 commit. `npm run typecheck` passes.

### Quality criteria

- `<Analytics />` is rendered unconditionally (not behind a feature flag).
- Import is from `@vercel/analytics/next` (not `@vercel/analytics/react`).

---

## P166 — Fix `npm run lint` for paths with spaces

### Context

The repo folder is named `dex-aggregator 2` (with a space). Running `npm run lint` (which calls `next lint`) fails because Next.js mis-parses the space in the path, treating everything after the space as a separate directory argument. Error: `Invalid project directory provided, no such directory: …/lint`.

This was documented in FEEDBACK.md P134. The workaround is to call ESLint directly.

### Objective

Update the `lint` script in `package.json` to use ESLint directly instead of `next lint`, making it work regardless of whether the directory path contains spaces.

### Requirements

1. In `package.json`, change the `"lint"` script from:
   ```json
   "lint": "next lint"
   ```
   to:
   ```json
   "lint": "eslint src --ext .ts,.tsx,.js,.jsx"
   ```
2. If there is no `.eslintrc.json` / `.eslintrc.js` / `eslint.config.*` at the project root, check if `next lint` was relying on Next.js's built-in ESLint config. If so, create/update `.eslintrc.json` to extend `next/core-web-vitals` (which `next lint` uses by default):
   ```json
   {
     "extends": "next/core-web-vitals"
   }
   ```
3. Run `npm run lint` and confirm it completes without the path-parsing error.
4. Fix any **new** lint errors introduced by the script change (not pre-existing warnings — those are tracked separately).

### Do NOT

- Do NOT fix pre-existing lint warnings (e.g. the 20 warnings in SwapBox.tsx documented in FEEDBACK.md). Only fix errors that would fail CI.
- Do NOT switch to a different linter or add new lint plugins.
- Do NOT rename the project folder.

### Files affected

- `package.json` — EDIT (lint script)
- `.eslintrc.json` — EDIT or NEW (if needed to preserve Next.js config)

### Expected output

1 commit. `npm run lint` passes from the `dex-aggregator 2` directory.

### Quality criteria

- `npm run lint` exits 0 (or exits 0 with only pre-existing warnings, no errors).
- CI `lint` job still works on GitHub Actions (path has no space there, but ESLint direct call works in both cases).

---

## P167 — Merge Dependabot PRs #82–#86

### Context

5 open Dependabot PRs:
- #82: zustand
- #83: @capacitor/* 
- #84: @sentry/*
- #85-#86: dev dependencies

These have been open since mid-May. None touch core swap logic.

### Objective

Review and merge all 5 Dependabot PRs, resolving any conflicts with the current main branch.

### Requirements

1. For each PR (#82 through #86), in order:
   a. Check out the branch.
   b. Rebase on latest `main` (resolve conflicts if any).
   c. Run `npm install` to regenerate lockfile.
   d. Run `npm run typecheck` — must pass.
   e. Run `npm test` — must pass (989+ tests, 0 failures).
   f. If tests pass, merge to `main` via merge commit (not squash — preserve Dependabot authorship).
2. After all 5 are merged, run the full test suite once more to confirm no interaction issues.
3. Run `npm audit` and record the remaining advisory count (we expect improvement from these updates).

### Do NOT

- Do NOT upgrade any package beyond what Dependabot proposes.
- Do NOT resolve merge conflicts by deleting lockfile entries — always `npm install` to regenerate.
- Do NOT force-push or rewrite Dependabot commit history.
- Do NOT merge a PR if tests fail — skip it and document why.

### Files affected

- `package.json` — EDIT (version bumps from Dependabot)
- `package-lock.json` — REGENERATED

### Expected output

Up to 5 merge commits. Final `npm test` green. `npm audit` report in commit message or FEEDBACK.md.

### Quality criteria

- All merged PRs show green CI before merge.
- No test regressions (989+ tests passing).
- `npm audit` advisory count recorded.

---

## P168 — Recreate SUPABASE_LOGGER_KEY (ops task — manual)

### Context

The `SUPABASE_LOGGER_KEY` was invalidated when Supabase was paused/restored. The codebase falls back to the service-role key (see `src/lib/supabase.ts` line 76-85), so logging works — but without least-privilege (M-03 finding).

### Objective

Recreate the logger_role key in Supabase and configure it on Vercel.

### Steps (manual — not for Code Agent)

1. **Supabase Dashboard → SQL Editor:**
   ```sql
   -- Verify logger_role exists (from migration 20260514_logger_role.sql)
   SELECT rolname FROM pg_roles WHERE rolname = 'logger_role';
   
   -- If missing, recreate:
   CREATE ROLE logger_role NOLOGIN;
   GRANT INSERT ON swaps, quotes, security_events, usage_events, wallet_activity TO logger_role;
   ```

2. **Supabase Dashboard → Settings → API → Generate new key:**
   - Role: `logger_role` (custom claim)
   - Copy the generated JWT.

3. **Vercel CLI (avoid UI copy-paste corruption):**
   ```bash
   printf 'THE_NEW_KEY' | vercel env add SUPABASE_LOGGER_KEY production
   ```

4. **Trigger redeploy:**
   ```bash
   vercel --prod
   ```

5. **Verify:** Check Vercel Function Logs — the `[supabase] SUPABASE_LOGGER_KEY not set` warning should disappear.

### Quality criteria

- Logger key works (no fallback warning in logs).
- Logger key can only INSERT on the 5 logging tables (test: attempt a SELECT — should fail).
- Service-role key is still used for reads/updates (unaffected).

---

## Sprint 30 — Summary

| Prompt | Scope | Type | Deps |
|--------|-------|------|------|
| P165 | Vercel Analytics integration | Code (1 file edit) | — |
| P166 | Lint path-with-space fix | Code (1-2 files) | — |
| P167 | Dependabot PRs merge | Git ops (5 PRs) | P165, P166 |
| P168 | SUPABASE_LOGGER_KEY | Manual ops | — |

**Code Agent:** P165 → P166 → P167 (sequential — P167 merges on top of P165+P166).
**Manual (TeraHash):** P168 (Supabase + Vercel, independent of code work).

**Total:** 3 code prompts + 1 ops task. 0 new dependencies. Housekeeping sprint.
