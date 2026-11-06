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
