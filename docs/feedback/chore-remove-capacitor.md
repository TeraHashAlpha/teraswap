# chore/remove-capacitor — FEEDBACK (no PR; owner opens it)
Base: origin/main c23cec40. The goal text says "premise at 7e566fd"; that commit is an ancestor and origin/main is 20 commits ahead (local `main` was behind), so everything here is re-measured at c23cec40. Versions, scripts and `.gitignore` block are the same as at 7e566fd.
Long tables are in `chore-remove-capacitor.evidence.md` (companion file, same folder); section letters below point into it.

## Checklist
- [x] Commit 0: this file (first commit)
- [x] Commit 1a (added, owner-approved): `tsconfig.json` excludes `archive`, so the type-check survives the uninstall
- [x] Commit 1: `npm uninstall` the seven `@capacitor/*` packages, delete the three `cap:*` scripts, drop the now-orphaned `tar` override
- [x] Commit 2: "Removed from the root on 2026-11-16" in the archive README; no doc outside the archive tells anyone to run a `cap:*` script, so no pointer notes
- [x] Commit 3: nothing to change — `.github/dependabot.yml` has no Capacitor-only rule; `audit-allowlist.json` untouched (proposals below), so no commit
- [x] Verify (results at the bottom)
- [x] Push `chore/remove-capacitor`, compare link

## Premise differences (read these first)
1. **Archived file breaks the type-check (asked once, owner answered).** `archive/mobile-prototype-2026/capacitor.config.ts:1` does `import type { CapacitorConfig } from '@capacitor/cli'` and `tsconfig.json` includes `**/*.ts` with no `archive` exclusion. After the uninstall `tsc --noEmit` failed with TS2307, and `next build` runs the same check. The goal also says "edit no other archived file". Owner chose: add `"archive"` to `tsconfig.json` `exclude` (own commit, before the uninstall, so every commit typechecks). Side effect: `archive/src/components/UsageTracker.tsx` also leaves the type-check; nothing imports it. This is the one change outside `package.json`, the lockfile, the archive README and this folder.
2. **`overrides`: one entry became an orphan and was removed, as the goal allows.** `"tar": "^7.5.21"` matched only `@capacitor/cli` (`tar ^7.5.3`); after the uninstall no package declares `tar` and none is installed. The other 23 override keys still match an installed package (evidence B).
3. **The three scripts and all seven packages are exactly as the premise says**, same versions (android 8.5.3, browser 8.0.5, cli 8.5.3, core 8.5.3, ios 8.5.3, splash-screen 8.0.2, status-bar 8.0.4). Open Dependabot Capacitor PRs exist on the remote (e.g. `dependabot/npm_and_yarn/capacitor/ios-8.6.0`); not touched, they close by themselves.

## Evidence 1: premise check
`git ls-files | grep -v '^archive/' | xargs grep -l -i -E 'capacitor|cap:(init|sync|open)'` matches only `.gitignore`, `package.json`, `package-lock.json` and dated prose in `Audits/`, `docs/`, `TERASWAP-EXECUTION-PLAN.md`. **0 matches** under `src/`, `scripts/`, `e2e/`, `contracts/`, `.github/`, `workers/`, `supabase/`, `public/`; no `capacitor.config.*`, `android/` or `ios/` at the root; `.gitignore:80-86` "Capacitor native builds" block present and kept. The one real consumer found was the archived config above, by running `tsc`, not by grep. Full file list: evidence A.

## Evidence 2: package.json and lockfile
`package.json`: 11 lines deleted, 0 added: the 3 `cap:*` scripts, the 7 `@capacitor/*` dependencies, the `tar` override. `.npmrc` untouched. `.gitignore` untouched. `package-lock.json`: 1142 → 1074 entries, **68 packages removed**, 0 added, 0 versions changed; the only added lines are six `"dev": true` flags (packages that were prod-reachable only via Capacitor). After a clean `npm ci`, `npm ls` for each of the seven prints `(empty)`.

| Package | Disappeared | Remains, and the parent that still needs it |
|---|---|---|
| rimraf | 6.1.3 (only `@capacitor/cli`) | none |
| glob | none | 13.0.6 ← `@sentry/bundler-plugins` (its other parent `rimraf@6` is gone) |
| minimatch | none | 3.1.5 ← eslint and its plugins; 10.2.5 ← `glob@13.0.6`; 10.2.5 ← `@typescript-eslint/typescript-estree` |
| uuid | 7.0.3 (under `xcode`) | 9.0.1 × 5 paths ← `@metamask/utils`; 8.3.2 ← `@metamask/sdk`, `@metamask/sdk-communication-layer` |
| xcode | 3.0.1 (only `@capacitor/cli`) | none |

So the goal's expectation "`@capacitor/cli` pulls rimraf, glob, minimatch 10 and uuid 7" is half true: it was the only parent of rimraf, xcode and uuid 7.0.3, but **glob 13 and both minimatch 10 copies have other parents** and stay.

## Evidence 3: `npm audit` and the alerts
| | low | moderate | high | critical | total |
|---|---|---|---|---|---|
| before | 3 | 21 | 11 | 0 | 35 |
| after | 3 | **18** | 11 | 0 | **32** |

Gone: `@capacitor/cli`, `rimraf`, `xcode` (all moderate); `uuid` goes from 7 vulnerable nodes to 6. **No Dependabot alert loses all its paths**: #144 glob keeps 1 path (`@sentry/bundler-plugins`), #146 minimatch keeps 2 (glob's copy and typescript-estree's), #33 uuid keeps 6 (loses only the `uuid@7.0.3` copy). So none of the three closes by itself; the owner still decides what to do with them. #147 (SwiftPM in the archive) is not an npm path. Nothing was dismissed. Detail: evidence D.

## Allowlist: what could be narrowed or dropped (proposals only; `audit-allowlist.json` is untouched)
Measured: no entry's package left the tree, so **nothing can be dropped**. Wording that is now stale:
- **glob `GHSA-3g3m-2fjr-6pw4`**: `vulnerableRange` says "13.0.6 via rimraf@6 and @sentry/bundler-plugins" and `reason` names "rimraf@6 (^13.0.3) and @sentry/bundler-plugins (^13.0.6)". `rimraf` is gone; the only parent left is `@sentry/bundler-plugins`. Narrow the text to it. The entry itself stays (glob 13.0.6 is still moderate).
- **uuid `GHSA-w5hq-g745-h8pq`**: `vulnerableRange` and `reason` name "7.0.3 via xcode" and "xcode (^7.0.3)"; `xcode` and `uuid@7.0.3` are gone. Narrow to 9.0.1 (via `@metamask/utils`) and 8.3.2 (via `@metamask/sdk`). The reachability sentence says "the three copies … and xcode"; it is now two copies and no xcode. The entry stays.
- **minimatch `GHSA-g3hv-75wg-m249`**, **zod**, **elliptic**, **deepmerge**: unaffected (no removed package was one of their parents).
- Quirk, not caused by this change: `node scripts/audit-gate.mjs` prints "RESOLVED … delete this allowlist entry" for minimatch, glob, uuid, elliptic and deepmerge. The gate only collects high/critical advisories (`audit-gate.mjs:51`), these entries are moderate/low, so it says "no longer appears" about them whether or not they are in the tree. Do not delete them on that message; `npm audit` still lists glob, minimatch, uuid and deepmerge (elliptic lives in the keeper lockfile, not this one).

`.github/dependabot.yml`: read in full; its only rules are the `*` semver-major ignore and the `dev-dependencies` group. No rule names a Capacitor package, so no commit.

## Evidence 4: build, verify, diff, link
Build (evidence E): 257 client chunks before and after; First Load JS of `/` 2,927,433 B raw / 810,842 B gzip before and after (31 chunks; computed from the build manifests because Next 16.4 prints no First Load table). All 257 files have identical content hashes; 3 file names differ. **Unchanged.**

Verify, `scripts/agent-verify.sh --codeql` at 6e0a136e (before this feedback commit), base origin/main c23cec40, Node v26.13.1:
```
suite:       PASS 10814 tests passed, 0 failed, 502 files
lint-delta:  PASS errors +0, warnings +0 (0 changed files)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      SKIP not requested (--keeper); no keeper file or lockfile touched
RESULT: PASS
```
- `node scripts/gen-claude-state.mjs --check` → "CLAUDE.md state block is current" (exit 0).
- `node scripts/audit-gate.mjs` → PASSED, 1 high/critical present (zod, allowlisted, expires 2026-12-22), 0 blocking.
- The four `scripts/agent-verify.test.mjs` tests the goal expected to fail on Node 26: they **passed** (0 failed in the suite); that file was fixed on main by the harness-housekeeping merge before this base.
- CodeQL 13 → 13 is expected: the CodeQL alerts are on source, none of which this branch touches.
- Untested, said plainly: keeper `node --test` on Node 20/22 (not requested, nothing in the keeper tree changed) and the Vercel preview (owner's CI).

`git diff --stat origin/main...HEAD` before this last feedback commit: 5 files, 74 insertions, 695 deletions (README +47, feedback +20, package-lock −690/+6, package.json −11, tsconfig +1). Compare link (no PR opened): https://github.com/TeraHashAlpha/teraswap/compare/main...chore/remove-capacitor

Commits (signed, SSH): feedback file; tsconfig exclude; remove packages + scripts + `tar` override; archive README restore section; this final feedback edit with the companion evidence file.
