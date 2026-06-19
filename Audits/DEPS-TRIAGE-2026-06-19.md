# Dependency Triage — 2026-06-19

Triage of the 7 open Dependabot PRs. Method: per-PR review (a 7-agent workflow) cross-checked with the local
lockfile + `npm audit` + single-instance checks. Each disposition is one of **BATCH_SAFE** (combine into
`chore/deps-safe-batch-4`), **ISOLATE** (own branch, needs manual/native verify), **HOLD** (defer — ADR-blocked),
or **CLOSE** (wrong / no-op / superseded).

**Invariants preserved across all dispositions:** the #208 override pins (`undici 7.28.0` / `form-data 4.0.6` /
`vite 8.0.16`) stay intact → `npm audit` stays clean (audit-gate 0/0/0); no new duplicate `@walletconnect/core`
(1× 2.21.1) / `qr` (1× 0.5.5) / `@coinbase/cdp-sdk` (1× 1.48.2); no AGPL/copyleft; `catalog-address-guard` green.

## Summary

| PR | dependency | bump | kind | CI | disposition |
|---|---|---|---|---|---|
| #198 | js-yaml | 4.1.1 → 4.2.0 | transitive (dev, ESLint) | ✅ 12/12 | **BATCH_SAFE** ← in this batch |
| #196 | tar | 7.5.13 → 7.5.16 | transitive (`@capacitor/cli`) | ✅ 12/12 | **BATCH_SAFE** ← in this batch (sec fix) |
| #187 | dev-deps group (`@types/node` 20.19.41→.43, `eslint-config-next` 16.2.6→.9) | patch | direct-dev | ✅ 13/13 | **BATCH_SAFE** (recommend next; see note) |
| #191 | @capacitor/core | 8.2.0 → 8.4.0 | direct-dev (native) | ✅ green | **ISOLATE** (iOS/Android smoke-test) |
| #190 | @capacitor/cli | 8.2.0 → 8.4.0 | direct-dev (native) | ❌ flaky | **ISOLATE** (red = infra flake; iOS verify) |
| #189 | viem | 2.47.4 → 2.52.2 | direct-prod | ✅ green | **HOLD** (ADR-008) |
| #188 | @next/swc-darwin-arm64 | 16.2.6 → 16.2.9 | platform-binary | ✅ green | **CLOSE** (mismatches Next core) |

## Dispositions

### #198 js-yaml 4.1.1 → 4.2.0 — BATCH_SAFE ✅ (applied)
Transitive **dev-only** dep (pulled by the ESLint toolchain `@eslint/eslintrc` at `^4.1.1`, which already permits
4.2.0 — lockfile-only, no `package.json` change). License **MIT** (unchanged). Changelog: no breaking changes;
4.2.0 adds defensive hardening (`maxDepth(100)`/`maxMergeSeqLength(20)` + a quadratic-merge DoS fix). The
prototype-pollution CVE-2025-64718 (GHSA-mh29-5h37-fv8m) was already patched in the current 4.1.1, so this is
hardening, not a required CVE fix. **In this batch.**

### #196 tar 7.5.13 → 7.5.16 — BATCH_SAFE ✅ (applied, security-positive)
Patch transitive bump (via `@capacitor/cli` `^7.5.3`, build-time native tooling — never in the web bundle).
**Fixes CVE-2026-53655 / GHSA-vmf3-w455-68vh** (PAX-header desync / file-smuggling, MEDIUM CVSS 6.2; 7.5.14/.15
also hardened hardlink-preemption). No breaking API changes. License **BlueOak-1.0.0** (OSI-approved permissive —
NOT AGPL/copyleft). **In this batch.**

### #187 dev-dependencies group — BATCH_SAFE (recommend; NOT in this batch)
`@types/node` 20.19.41→20.19.43 (types-only, no executable code/CVE surface) + `eslint-config-next` 16.2.6→16.2.9
(pulls `@next/eslint-plugin-next` 16.2.9 — a **dev lint config**, which does NOT need to match the Next runtime
version, unlike #188's runtime binary). Both MIT, all 13 CI checks green, zero app-bundle impact. **Safe**, but
held out of THIS batch only because the goal scoped the safe batch to #198 + #196 — **recommend the owner include
#187 here or in the next batch.**

### #191 @capacitor/core 8.2.0 → 8.4.0 — ISOLATE
Direct **devDependency** = the Capacitor native mobile shell (iOS/Android DCA wrapper); **not imported anywhere in
the web/TS source** (grep-confirmed), so web risk is nil. Minor 8.x bump, no breaking changes (Android safe-area
fixes, SPM/Package.swift generation, additive APIs). MIT, CI green, pins untouched. Kept OFF the web batch because
its changes are native + CLI behavior the web CI cannot exercise — **needs an iOS/Android build smoke-test on its
own branch before merge.**

### #190 @capacitor/cli 8.2.0 → 8.4.0 — ISOLATE (the red is a flake)
Build-time scaffolding for the native shells; never in the web bundle. The PR's **`lint` check is RED, but the
failure is a transient npm-cache infra race** (`npm error EEXIST/ENOENT, syscall rename` on
`~/.npm/_cacache/content-v2/…`, exit 254) — **not a real lint/code error**; a re-run clears it (sibling #191 with
the same change passes lint). MIT, low risk. **ISOLATE** with #191; verify the native build + re-run CI.

### #189 viem 2.47.4 → 2.52.2 — HOLD (ADR-008)
Direct **prod** dep. All-green CI, MIT (no copyleft), no breaking changes in the 2.48–2.52 changelog, **no
CVE/GHSA** (not a security fix). **Held per ADR-008 (Wagmi v2→v3 Migration):** the viem upgrade is coupled to the
planned wagmi-v3 sprint, and "no wagmi-v3" is a standing constraint. viem is **already dual-version in the tree
(2.23.2 + 2.47.4)** — bumping the pinned 2.47.4 independently risks the single-instance invariant and decoupling
from the wagmi/RainbowKit lockstep. Defer to the ADR-008 migration; do not merge piecemeal.

### #188 @next/swc-darwin-arm64 16.2.6 → 16.2.9 — CLOSE
Textbook Dependabot anti-pattern: a **lone platform-specific SWC binary** bump that does NOT match the Next core
version. Next core on main is pinned to **16.2.6** (and `next`'s own `optionalDependencies` require
`@next/swc-darwin-arm64@16.2.6`), so a standalone 16.2.9 SWC binary either gets overridden back to 16.2.6 (no-op)
or risks a runtime SWC/core version mismatch. The SWC binaries move WITH a Next core bump, not independently.
**Recommend CLOSE** — it will resolve correctly when Next core is next upgraded.

## Notes
- **Pre-existing:** viem is dual-version (2.23.2 via the Coinbase SDK tree, 2.47.4 the pinned app version) on main
  — not introduced by this batch; tracked under ADR-008. This batch does not change it.
- **Batch contents:** `chore/deps-safe-batch-4` = js-yaml 4.2.0 + tar 7.5.16 (lockfile-only, 2 packages changed).
  Verified: `npm ci` reproducible, audit-gate 0/0/0, catalog-address-guard 16/16, tsc/lint/tests/build green.
