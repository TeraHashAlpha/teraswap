# chore/remove-capacitor — evidence (companion to `chore-remove-capacitor.md`)
All numbers measured on 2026-11-16 in a worktree off origin/main c23cec40, Node v26.13.1, npm 11.20.0, real `npm ci` (node_modules deleted first) before and after. Lockfile/audit/build raw outputs were kept in the session scratchpad; the commands that produced each table are named under it.

## A. Premise check (evidence 1, long form)
Command: `git ls-files | grep -v '^archive/' | xargs grep -l -i -E 'capacitor|cap:(init|sync|open)'`
Files that match, all of them:
- Config/manifest: `.gitignore` (the "Capacitor native builds" block, lines 80-86, kept), `package.json`, `package-lock.json`.
- Prose only (dated audit and planning records, none instructs anyone to run a `cap:*` script): `Audits/DEPS-TRIAGE-2026-06-02.md`, `-06-12`, `-06-13`, `-06-19`, `Audits/WAGMI-V3-SCOPING-2026-06-02.md`, `Audits/FULL-AUDIT-2026-05-26.md`, `Audits/Daily/health-2026-05-27.md`, `-06-30`, `-08-01`, `Audits/Quarterly/review-2026-Q3.md`, `Audits/Reviews/AZ-REVIEW-2026-07-06.md`, `Audits/Sprint/SPRINT-30-AUDIT.md`, `SPRINT-9Z-AUDIT.md`, `Audits/Weekly/audit-2026-04-08.md` … `audit-2026-08-03.md` (18 files), `TERASWAP-EXECUTION-PLAN.md`, `docs/PITCH-DECK-BRIEF.md`, `docs/TERASWAP-TECHNICAL-OVERVIEW.md`, `docs/Prompts/*` (AUDIT-COMPREHENSIVE-POST-5C, CHORE-AUDIT-GATE-BRACE-EXPANSION, CHORE-AUDIT-GATE-SHARP, CHORE-DEPS-2, CHORE-DEPS-BATCH-5, CHORE-DEPS-TRIAGE-JUN19, CHORE-HYGIENE-1, DEPS-NANOID-TAR, SPRINT-13A, 13B, 24, 30, 32, 9I), `docs/feedback/*` (chore-audit-gate-brace-expansion, chore-dependabot-sweep-2026-11, chore-deps-batch-7, chore-root-overrides-2026-10-07, chore-security-audit-2026-10-02, chore-security-pins-2026-10-06, chore-dependabot-alerts-2026-11), `docs/security/AUDIT-TOTAL.md`.
- Under `src/`, `scripts/`, `e2e/`, `contracts/`, `.github/`, `workers/`, `supabase/`, `public/`: **0 files**. No `capacitor.config.*`, `android/` or `ios/` at the root.
- `git grep -n -E 'cap:(init|sync|open)|npx cap |cap sync|cap add|cap open' -- ':!archive' ':!package-lock.json'` returns only past-tense records ("`npx cap sync ios` exit 0" in the June audits, "intentionally kept" in the Nov sweep feedback). Nothing tells anyone to run a script, so no pointer note was added to any doc.

**One premise difference that mattered** (the only file outside the checked trees that uses Capacitor, found by running `tsc`, not by grep): `archive/mobile-prototype-2026/capacitor.config.ts` line 1 is `import type { CapacitorConfig } from '@capacitor/cli'`, and `tsconfig.json` includes `**/*.ts` with no `archive` exclusion. After the uninstall `tsc --noEmit` failed: `archive/mobile-prototype-2026/capacitor.config.ts(1,38): error TS2307: Cannot find module '@capacitor/cli'`; `next build` runs the same type-check. Owner chose (asked once): add `"archive"` to `tsconfig.json` `exclude`. Side effect: `archive/src/components/UsageTracker.tsx` (the only other archived TS file) also leaves the type-check; nothing imports it (`git grep` for imports of `archive/` outside the archive: 0).

## B. package.json (evidence 2)
```
scripts:     - cap:init:android  - cap:sync  - cap:open:android            (3 lines)
dependencies - @capacitor/android 8.5.3, browser 8.0.5, cli 8.5.3, core 8.5.3, ios 8.5.3,
               splash-screen 8.0.2, status-bar 8.0.4                        (7 lines)
overrides    - "tar": "^7.5.21"                                              (1 line; see below)
11 deletions, 0 additions. `.npmrc` untouched. `.gitignore` untouched.
```
`overrides` check, by script over the new lockfile: 23 of 24 keys still match an installed package. The one that does not: **`tar`**. Before, the only declarer of `tar` anywhere in the lockfile was `@capacitor/cli` (`dependencies.tar ^7.5.3`, installed copy 7.5.22); after, 0 packages declare it and 0 lockfile paths end in `/tar`. Removed per the goal's rule. `npm ci` accepts the result and the lockfile is unchanged by that step.

## C. Lockfile: packages removed and the five named packages (evidence 2)
`package-lock.json`: 1142 → 1074 package entries = **68 removed**, 0 added, 0 version changed. The only 6 added lines are `"dev": true` on `@types/node@20.19.43`, `cross-spawn`, `path-key`, `shebang-command`, `shebang-regex`, `undici-types@6.21.0` (prod-reachable before only through `@capacitor/cli`, dev-only now).

Removed packages (68): the 7 `@capacitor/*`; `@ionic/cli-framework-output`, `@ionic/utils-array`, `-fs` (+ nested `fs-extra@9.1.0`), `-object`, `-process`, `-stream`, `-subprocess`, `-terminal`; `@isaacs/fs-minipass`, `@types/fs-extra`, `@types/slice-ansi`, `@xmldom/xmldom`, `astral-regex`, `at-least-node`, `big-integer`, `bplist-creator`, `bplist-parser` (+ nested 0.3.1 under `simple-plist`), `buffer-crc32`, `chownr`, `commander@12.1.0`, `define-lazy-prop`, `elementtree`, `env-paths`, `fd-slicer`, `fs-extra@11.3.4`, `graceful-fs@4.2.11`, `ini@4.1.3`, `is-docker@2.2.1`, `is-wsl@2.2.0`, `jsonfile`, `kleur@4.1.5` (+ nested 3.0.3 under `prompts`), `minizlib`, `native-run`, `open@8.4.2`, `package-json-from-dist`, `pend`, `plist`, `prompts`, `rimraf@6.1.3`, `sax@1.1.4`, `signal-exit@3.0.7`, `simple-plist`, `sisteransi`, `slice-ansi`, `stream-buffers`, `tar@7.5.22` (+ nested `yallist@5.0.0`), `through2`, `tree-kill`, `universalify`, `untildify`, `wrap-ansi@7.0.0`, `xcode@3.0.1` (+ nested `uuid@7.0.3`), `xml2js` (+ nested `xmlbuilder@11.0.1`), `xmlbuilder@15.1.1`, `yauzl`.

| Package | Copies before | Disappeared | Remain (parent that still needs it) |
|---|---|---|---|
| **rimraf** | 6.1.3 | **6.1.3** (needed only by `@capacitor/cli`, `^6.0.1`) | none |
| **glob** | 13.0.6 | none | **13.0.6**: `@sentry/bundler-plugins` 10.78.0 (`^13.0.6`). Its other parent, `rimraf@6` (`^13.0.3`), is gone |
| **minimatch** | 3.1.5 (dev), 10.2.5 under glob, 10.2.5 under typescript-estree (dev) | none | 3.1.5: `eslint`, `@eslint/config-array`, `@eslint/eslintrc`, `eslint-plugin-import`, `-jsx-a11y`, `-react`; 10.2.5 under glob: `glob@13.0.6`; 10.2.5 under typescript-estree: `@typescript-eslint/typescript-estree` 8.59.1 (`^10.2.2`) |
| **uuid** | 9.0.1 × 5 paths, 8.3.2, 7.0.3 | **7.0.3** (under `xcode`, needed only via `@capacitor/cli`) | 9.0.1 under `@metamask/utils` (5 paths: also under eth-json-rpc-provider, json-rpc-engine, json-rpc-middleware-stream, providers); 8.3.2: `@metamask/sdk` 0.33.1 and `@metamask/sdk-communication-layer` 0.33.1 |
| **xcode** | 3.0.1 | **3.0.1** (needed only by `@capacitor/cli`, `^3.0.1`) | none |

`npm ls @capacitor/android @capacitor/browser @capacitor/cli @capacitor/core @capacitor/ios @capacitor/splash-screen @capacitor/status-bar` after a clean `npm ci`: each prints `(empty)`; `node_modules/@capacitor` does not exist.

## D. `npm audit` before and after (evidence 3)
| | info | low | moderate | high | critical | total |
|---|---|---|---|---|---|---|
| before (c23cec40) | 0 | 3 | 21 | 11 | 0 | 35 |
| after | 0 | 3 | **18** | 11 | 0 | **32** |

Entries that changed: `@capacitor/cli` (moderate, direct) gone; `rimraf` (moderate) gone; `xcode` (moderate) gone; `uuid` moderate, 7 vulnerable nodes → 6 (the `xcode` copy). Nothing else moved: high 11 and low 3 are the same entries, `zod` (high) still has its 2 nodes.

Dependabot alerts named in the goal (npm paths left in the tree, from `npm audit --json` after):
| Alert | Package | Paths before | Paths after | Verdict |
|---|---|---|---|---|
| #144 | glob 13.0.6 | 1 node (`node_modules/glob`; two parents) | 1 node, one parent (`@sentry/bundler-plugins`) | **keeps one path**; alert stays open |
| #146 | minimatch 10.2.5 | 2 nodes | 2 nodes (`glob/node_modules/minimatch`, `typescript-estree/node_modules/minimatch`) | **keeps both paths**; alert stays open |
| #33 | uuid | 7 nodes | 6 nodes (5 × `@metamask/*/node_modules/uuid@9.0.1`, 1 × `uuid@8.3.2`) | **keeps six**; loses only the `uuid@7.0.3` copy |
None of the three loses all its paths, so none closes by this change alone. No alert was dismissed or touched. Alert #147 (SwiftPM `Package.resolved` in the archive) is not an npm path and is unaffected.

`scripts/audit-gate.mjs` after: `1 high/critical advisory present, 1 allowlisted, 0 blocking` (zod, expires 2026-12-22); `audit-gate PASSED`.

## E. Build comparison (evidence 4)
Next.js 16.4.5 (Turbopack) does not print a "First Load JS" table, so it was computed from the build output by one script, the same for both builds: the unique client chunks named by `.next/server/app/page_client-reference-manifest.js` (`/page`) plus `rootMainFiles` and `polyfillFiles` from `build-manifest.json`, summed raw and gzipped.

| | Chunks of `/` | First Load JS raw | First Load JS gzip | Client `.js` files in `.next/static` | Their total raw bytes |
|---|---|---|---|---|---|
| before | 31 | 2,927,433 | 810,842 | 257 | 9,267,255 |
| after | 31 | 2,927,433 | 810,842 | 257 | 9,267,255 |

Unchanged, as expected: all 257 files have identical SHA-1 content (as a set); only 3 file names differ (hash part of the name), contents identical. `next build` passes after (`Finished TypeScript in 11.6s`).
