# chore/remove-capacitor — FEEDBACK (no PR; owner opens it)
Base: origin/main c23cec40 (the goal text says "premise at 7e566fd"; that commit is an ancestor, origin/main is 20 commits ahead; local `main` was behind). Everything below is re-measured at c23cec40.
Long tables go to `chore-remove-capacitor.evidence.md` (companion file, same folder).

## Checklist
- [x] Commit 0: this file
- [ ] Commit 1: `npm uninstall` the seven `@capacitor/*` packages, delete the three `cap:*` scripts
- [ ] Commit 2: "Removed from the root on 2026-11-16" section in the archive README; dated notes where docs tell someone to run a `cap:*` script
- [ ] Commit 3: dependabot.yml tidy (if any rule names Capacitor only); allowlist narrowing proposals (propose only)
- [ ] Verify: `scripts/agent-verify.sh --codeql`, `gen-claude-state.mjs --check`, `audit-gate.mjs`, `npm audit` before/after, build before/after
- [ ] Push `chore/remove-capacitor`, compare link

## Evidence 1: premise check (at c23cec40)
Confirmed:
- Root `package.json` declares exactly seven `@capacitor/*` packages, all in `dependencies`: android 8.5.3, browser 8.0.5, cli 8.5.3, core 8.5.3, ios 8.5.3, splash-screen 8.0.2, status-bar 8.0.4 (`package.json:35-41`), and three scripts `cap:init:android`, `cap:sync`, `cap:open:android` (`package.json:23-25`).
- `git ls-files | grep -v '^archive/' | xargs grep -l -i -E 'capacitor|cap:(init|sync|open)'` lists only: `.gitignore`, `package.json`, `package-lock.json`, and prose in `Audits/`, `docs/`, `TERASWAP-EXECUTION-PLAN.md`. Nothing under `src/`, `scripts/`, `e2e/`, `contracts/`, `.github/`, and no `*.config.*`, workflow or test file.
- No `android/`, `ios/` or `capacitor.config.*` at the root.
- `.gitignore:80-86` has the "Capacitor native builds" block (kept).

(More differences go below as they appear.)
