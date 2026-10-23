# chore/audit-gate-2026-10-23 — FEEDBACK

Clear the CI `audit` gate (6 un-allowlisted high/critical) with dependency pins only.
Base origin/main `dd1dffa` · dedicated worktree · real `npm ci` · no source/config/allowlist edits.

## Checklist
- [x] C1 pins: `next` 16.3.8→16.4.2, `overrides.vite` 8.0.16→8.1.6, `overrides["follow-redirects"]` 1.16.1; lock via `npm install` (exit 0, no min-release-age refusal), then `npm ci` (exit 0)
- [ ] C2 proof: audit-gate PASS · `npm ls` · `npm audit --omit=dev`
- [ ] Next 16.4 gate: release notes · build · tsc · suite · lint
- [ ] diff --stat · push · compare link

## Premise correction (owner-confirmed 2026-10-23)
First patched `next` is **16.4.1** (advisory range `>=16.0.0 <=16.4.0`; v16.4.1 release page lists all 3), not 16.4.2. Owner: **"Keep 16.4.2"**.

## 1. Versions — min-release-age=7, cutoff 2026-10-23T08:16Z − 7d = 2026-10-16T08:16Z
| pkg | before (published) | after (published · age) |
|---|---|---|
| next | 16.3.8 (2026-09-30) | 16.4.2 (2026-10-15T20:57Z · 7.47d) |
| vite (override) | 8.0.16 (2026-06-01) | 8.1.6 (2026-10-06T04:51Z · 17.14d) |
| follow-redirects (new override) | 1.16.0 (2026-04-13) | 1.16.1 (2026-10-01T13:52Z · 21.77d) |

Lock transitive moves (all from the 3 pins, all ≥7.5d old): `@next/env`+`@next/swc-*` 16.4.2; vite → rolldown 1.0.3→1.1.5 (+bindings), `@oxc-project/types` 0.139.0, picomatch 4.0.7, `@emnapi/*` 1.11.1/1.2.2, `@napi-rs/wasm-runtime` 1.2.5, `@tybys/wasm-util` 0.10.4.

Baseline (origin/main, `npm ci`): gate 7 present / 1 allowlisted (braces) / **6 blocking → FAIL** · tsc clean · lint 93 warn / 0 err · vitest 299 files, 4452 passed, 0 skipped · `npm audit --omit=dev` 14 (12 moderate, 1 high, 1 critical).
