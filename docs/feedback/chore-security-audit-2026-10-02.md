# Feedback — chore/security-audit-2026-10-02

## Checklist
- [x] C1 triage · [x] C2 fixes · [x] C3 verification

## C1 — Triage (vs origin/main 571d2f3, lockfile only, no install needed)

12 GHSA ids / 4 packages (`npm audit` metadata shows 3 high+1 critical = *packages*, not advisories):

| Pkg | GHSA(s) | Path | Runtime? | Installed→Fixed | Fixed published | Age (min=7d) |
|---|---|---|---|---|---|---|
| axios | c29m,mghh,x97p,3pq3,542g,m8m8,r4gj (×7) | `wagmi→@wagmi/connectors→@base-org/account→@coinbase/cdp-sdk→axios(-retry)` | runtime (wagmi prod dep) | 1.18.1→1.20.0 | 2026-08-26 | 37d ✅ |
| brace-expansion | qhr7,6j4f (×2, both ranges) | 1.x via `@eslint/eslintrc→minimatch@3.1.5`; 5.x via `@capacitor/cli→rimraf→glob→minimatch@10.2.5` + `eslint-config-next→typescript-eslint→…→minimatch@10.2.5` (deduped) | dev-only (eslint/typescript-eslint devDeps; `@capacitor/cli` is a prod-listed but build-time-only CLI) | 1.1.18→1.1.20 / 5.0.9→5.0.11 | 2026-09-14 | 18d ✅ |
| next | vcvr (critical) | direct dep; `@sentry/nextjs`/`@vercel/analytics` dedupe to it | runtime | 16.3.3→16.3.6 | 2026-09-22 | 10d ✅ | 
| undici | rfgv,w293 (×2) | `jsdom→undici` | dev-only (vitest DOM env) | 7.29.0→7.29.1 | 2026-09-04 | 28d ✅ |

`grep -rn "next/og|ImageResponse" .` (excl. node_modules) → **0 hits**: not reachable in our code, patched anyway.

**All 4 fixes aged past `min-release-age=7` → path (a) for every advisory, no `audit-allowlist.json` entry needed.**
Supersedes Dependabot PR #509 (next); other Dependabot PRs untouched.

## C2 — Fixes

Raised existing `overrides` pins (axios, undici, both brace-expansion nested entries) + bumped direct `next`
dep. No overrides added/removed, no ranges widened — see `git diff` on package.json (4 one-line value changes).
`audit-allowlist.json` unchanged (`"allow": []`). `npm install --package-lock-only` (108 lockfile lines,
only the 4 packages + their internal metadata) then `npm ci` (1020 packages, clean, only pre-existing
deprecation warnings unrelated to this change).

## C3 — Verification

1. `npm audit --audit-level=high` → exit 0, 0 high/critical (45 pre-existing, unrelated moderates remain).
2. `node scripts/audit-gate.mjs` → `PASSED`, exit 0.
3. `npm test` → **4217/4217** (284 files), matches origin/main baseline, no regression.
4. `npm run typecheck` → clean, exit 0.
5. `npm run build` (next 16.3.6) → exit 0, no warnings.
6. Keeper suite (`contracts/order-engine/executor`, own `npm ci --ignore-scripts`, `node --test`) → **650/650**.
7. `npm ls axios undici brace-expansion next --all`: axios@1.20.0, undici@7.29.1, next@16.3.6,
   brace-expansion@5.0.11 (×2, overridden+deduped) / @1.1.20 (overridden) — all resolved/overridden as pinned.

### Concern — keeper has its own unmonitored audit surface (not fixed, out of scope)
`contracts/order-engine/executor` has a separate `package.json`/lockfile (`npm ci --ignore-scripts`), not
covered by the root `Security Audit` CI job. Its own `npm audit` shows a pre-existing **1 high** (`ws`
`>=8.0.0 <8.21.0`, memory-exhaustion DoS, via `@aws-sdk/client-kms`) + 1 moderate — the root `overrides.ws`
pin doesn't reach it. Not one of the 12 named advisories and not CI-gated today; flagging for a follow-up.

### Edge case — one moderate left open on the brace-expansion 5.x line
5.0.11 clears both HIGHs but not the moderate GHSA-q2hr-2g5m-vwhr (`<5.0.12`) on that line. Left as-is
(moderate, advisory-only, outside named scope); a one-line bump to 5.0.12 would close it if ever wanted.
