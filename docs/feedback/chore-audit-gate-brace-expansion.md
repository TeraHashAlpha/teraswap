## Feedback — chore/audit-gate-brace-expansion (be2cb7b)

### Findings
- **Advisory:** GHSA-mh99-v99m-4gvg, brace-expansion, HIGH, vulnerable range `<=5.0.7`.
- **Dependency paths** (`npm ls --all`), all dev/build-tooling — none in the shipped Next.js bundle:
  1. `@eslint/eslintrc` → `minimatch@3.1.5` → `brace-expansion@1.1.16`
  2. `eslint-config-next` → `typescript-eslint` → `@typescript-eslint/typescript-estree` →
     `minimatch@10.2.5` → `brace-expansion@5.0.7`
  3. `@capacitor/cli` → `rimraf` → `glob@13.0.6` → `minimatch@10.2.5` → `brace-expansion@5.0.7`
     (`@capacitor/cli` sits in `dependencies`, not `devDependencies` — but the only in-repo
     reference, `capacitor.config.ts`, is `import type`, erased at compile time; never bundled or
     executed in the Next.js server/client runtime)
- **Patched version:** 5.0.8 (only version above 5.0.7 in brace-expansion's release history —
  no backport exists in the 1.x/2.x/3.x/4.x lines). Published 2026-07-23.
- **Route taken: allowlist**, not override. Verified empirically, not assumed: bumping both
  existing overrides (`brace-expansion` 1.1.16→5.0.8, `minimatch@10.2.5.brace-expansion`
  5.0.7→5.0.8) and running `npm install --package-lock-only` fails `ETARGET — No matching version
  found for brace-expansion@5.0.8 with a date before 20/07/2026` — `.npmrc`'s
  `min-release-age=7` rejects it (published 4 days ago). Reverted `package.json` to its original
  state; only `audit-allowlist.json` changed.
- **Runtime-input claim verified, not asserted:** all three paths process glob patterns from
  repo-committed config files (`.eslintrc`, `tsconfig`, `capacitor.config.ts`) at lint/build/CLI
  time, never from an HTTP request body or other externally-supplied string — traced via `npm ls
  --all` + grep for any runtime import, not inferred from the package name.
- **Result:** `node scripts/audit-gate.mjs` → PASSED (1 allowlisted, 0 blocking). typecheck clean.
  lint: 0 errors (pre-existing warnings only, none new). Full suite: 3006/3006 tests, 218/218
  files green.
- **Ages in 2026-07-30.** TODO for whoever picks this up after that date: replace the allowlist
  entry with `"brace-expansion": "5.0.8"` + `"minimatch@10.2.5": { "brace-expansion": "5.0.8" }`
  overrides and delete the entry (same lifecycle the form-data/vite/undici entries followed).

### Note
- Local branch `chore/audit-gate-brace-expansion` pre-existed from an OLDER, already-merged PR
  (#318, a different advisory GHSA-3jxr-9vmj-r5cp) — its tip was a verified ancestor of `origin/main`,
  so the local ref was reset and the worktree branch recreated from latest `origin/main` before
  starting this fix. No unmerged work was discarded (`git merge-base --is-ancestor` confirmed before
  deleting).
