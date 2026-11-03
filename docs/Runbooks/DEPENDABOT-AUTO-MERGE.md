# Dependabot auto-merge

Scoped exception to "the owner merges every PR manually": a Dependabot PR may merge itself via GitHub native auto-merge **only** when every rule below holds; otherwise it gets the `deps-review` label and a one-line comment saying why. Branch protection is unchanged and never bypassed — auto-merge waits for every required check (`full-suite`, `keeper-suite`, signed squash by GitHub). Sibling of [`CATALOG-AUTO-MERGE.md`](CATALOG-AUTO-MERGE.md).

## What auto-merges
| Rule | Auto only if |
|---|---|
| R1 identity | PR author **and every commit** is `dependabot[bot]`; `dependabot/fetch-metadata` (SHA-pinned) verified it and found ≥ 1 dependency |
| R2 semver | every package is a **patch or minor** bump |
| R3 scope | ecosystem `npm` or `github-actions`, **root project only**; the PR touches only `package.json` + `package-lock.json` (npm) or `.github/{workflows,actions}/*.y(a)ml` (actions) |
| R4 packages | not deny-listed, and for npm only **`devDependencies`** (see below) |
| R5 groups | a grouped PR qualifies only if **every** package in it does |
| R6 switch | repo variable `DEPS_AUTO_MERGE` is exactly `on` (default: unset = off) |

In practice today: the weekly `dev-dependencies` group (when all minor/patch and none deny-listed) and the weekly `actions` group (when none is a major).

## What never auto-merges (→ `deps-review`)
- Any **major** bump (also blocked upstream by `.github/dependabot.yml` `ignore`, kept as defence in depth).
- Anything under `contracts/**` (keeper lockfile, `contracts/order-engine`) or any non-root directory.
- Deny-list: `viem`, `wagmi`, `@wagmi/*`, `@rainbow-me/*`, `next`, `react`, `react-dom`, `ethers`, `@tanstack/react-query`, `@walletconnect/*`, `@supabase/*`, `@aws-sdk/*`, `zod`. Defined in `scripts/dependabot/auto-merge-eligibility.mjs` (`DENY_EXACT` / `DENY_SCOPES`); changing it is a code change with a test.
- **Every runtime `dependencies` bump and every transitive (indirect) bump.** The owner's rule asks to review runtime packages whose lockfile entry is used by `src/app/api/**`. That is not reliably computable in a `pull_request_target` job that must not check out PR code (it needs the PR's resolved dependency graph vs. the route import graph), so the owner's stated fallback applies: only `devDependencies` + github-actions auto-merge. Revisit if/when a base-only, lockfile-diff-only check is written.
- Human-pushed commits on a Dependabot branch, PRs whose metadata cannot be verified, anything the script cannot parse (fail-closed).

## How it works
`.github/workflows/dependabot-auto-merge.yml` (`pull_request_target`; opened / reopened / synchronize on `main`):
1. `gate` job (read-only token): sparse checkout of the **base** commit's `scripts/dependabot/` only (never the PR head, no `npm ci`), `fetch-metadata`, PR files + commit authors via the API, then `auto-merge-eligibility.mjs` prints `eligible=` / `reason=`.
2. `act` job (the only one with `contents: write` + `pull-requests: write`; no checkout, no third-party actions): eligible → `gh pr merge --auto --squash --match-head-commit <sha>`; else (or if GitHub refuses) → label `deps-review` + one marker comment, updated in place. A PR that stops qualifying after being armed has auto-merge disabled.
Re-runs (`@dependabot rebase`, new pushes) are idempotent.

## Enable (owner, once)
1. Settings → General → Pull Requests → tick **Allow auto-merge** (without it eligible PRs fall to the review path with an explanatory comment).
2. Settings → Secrets and variables → Actions → Variables → new `DEPS_AUTO_MERGE` = `on`.
3. Prerequisite shared with the catalog flow: the guard checks are required in branch protection (see `CATALOG-AUTO-MERGE.md` → Enable), otherwise auto-merge waits for only `full-suite` + `keeper-suite`.

## Switch off
Set `DEPS_AUTO_MERGE` to `off` (or delete it). Effective on the next event: the workflow does nothing — no labels, no comments, no arming. **Already-armed PRs stay armed**: cancel with `gh pr merge <n> --disable-auto` (or the PR page → "Disable auto-merge"). Emergency stop for everything: `gh variable set DEPS_AUTO_MERGE --body off` then list armed PRs with `gh pr list --author app/dependabot --json number,autoMergeRequest`.

## Reviewing a `deps-review` PR
1. The comment names the failing rule(s) (`R2: not patch/minor: …`, `R4: deny-listed: …`).
2. Read the release notes / lockfile diff; run the usual checks; merge by hand (squash, GitHub UI) or close.
3. To let a deny-listed or runtime package auto-merge, change the code and tests — do not bypass the label.

## Known limits
- "Require up-to-date" in branch protection: after one Dependabot PR merges the others go BEHIND and wait until `@dependabot rebase` (a rebase by Dependabot re-triggers this workflow and CI).
- A merge armed with `GITHUB_TOKEN` may not trigger `push`-to-`main` workflows; check post-merge deploy/CI on the first auto-merge (same caveat as the catalog flow).
- Semver-minor on `0.x` packages can be breaking; R2 follows the owner's rule (patch/minor) and does not special-case `0.x`. Required checks are the backstop.
- The workflow file itself is only loaded from the default branch: it takes effect after merge to `main`.
