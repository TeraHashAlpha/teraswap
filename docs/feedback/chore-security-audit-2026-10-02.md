# Feedback — chore/security-audit-2026-10-02

## Task checklist

- [x] Commit 1 — triage table (no changes)
- [ ] Commit 2 — fixes (overrides/dependency bumps + lockfile)
- [ ] Commit 3 — verification (audit, audit-gate, suite, tsc, build, keeper suite, `npm ls`)

## Commit 1 — triage table

`npm audit --json` against `origin/main` (571d2f3) lockfile, no `node_modules` install needed (npm reads
the committed lockfile). 12 distinct high/critical GHSA ids across 4 packages (axios ×7, brace-expansion ×2,
next ×1 critical, undici ×2) — matches the goal's advisory list exactly. `npm audit` metadata reports 3
high + 1 critical because it counts vulnerable *packages*, not distinct advisories.

| Advisory | Package | Dependency path | Runtime/dev | Installed | First patched | Published | Age vs min-release-age=7 | Reachable in our code |
|---|---|---|---|---|---|---|---|---|
| GHSA-c29m-xwm3-cm6r | axios | `wagmi@2.19.5 → @wagmi/connectors@6.2.0 → @base-org/account@2.4.0 → @coinbase/cdp-sdk@1.48.2 → {axios-retry@4.5.0, direct}` (overridden) | runtime (`wagmi` is a prod dep) | 1.18.1 | 1.20.0 | 2026-08-26 | 37d — aged ✅ | n/a (transitive, always reachable via wagmi init) |
| GHSA-mghh-pgcx-3jjj | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-x97p-jq2g-jp4f | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-3pq3-5fj3-cg6v | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-542g-h47m-68v8 | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-m8m8-qj5v-23w3 | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-r4gj-5m52-g5wh | axios | same path | runtime | 1.18.1 | 1.20.0 | 2026-08-26 | 37d ✅ | same |
| GHSA-qhr7-859c-m2p7 | brace-expansion | 1.x: `@eslint/eslintrc@3.3.6 → minimatch@3.1.5 → brace-expansion` (overridden). 5.x: `@capacitor/cli@8.5.0 → rimraf@6.1.3 → glob@13.0.6 → minimatch@10.2.5 → brace-expansion` + `eslint-config-next@16.3.1 → typescript-eslint@8.59.1 → … → minimatch@10.2.5 → brace-expansion` (deduped, overridden) | dev-only (`@eslint/eslintrc`, `eslint-config-next` are devDeps); `@capacitor/cli` is listed in `dependencies` but is a build-time CLI (mobile packaging), not loaded at serverless/browser runtime | 1.1.18 (1.x) / 5.0.9 (5.x) | 1.1.20 (1.x) / 5.0.11 (5.x) | 2026-09-14 (both) | 18d ✅ | n/a (build/lint tooling, not shipped code) |
| GHSA-6j4f-fj2g-mc7p | brace-expansion | same two paths | same | 1.1.18 (1.x) / 5.0.9 (5.x) | 1.1.19 (1.x) / 5.0.10 (5.x) — superseded by the 1.1.20/5.0.11 pin above, which also covers this one | 2026-09-14 | 18d ✅ | same |
| GHSA-vcvr-r3jv-pc5j | next | direct dependency (`next@16.3.3`); `@sentry/nextjs@10.68.0`, `@vercel/analytics@2.0.1` dedupe to it | runtime (the framework) | 16.3.3 | 16.3.6 | 2026-09-22 | 10d ✅ | `grep -rn "next/og\|ImageResponse" .` (excl. node_modules) → **0 hits**. Not exploitable for us today, patched anyway per instructions. |
| GHSA-rfgv-xxqx-mfg5 | undici | `jsdom@29.1.1 → undici` (overridden) | dev-only (`jsdom` is a devDep, vitest DOM environment) | 7.29.0 | 7.29.1 | 2026-09-04 | 28d ✅ | n/a (test environment only) |
| GHSA-w293-vg96-wgc3 | undici | same path | dev-only | 7.29.0 | 7.29.1 | 2026-09-04 | 28d ✅ | same |

**Result: all 4 packages have a patched version already aged ≥7 days past `min-release-age=7`.** Every
advisory resolves via path (a) — raise the existing `overrides` pin (axios, undici, both brace-expansion
nested entries) or bump the direct dependency (next) — per the Commit 2 plan. No `audit-allowlist.json`
entries needed this pass (no <7-day-old fixes, no unfixed advisories).

Also noted: `npm audit` baseline carries 25 moderate advisories (unchanged scope, advisory-only per CI gate
— not touched here), including `GHSA-q2hr-2g5m-vwhr` (brace-expansion, moderate, `<5.0.12`) which the 5.0.11
pin above does not clear — left alone since moderates don't block the gate and widening past the minimum
needed high/critical fix wasn't asked for.

Supersedes Dependabot PR #509 (next) for the GHSA-vcvr-r3jv-pc5j fix; other open Dependabot PRs untouched.
