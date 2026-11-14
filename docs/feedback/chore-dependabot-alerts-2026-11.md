# chore/dependabot-alerts-2026-11 — FEEDBACK (no PR; owner opens it)
Base: origin/main 130f2ddf (PR #688). The goal text says "premise at 7e566fd"; that commit is an ancestor of origin/main, local `main` was 15 commits behind. Everything below was re-measured at 130f2ddf.
Long tables go to `chore-dependabot-alerts-2026-11.evidence.md` (companion file, same folder).

## Checklist
- [x] Commit 0: this file
- [x] Commit 1: fix what has a fix: hono override 4.13.11 -> 4.13.16 (nothing else has an eligible same-major fix)
- [ ] Commit 2: reachability of what stays open
- [ ] Commit 3: why Dependabot opened no PRs, proposal only
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`, `npm audit` before/after, wagmi/connector tests
- [ ] Push, compare link

## Premise differences found while reading (more below as they appear)
- Alerts confirmed by `gh api .../dependabot/alerts?state=open` (read-only): 12 open, numbers as in the goal. #147 is `archive/mobile-prototype-2026/.../Package.resolved` (swift, `github.com/ionic-team/capacitor-swift-pm`), not npm.
- The root `package.json` ALSO declares `@capacitor/*` at 8.5.3 (lines 35-41). So the archive is not the only Capacitor in the repo; `@capacitor/cli` is what pulls rimraf, glob, minimatch 10.2.5 and uuid 7.0.3 (via xcode).
- zod: only two copies are vulnerable (3.25.76 under @coinbase/cdp-sdk, 3.22.4 under @reown/appkit-wallet). abitype, porto and eslint-plugin-react-hooks already resolve to the patched 4.6.6.
- hono: the root `overrides` already pins `hono` to exactly 4.13.11 (`package.json:95`). The pin, not a missing update, is what keeps the alerts open.
