## Feedback — chore/drop-next-swc-platform-pins

### Proof results

- **Cold `npm ci` package counts:**
  - Before (with the 8 hand-pinned stale `@next/swc-*` entries): `added 1015 packages, and audited 1016 packages`, zero errors.
  - After (pins removed, lockfile regenerated): `added 1014 packages, and audited 1015 packages`, zero errors. Net -1 package — consistent with npm dedup-ing the duplicate hand-pinned copies against `next`'s own `optionalDependencies` copies.
- **`npm run build`**: passes clean (28 routes generated, no errors).
- **`npm ls @next/swc-linux-x64-gnu --all`**: prints `(empty)` on this macOS machine — npm skips installing optional deps whose declared `os`/`cpu` don't match the local platform, regardless of whether they're hand-pinned at the root or only declared under `next`'s own `optionalDependencies`. This is npm's standard platform-gating behavior, not a regression from this change. Confirmed instead via the lockfile directly: `node_modules/next/node_modules/@next/swc-linux-x64-gnu` is present at `16.2.11` (matching the installed `next` version) — the binary is still fully resolvable, just not physically installed on a non-Linux machine.
- **Root `packages[""]` block**: confirmed via script — `Object.keys(lock.packages[''].optionalDependencies || {})` filtered to `@next/swc-*` returns `[]`.
- **lint**: 0 errors, 94 pre-existing warnings (unrelated to this change, unchanged from before).
- **typecheck**: clean.

### Concern
- **Linux is unverified locally.** This machine is macOS (darwin-arm64); the build above only proves the darwin-arm64 SWC binary resolves and works. The pins removed were darwin-heavy and version-skewed (4 different versions across 8 platforms), which is exactly the kind of drift a Linux-only CI/Vercel build could react to differently than this local run. **This diff has NOT been verified on Linux** — that verification can only happen once CI runs on the pushed branch (owner-triggered PR) or on the Vercel preview build. If CI/Vercel fails on a missing or mismatched Linux SWC binary, that is new information this session could not have caught, and the STOP condition in the prompt would apply retroactively — flag it back to this branch rather than silently patching around it.
