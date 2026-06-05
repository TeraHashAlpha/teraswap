# Sprint 19 — Dependabot Build Guard + Type Fix

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** Vercel deploy waste from Dependabot PRs, type error blocking dependency bumps
**Branch:** `fix/dependabot-build-guard` (single branch, single PR)
**Estimated effort:** ~0.1 pw (2 prompts)

---

## Motivation

Sprint 17 P120 configured Dependabot, which immediately created 8 PRs. Each
PR triggered a Vercel preview deploy — 8 builds consumed from the free tier
(already at 75%). One PR (`@types/node` 20→25) broke the build with a type
error in `scripts/capture-endpoint-baseline.ts:68`. We need:

1. **Vercel ignoreCommand** — skip preview builds for Dependabot branches
2. **Type fix** — make `capture-endpoint-baseline.ts` compatible with both
   `@types/node` v20 and v25 so future bumps don't break

**Deploy strategy:** Single branch, one PR. The ignoreCommand change is in
`vercel.json` which IS deployed, but the change is benign (only affects build
triggers, not runtime behavior).

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 125 | Vercel ignoreCommand for Dependabot | 10 | 2 | 0.95 | 0.05 | 380.0 | P0 |
| 126 | Fix `string \| string[]` type error in capture-endpoint-baseline.ts | 6 | 1 | 0.95 | 0.05 | 114.0 | P1 |

---

## Prompt 125 — Add Vercel ignoreCommand for Dependabot Branches

**Context:** `vercel.json` exists at the project root with framework config, build/install commands, and security headers. Dependabot PRs trigger Vercel preview deploys which consume the free tier build budget. The project is at 75% of Vercel's Fluid Active CPU allocation.

**Objective:** Add an `ignoreCommand` to `vercel.json` that skips builds when the commit author is `dependabot[bot]`.

**Requirements:**

1. In `vercel.json`, add the `ignoreCommand` key at the top level:
   ```json
   "ignoreCommand": "if [[ \"$VERCEL_GIT_COMMIT_AUTHOR_LOGIN\" == \"dependabot[bot]\" ]]; then exit 0; fi; exit 1;"
   ```

2. The `ignoreCommand` must be at the same level as `framework`, `buildCommand`, etc. Do NOT nest it inside any other key.

3. `exit 0` = skip the build, `exit 1` = proceed with the build. This means:
   - Dependabot commits → skip (exit 0)
   - All other commits → build normally (exit 1)

4. Verify the JSON is valid after the change (`node -e "JSON.parse(require('fs').readFileSync('vercel.json'))"`)

**Do NOT:**
- Change any other `vercel.json` settings (headers, buildCommand, framework, etc.)
- Add environment variables
- Modify `.github/dependabot.yml`

**Files affected:**
- `vercel.json` (add `ignoreCommand`)

**Quality criteria:**
- `vercel.json` is valid JSON
- `ignoreCommand` key present at top level
- No other settings changed

---

## Prompt 126 — Fix `string | string[]` Type Error in capture-endpoint-baseline.ts

**Context:** `scripts/capture-endpoint-baseline.ts:68-69` reads TLS certificate fields `cert.issuer?.CN` and `cert.subject?.CN`. In `@types/node` v20, `Certificate.CN` is typed as `string`. In v25, it's `string | string[]` (the interface extends `NodeJS.Dict<string | string[]>`). This breaks the build when Dependabot bumps `@types/node` to v25.

**Objective:** Make the TLS certificate field access compatible with both v20 and v25 `@types/node` typings.

**Requirements:**

1. In `scripts/capture-endpoint-baseline.ts`, find the lines that access `cert.issuer?.CN` and `cert.subject?.CN` (around L68-69). Change them to handle `string | string[]`:

   ```typescript
   // Before:
   issuerCN: cert.issuer?.CN || '',
   subjectCN: cert.subject?.CN || '',

   // After:
   issuerCN: [cert.issuer?.CN].flat()[0] ?? '',
   subjectCN: [cert.subject?.CN].flat()[0] ?? '',
   ```

   The `[value].flat()[0]` pattern normalizes both `string` and `string[]` to take the first element.

2. Check if there are ANY other places in the file that read fields from `cert.issuer` or `cert.subject` and apply the same pattern if needed.

3. Run `npx tsc --noEmit` to verify.

**Do NOT:**
- Pin `@types/node` to v20 (we want to be forward-compatible)
- Change any other scripts
- Modify the `TLSInfo` interface type definitions (keep `issuerCN: string`)

**Files affected:**
- `scripts/capture-endpoint-baseline.ts` (type-safe CN access)

**Quality criteria:**
- `npx tsc --noEmit` clean
- `npm test` passes (628 tests)
- Script runs without error: `npx tsx scripts/capture-endpoint-baseline.ts --help` (if it has a help flag) or at minimum compiles

---

## Execution order

Both prompts on the same branch `fix/dependabot-build-guard`:

1. P125 first (ignoreCommand — prevents future build waste)
2. P126 second (type fix — unblocks future `@types/node` bumps)

One commit per prompt, one PR at the end, one deploy.

## Post-sprint checklist

- [ ] `vercel.json` has `ignoreCommand` at top level
- [ ] Next Dependabot PR does NOT trigger a Vercel preview build
- [ ] `npx tsc --noEmit` clean with current `@types/node`
- [ ] `capture-endpoint-baseline.ts` compiles with both v20 and v25 typings
