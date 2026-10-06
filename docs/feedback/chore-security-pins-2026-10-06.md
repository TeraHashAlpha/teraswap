# Feedback — chore/security-pins-2026-10-06

Unblock `CI / audit` + `Security Audit / audit` (3 advisories since 2026-10-06). Base: origin/main 36ac1c6.

## Checklist
- [x] C1 evidence (this file)
- [x] C2 Capacitor (A) lockstep bump — core/android/ios/cli 8.4.2/8.3.4/8.4.1/8.5.0 → 8.5.2
- [ ] C3 sharp (B) + source-map-js (C)
- [ ] Verify: audit-gate, build, lint, vitest, diff --stat

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
