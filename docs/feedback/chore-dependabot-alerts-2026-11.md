# chore/dependabot-alerts-2026-11 — FEEDBACK (no PR; owner opens it)
Base: origin/main 130f2ddf (PR #688). The goal text says "premise at 7e566fd"; that commit is an ancestor of origin/main, local `main` was 15 commits behind. Everything below was re-measured at 130f2ddf.
Long tables go to `chore-dependabot-alerts-2026-11.evidence.md` (companion file, same folder).

## Checklist
- [x] Commit 0: this file
- [x] Commit 1: fix what has a fix: hono override 4.13.11 -> 4.13.16 (nothing else has an eligible same-major fix)
- [x] Commit 2: reachability of what stays open (evidence in the companion file, section C)
- [x] Commit 3: why Dependabot opened no PRs, proposal only
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`, `npm audit` before/after, wagmi/connector tests
- [ ] Push, compare link

## Premise differences found while reading (more below as they appear)
- Alerts confirmed by `gh api .../dependabot/alerts?state=open` (read-only): 12 open, numbers as in the goal. #147 is `archive/mobile-prototype-2026/.../Package.resolved` (swift, `github.com/ionic-team/capacitor-swift-pm`), not npm.
- The root `package.json` ALSO declares `@capacitor/*` at 8.5.3 (lines 35-41). So the archive is not the only Capacitor in the repo; `@capacitor/cli` is what pulls rimraf, glob, minimatch 10.2.5 and uuid 7.0.3 (via xcode).
- zod: only two copies are vulnerable (3.25.76 under @coinbase/cdp-sdk, 3.22.4 under @reown/appkit-wallet). abitype, porto and eslint-plugin-react-hooks already resolve to the patched 4.6.6.
- hono: the root `overrides` already pins `hono` to exactly 4.13.11 (`package.json:95`). The pin, not a missing update, is what keeps the alerts open.

## Evidence 1 and 2: see `chore-dependabot-alerts-2026-11.evidence.md` (A: table of all 12 alerts; B: audit before/after)
Short form: 11 non-Capacitor alerts, 5 fixed (hono, one pinned override moved 4.13.11 → 4.13.16), 6 left open because the only patched versions are majors the parents cannot take (zod 4.6.6, minimatch 11.0.1, glob 14.0.2, uuid 11.1.1) or no patch exists (deepmerge, elliptic). `npm audit` root: 37 → 35 packages (moderate 23 → 21; low 3, high 11, critical 0 unchanged). `.npmrc` untouched; nothing was held back by `min-release-age` (every patched version is older than 7 days; the blocker is the major, not the age).

## Evidence 3: reachability of what stays open (commit 2). Method and counts: companion file, section C
Common to all six: first-party code imports none of the seven packages; none of their marker strings is in the 258 browser chunks or the server output of `npm run build`; none is traced into a Vercel function (`.nft.json`, with a positive control); the keeper executor lockfile (`contracts/order-engine/executor`) contains none of them. So the exposure is install-time, build-time or dev tooling, not the shipped app. The owner decides what "leave open" means for the dashboard; I dismissed nothing.

- **#134 zod (high).** The advisory is an uncontrolled-memory bug in `$ZodArray` (`handleArrayResult`): a schema with an array and no length cap validating an oversized array. The two vulnerable copies are 3.22.4 (appkit-wallet; no `handleArrayResult` in it at all) and 3.25.76 (cdp-sdk; the function exists only in its `v4` subtree, and cdp-sdk imports bare `"zod"`, the v3 API). Neither is in the browser or server build output. The RainbowKit wallet list (`src/lib/wagmiConfig.ts:136-140`: rabby, metaMask, coinbase, walletConnect, ledger, injected) is what the app loads. Who could trigger it: someone who can make a zod 3 schema inside one of these two SDKs parse a huge attacker-sized array, in practice a malicious wallet or relay talking to a user's own browser tab; since the zod code is not in our chunks, nobody through our site. Gain: a crash of that tab or process, no data, no funds. Keeper: not present.
- **#146 minimatch (moderate) and #144 glob (moderate).** minimatch 10.2.5: DoS by pattern amplification when `optimizationLevel >= 2`. glob 13.0.6: keeps walking the filesystem after an abort. Both need an attacker to choose the PATTERN (minimatch) or the app to rely on `AbortSignal` as a request budget (glob). Our users of them: `@sentry/bundler-plugins` (build-time source-map work), `@capacitor/cli` → rimraf@6 (dev, `cap:*` scripts), `typescript-eslint` (lint). Patterns come from our own repo files and config, never from a request, and none of it runs on Vercel at request time (0 hits in bundles and traces). Who could trigger it: only someone who can already edit this repo or its CI config. Gain: a slower build. glob 13.0.7 very probably already carries the glob fix (companion D1), but the advisory range still flags it.
- **#33 uuid (moderate).** Missing buffer bounds check in `v3`/`v5`/`v6` when a `buf` argument is passed. The three copies (9.0.1, 8.3.2, 7.0.3) are called only as `v4()` and `validate()` by @metamask/utils, @metamask/sdk, @metamask/sdk-communication-layer and xcode (0 references to v3/v5/v6; the bundled MetaMask chunk has no v3/v5 code). Not reachable. This closes the "reachability NOT yet verified" note in the allowlist entry. Who/gain: nobody, there is no code path.
- **#139 deepmerge (low).** `mergeObject()` prototype pollution with attacker-supplied source objects. It sits behind `@vanilla-extract/css`, a build-time CSS helper; RainbowKit's runtime imports only `@vanilla-extract/dynamic` and `sprinkles`, and `isMergeableObject` is in no chunk or server file. Not reachable at runtime; at build time the merged inputs are RainbowKit's own style objects, not user data.
- **#3 elliptic (low, `contracts/order-engine/package-lock.json`).** A signing flaw (RFC 6979 `k` with leading zeros) that can leak a key through ECDSA signatures made BY elliptic. It is a devDependency of hardhat-verify through the old `@ethersproject/signing-key`. The keeper executor (`contracts/order-engine/executor`, its own lockfile) has none of it in its tree. On-chain writes by the owner go through the owner's own terminal tooling, not this path. Not in any shipped artifact.
- **#147 Capacitor (critical, the owner's).** `archive/mobile-prototype-2026/` tracks, besides images and a README, 7 source/config files (`capacitor.config.ts`, 3 Swift files, 3 asset `Contents.json`) and the `Package.resolved` with `capacitor-swift-pm` pinned at 8.2.0. Measured: (a) no CI workflow, `vercel.json`, `.vercelignore`, `next.config.js`, package script or shell script mentions `archive`, `ios`, `swift`, `xcodebuild` or the folder name (`git grep -nIE`), and CodeQL's matrix is `javascript-typescript` only (`codeql.yml:27-28`); the only `cap:*` scripts are Android and need a root `capacitor.config.ts`, which does not exist. (b) vitest's `include` globs cover `src`, `__tests__` and named `scripts/*` folders only. (c) **Exception, to be exact:** `tsconfig.json` includes `**/*.ts` and does not exclude `archive/`, so `tsc --noEmit` (and the type-check inside `next build`) reads `archive/mobile-prototype-2026/capacitor.config.ts` (`tsc --listFilesOnly` lists it), and `eslint .` lints it (exit 0, no output). That file is TypeScript doing `import type { CapacitorConfig } from '@capacitor/cli'`, which resolves to the ROOT `@capacitor/cli`; it never touches `Package.resolved`, and nothing compiles the Swift. So: the vulnerable SwiftPM pin is read by no build, CI or deploy step; the folder is read by type-check and lint only, through one TS config file. I did not change tsconfig or eslint (outside the allowed files).

## Allowlist proposals (propose only; `audit-allowlist.json` untouched)
`scripts/audit-gate.mjs` gates high/critical only, so only zod is gate-relevant. The zod entry `GHSA-mrhx-c7xc-m3w5` expires **2026-11-22**, eight days from now. Proposal: renew it to 2026-12-22 and replace its reachability sentence with the measurement above (copies absent from browser and server output, 3.22.4 lacks the vulnerable function, cdp-sdk uses the v3 API). The uuid entry can drop "reachability NOT yet verified" (verified: only `v4`/`validate`). The minimatch, glob, uuid, elliptic and deepmerge entries expire 2026-12-06 and need no change now. If the owner wants glob cleared in practice, `npm update glob` (13.0.7) is the in-range candidate (companion D1). No entry for hono: it is fixed.

## Commit 3: why Dependabot opened no PR for these alerts (read: `.github/dependabot.yml`, `dependabot-auto-merge.yml` header + gate, `security-audit.yml`)
Measured: Dependabot security updates ARE enabled (`gh api repos/TeraHashAlpha/teraswap`: `dependabot_security_updates: enabled`) and do open PRs for transitive packages when a same-major lockfile fix exists (#678 fast-xml-parser in `/contracts/order-engine/executor`, #638 follow-redirects in `/contracts/order-engine`; neither directory is in `dependabot.yml`). The auto-merge workflow only judges PRs that already exist (`dependabot-auto-merge.yml:26-40`), so it is not the reason.
1. **hono (#149-#153):** a same-major fix existed (4.13.16, 13 days old) but the lockfile copy was pinned by the exact root `overrides` entry `"hono": "4.13.11"`; npm cannot move it and, as far as I can tell, Dependabot does not edit `overrides` (inference, not measured; an earlier hono PR #142 was closed). **The other six:** the only patched versions are majors the parents' ranges forbid (`dependabot.yml` also ignores `semver-major` for `*`; I could not measure whether that ignore applies to security updates, and it does not matter, since a PR would need a parent major: wagmi 3, @sentry/nextjs 11, rainbowkit 0.1.0) or no patch exists (deepmerge, elliptic).
2. **Smallest config change that would bring PRs (NOT applied):** none of the six open ones can be fixed by config alone. For the hono class of problem, loosen the pin to a range so lockfile-only patch bumps stay possible: `"hono": "^4.13.16"` in `package.json` overrides; and, to let version updates look at transitive packages too, add `allow: [{ dependency-type: "all" }]` to the `npm` entry of `dependabot.yml` (note: it brings every in-range transitive bump, capped by `open-pull-requests-limit: 5`, and auto-merge R4 labels npm indirect/runtime PRs `deps-review`, so they would still wait for the owner). Neither change is in this branch.

## Evidence 4: verify (first run, `scripts/agent-verify.sh --keeper --codeql`, at 84b7f89c, base 130f2ddf)
```
suite:       FAIL exit 1; 10630 passed, 2 failed, 494 files
lint-delta:  PASS errors +0, warnings +0 (0 changed files)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 111 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      FAIL node20:MISSING node22:MISSING (Node 20/22 were not installed)
diff --stat origin/main...HEAD: evidence.md +49, feedback.md +38, package-lock.json 6 (+3/-3), package.json 2 (+1/-1); 4 files, 91 insertions, 4 deletions
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/dependabot-alerts-2026-11
```
- The 2 suite failures are `src/ui/v2/fiat/fiat.test.tsx` ("a payload that was fresh when fetched but has since aged out…" and "a rate that was fresh when loaded flips to dollars…"). Same file run on a detached worktree of origin/main 130f2ddf (node_modules symlinked): `Tests 2 failed | 20 passed (22)`, the same two. They are the clock-bound tests already known from the privacy-leftovers branch; this branch changes no source.
- Wagmi config/connector tests are inside that suite (`src/lib/wagmiConfig.test.ts`, `src/lib/lazy-walletconnect.test.ts`) and passed unchanged.
- **Keeper (node:test, Node 20 + 22): NOT YET RUN.** This branch touches no keeper file or keeper lockfile. After the incident below, re-run `scripts/agent-verify.sh --keeper --codeql` once Node works again.

## Incident during this goal (mine): `brew install node@20 node@22` broke the Homebrew Node 25
To get Node 20/22 for `--keeper` I ran `brew install node@20 node@22`. It upgraded the shared dependency `simdjson` (to 5.1.1), and the installed `/opt/homebrew/Cellar/node/25.6.1/bin/node` links `libsimdjson.29.dylib`, which no longer exists: `dyld: Library not loaded … libsimdjson.29.dylib`. Every Bash call in this session now fails in the command-guard hook (the hooks run `node`), so the agent cannot run any command. I did not touch the hooks or settings.
Owner fix (owner terminal): `brew reinstall node` (or `brew upgrade node`), then check `node -v`. Node 20 and 22 ARE installed (`/opt/homebrew/opt/node@20`, `/opt/homebrew/opt/node@22`).
Left to do after that: (1) commit this section (signed), (2) `scripts/agent-verify.sh --keeper --codeql` once more, (3) `git push origin chore/dependabot-alerts-2026-11`, (4) `git worktree remove ~/ts-worktrees/dependabot-alerts-base` (a detached base worktree I created for the fiat proof; it holds a symlink to this worktree's node_modules, remove it with `git worktree remove --force`).
Lesson for the harness docs: `agent-verify.sh` tells the agent to `brew install node@20 node@22`; on this Mac that command can break the active Node. Run `brew install --dry-run node@20 node@22` first and stop if it would upgrade a library the active Node links against (here `simdjson`), or ask the owner to install them.

## Evidence 4 (final): verify at 9aff6a94, base origin/main 198a572f (main moved by PR #687 during the goal; this branch is not merged with it)
```
suite:       FAIL exit 1; 10625 passed, 7 failed, 494 files
lint-delta:  PASS errors +0, warnings +0
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 111 / rpc-budget: PASS 36
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      PASS node20:1240-pass/0-fail node22:1240-pass/0-fail
diff --stat origin/main...HEAD: package.json 2 (+1/-1), package-lock.json 6 (+3/-3), 2 feedback files; 4 files, 114 insertions, 4 deletions
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/dependabot-alerts-2026-11
```
The 7 suite failures, none caused by this diff (it changes one override, its lockfile lines and docs):
- 2 in `src/ui/v2/fiat/fiat.test.tsx`: clock-bound, fail identically on origin/main 130f2ddf (run on a detached base worktree: 2 failed, 20 passed). PR #687 (tooling-leftovers) is the pin for them; not merged here.
- 4 in `scripts/agent-verify.test.mjs` ("fake installs" keeper tests): they fail on the untouched base 130f2ddf too (4 failed, 2021 passed) on this Mac, after my `brew install node@20 node@22` changed which Node installs the script finds (active Node is now v26.13.1). Environment, not code. Worth a look at that test's isolation from real brew/nvm installs.
- 1 in `scripts/agent-hooks.test.mjs` ("A77d H-11 ... stay allowed in the main checkout"): a 5000 ms timeout while the whole suite ran; the file passes when run alone with the other tooling file.
Wagmi config/connector tests (`src/lib/wagmiConfig.test.ts`, `src/lib/lazy-walletconnect.test.ts`) are in the suite and passed unchanged.

## Incident (mine): `brew install node@20 node@22` broke the active Node
It upgraded `simdjson`; the Homebrew Node 25.6.1 then could not load `libsimdjson.29.dylib`, and every agent shell call failed in the guard hooks (which run on `node`) until the owner relinked Node. The hooks were not touched. Lesson: run `brew install --dry-run node@20 node@22` first and stop if it would upgrade a library the active Node links against, or ask the owner to install them.

## Left for the owner
- Push is done by the agent (branch only, no PR): `git push origin chore/dependabot-alerts-2026-11`.
- Detached base worktree `~/ts-worktrees/dependabot-alerts-base` is removed after the push.
- Allowlist: propose renewing the zod entry (expires 2026-11-22), see "Allowlist proposals" above.

## Evidence 4 (latest): verify at 2e1c3bd9 (origin/main 198a572f merged in, signed merge commit)
suite 10687 passed, 4 failed; tsc, build, parity, rpc-budget, lint-delta PASS; codeql 13 to 13, 0 new; keeper PASS node20 1240 and node22 1240. diff --stat origin/main...HEAD: package.json 2, package-lock.json 6, 2 feedback files (4 files, 140 insertions, 4 deletions).
The 7 earlier failures are now 4: merging main cleared the 2 fiat tests (PR #687) and the hooks timeout. The remaining 4 are all `scripts/agent-verify.test.mjs` fake-install keeper tests; they fail identically on the untouched base commit 130f2ddf on this Mac, because my brew install of node@20 and node@22 changed which Node installs the script finds. Not caused by this diff; fixing them means editing tooling tests, which this goal forbids.
