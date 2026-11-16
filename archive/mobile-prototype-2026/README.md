# Mobile prototype (Capacitor iOS) — archived 2026-11-06

**Status: never shipped.** TeraSwap has no app in any store (Apple App Store, Google Play).
This Capacitor iOS scaffold was a dormant prototype and was never released to users.

**Archived on 2026-11-06** from the repository root under `ios/` and `capacitor.config.ts`
to this folder, per the repo rule of archive-never-delete (CLAUDE.md, rule 4). Files are
preserved verbatim; git history (`git log --follow`) follows each file through the move.

## Contents

| Archived path | Original path |
|---|---|
| `ios/` (Xcode project, SwiftPM package, assets, `debug.xcconfig`) | `ios/` |
| `capacitor.config.ts` | `capacitor.config.ts` |

No `android/` directory existed in the repository, so none was archived.

## Dependabot alert #142

Dependabot alert **#142** (critical, open at the time of archiving — "Capacitor Android and iOS:
remote content can be loaded at the app origin via the internal HTTP proxy path") refers to the
SwiftPM manifest that lives in this archive:

- Dependency: `github.com/ionic-team/capacitor-swift-pm`
- Manifest: `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
  (now at `archive/mobile-prototype-2026/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`)

Because nothing ships this code, the alert concerns an unreleased prototype only. The alert is
not dismissed by this move; the dismissal decision belongs to the repository owner.

## npm scripts removed from `package.json`

These scripts drove the iOS native project and were removed with it:

- `cap:init:ios` → `npx cap add ios`
- `cap:open:ios` → `npx cap open ios`

Still present in `package.json` (not iOS-specific, not removed): `cap:init:android`,
`cap:open:android`, `cap:sync`. The `@capacitor/*` packages are still listed as dependencies;
they were not removed in this change.

## Config and lint references

- `eslint.config.mjs` no longer ignores `ios/**` (or `android/**`); the paths no longer exist.
- No workflow, tsconfig, test config, CSP header (`next.config.js`) or vitest config references
  `ios/` after this move.
- The root `.gitignore` still contains Capacitor native-build lines (`ios/App/Pods/`, etc.). They
  are inert (root-anchored, no longer match anything) and were left in place; the archived
  `ios/.gitignore` covers the same build outputs inside this folder.

## Reviving this prototype

Not supported as-is. Reviving it would require restoring `ios/` and `capacitor.config.ts` to the
repository root (or pointing `cap` at this folder), re-adding the removed `cap:*:ios` scripts,
running `npx cap sync ios`, and resolving the Dependabot alert #142 Capacitor upgrade first.

## Removed from the root on 2026-11-16

Owner decision 2026-11-16: the mobile app is not needed for now. The root `package.json` no longer
installs Capacitor, and the sections above that say the `@capacitor/*` packages and the
`cap:init:android`, `cap:open:android` and `cap:sync` scripts are "still present" describe the
repository as it was on 2026-11-06, not today.

**Packages removed** (all were `dependencies`, exact pins, `.npmrc` has `save-exact=true`):

| Package | Version removed |
|---|---|
| `@capacitor/android` | 8.5.3 |
| `@capacitor/browser` | 8.0.5 |
| `@capacitor/cli` | 8.5.3 |
| `@capacitor/core` | 8.5.3 |
| `@capacitor/ios` | 8.5.3 |
| `@capacitor/splash-screen` | 8.0.2 |
| `@capacitor/status-bar` | 8.0.4 |

**Scripts removed**, verbatim from the `scripts` block of the root `package.json`:

```json
"cap:init:android": "npx cap add android",
"cap:sync": "npx cap sync",
"cap:open:android": "npx cap open android",
```

**Also removed or changed in the same change** (restore them with the packages):

- the `overrides` entry `"tar": "^7.5.21"` (its only consumer was `@capacitor/cli`);
- `tsconfig.json` now lists `"archive"` in `exclude`, because `capacitor.config.ts` in this folder imports
  a type from `@capacitor/cli` and the root type-check would fail without the package. If the packages come
  back, the exclusion can stay (the archive is never built).

**The one command that restores the packages** (run from the repository root; the versions are the
exact ones above):

```sh
npm install --save-exact @capacitor/android@8.5.3 @capacitor/browser@8.0.5 @capacitor/cli@8.5.3 @capacitor/core@8.5.3 @capacitor/ios@8.5.3 @capacitor/splash-screen@8.0.2 @capacitor/status-bar@8.0.4
```

Then paste the three script lines above back into `scripts`, restore the `ios/` folder and
`capacitor.config.ts` from this archive to the root (see "Reviving this prototype"), and re-check
Dependabot alert #142 before running `npx cap sync`. Restoring the packages also brings back the
`rimraf`, `xcode` and `uuid@7.0.3` copies, which only `@capacitor/cli` needed (and the Dependabot
alerts that go with them).
