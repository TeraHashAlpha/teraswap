# Feedback — chore/security-pins-2026-10-06

Unblock `CI / audit` + `Security Audit / audit` (3 advisories since 2026-10-06). Base: origin/main 36ac1c6.

## Checklist
- [x] C1 evidence (this file)
- [x] C2 Capacitor (A) lockstep bump — core/android/ios/cli 8.4.2/8.3.4/8.4.1/8.5.0 → 8.5.2
- [x] C3 sharp (B) pinned 0.35.5; source-map-js (C) **allowlisted** (min-release-age ETARGET)
- [x] Verify: audit-gate, build, lint, vitest, diff --stat

## 1. Dependency paths (`npm ls <pkg> --all --package-lock-only`, origin/main)
| | pkg | path | kind | resolved |
|---|---|---|---|---|
| A | @capacitor/android | root | **direct**, dependencies | 8.3.4 |
| A | @capacitor/ios | root | **direct**, dependencies | 8.4.1 |
| B | sharp | next@16.3.6 → sharp (`overridden`) | transitive, prod (next optionalDep `^0.35.4`) | 0.35.4 |
| C | source-map-js | postcss@8.5.26 → ; jsdom → css-tree → (deduped) | transitive, prod (next → postcss) | 1.2.1 |

All `@capacitor/*` (all direct deps): core 8.4.2, android 8.3.4, ios 8.4.1, cli 8.5.0, browser 8.0.4,
splash-screen 8.0.1, status-bar 8.0.3.

**Premise mismatch (A):** we are on major **8**, not 7. `npm audit` reports GHSA-rvm3-566m-v7fv's 8.x ranges:
android `>=8.0.0 <=8.3.4`, ios `>=8.3.5 <8.4.3`; fixAvailable 8.5.2 (not semver-major). The 7.6.9 target does
not apply (8→7 would be a major downgrade). Target: **8.5.2** for core/android/ios/cli (2026-09-11, 25d old).
Plugins (browser/splash-screen/status-bar) are versioned independently (8.0.x line, peer `@capacitor/core
>=8.0.0`), have no 8.5.x, and are not flagged — left unchanged.

Registry ages (2026-10-06): sharp 0.35.5 = 2026-09-27 (9d). source-map-js 1.2.2 = 2026-09-30T14:08Z (6d) —
ages in 2026-10-07T14:08Z under min-release-age=7.

No other new high/critical: `npm audit` also lists tailwindcss/eslint-config-next/chokidar/micromatch/fast-glob,
all `via` the already-allowlisted braces GHSA-vfj7-8cjw-p6xm.

## 2. Resulting versions (`npm ls`, branch)
- A: `@capacitor/android@8.5.2`, `@capacitor/ios@8.5.2`, `@capacitor/core@8.5.2`, `@capacitor/cli@8.5.2`
  (android/ios 8.5.2 peer `@capacitor/core ^8.5.0` → core must move too); plugins dedupe to core 8.5.2.
  `npm ls` exit 0, no invalid/ERESOLVE. Lockfile `--all` invalid count 16 = origin/main 16 (pre-existing ws/zod/
  walletconnect override paths), delta 0. After C2: critical 2 → 0. `@capacitor/cli` stays a pre-existing
  *moderate* (xcode→uuid, also on main) — not gate-blocking. `next` reappears as high **via sharp** (effect of B).
- B: `next@16.3.6 └── sharp@0.35.5 overridden` (lockfile: 27 entries changed, all `sharp`/`@img/*`, libvips 1.3.3→1.3.4).
- C: `source-map-js@1.2.1` unchanged. `overrides` pin 1.2.2 → `npm error code ETARGET … No matching version
  found for source-map-js@1.2.2 with a date before 29/09/2026` — not bypassed; allowlisted (see 5).

## 3. audit-gate (`node scripts/audit-gate.mjs`, exit 0)
`audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.` → `audit-gate PASSED — no
un-allowlisted high/critical advisories.` With `AUDIT_GATE_TODAY=2026-10-07`: `⚠ STALE source-map-js` fires.
Remaining high/critical GHSA: braces + source-map-js only. No other advisory appeared (npm audit high 9→8, crit 2→0).

## 4. build / lint / test (origin/main → branch, same worktree)
`npm run build` exit 0 (30/30 pages, no sharp warnings) · lint 94 → 94 warnings, 0 errors (delta 0) ·
`npx vitest run` 284 → 284 files, 4305 → 4305 tests passed.

## 5. diff --stat origin/main…HEAD
package.json (10), package-lock.json (272), audit-allowlist.json (+10, C fell back), this file. C = **allowlisted**
(entry has `ageInOn` too — the field the gate's STALE check reads; braces entry lacks it).

### Follow-up
- On/after 2026-10-07T14:08Z: add `"source-map-js": "1.2.2"` to `overrides`, `npm install`, delete the
  GHSA-68fv-2mgg-jv7q allowlist entry (expires 2026-10-14).
- Allowlist `$comment` still says "STATUS 2026-08-07: empty" — stale since the braces entry; not edited here.

### Deviation (A) — why not "stay on major 7"
Registry bulk-advisory API lists TWO ranges per pkg: android `>=7.0.0 <7.6.9` + `>=8.0.0 <=8.3.4`; ios `>=7.0.0 <7.6.9`
+ `>=8.3.5 <8.4.3`. The brief quoted the 7.x row; the repo was already on 8 (ranges recorded pre-bump in 8401178).
7.6.9 = major 8→7 downgrade, and breaks plugin peers (browser/splash-screen/status-bar need core `>=8.0.0`). 8.5.2
fixes both 8.x ranges with no major change. Architect: confirm 8.5.2, or order the 8→7 downgrade explicitly.
**Owner decision 2026-10-06: keep 8.5.2** (no 8→7 downgrade) — the "stay on major 7" premise did not match the repo.
