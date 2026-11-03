# Catalog refresh auto-merge

Scoped exception to "the owner merges every PR manually": the weekly `token-catalog-refresh` PRs (one per chain) may merge themselves via GitHub native auto-merge, **only** when every eligibility check passes. Everything else stays open for human review. Branch protection is unchanged and never bypassed.

## How it works
1. `.github/workflows/token-catalog-refresh.yml` builds the catalog, runs the Guard gate, pushes a branch (`chore/token-catalog-refresh-<chain>-<date>-<run_id>`, one verified commit by `github-actions[bot]`) and opens the PR with `CATALOG_PR_TOKEN` (so CI starts). The PR author is therefore the PAT owner's login, not a bot.
2. Step "Auto-merge when eligible…" runs `scripts/token-catalog/auto-merge-eligibility.mjs` (any error ⇒ not eligible):

| # | Check | Fails when |
|---|---|---|
| C1 | Guard PASS | the refresh job's gate step outcome ≠ success |
| C2 | Data files only | the diff touches anything but `token-catalog.<chain>.json` + `catalog-guard.trust.json` (code, workflow, config, package files) |
| C3 | Removals = 0 | any catalog row or trust row disappears |
| C4 | Additions ≤ 10, size bound | > 10 new rows, or chain 1 > 1000 rows (bound itself lives in `src/lib/chains/token-catalog.test.ts`) |
| C5 | No single-source on mainnet | any chain-1 row carries `admission` (rule is OFF for chain 1 in `config.ts`) |
| C6 | Added rows valid | non-EIP-55 address, decimals ∉ 0..36, empty symbol/name, `verified` ≠ true, non-same-origin logo, duplicate address |
| C7 | Workflow identity | branch pattern/run id, PR author ≠ PAT owner, ≠ 1 commit, commit not directly on base, author ≠ `github-actions[bot]`, wrong headline |
| C8 | Existing rows keep identity | an existing row changes symbol/decimals; trust-fixture edits outside this chain |
| C9 | CI will run | PR was opened with the `GITHUB_TOKEN` fallback (CI never starts → auto-merge would wait forever) |

   C8/C9 are stricter than the owner's seven. Cap 10 = 9 of the last 11 merged refresh PRs; with the single-source rule ON, Base/Arbitrum PRs routinely exceed it and are always reviewed.
3. Eligible ⇒ `gh pr merge --auto --squash --match-head-commit <sha>` with the job's `GITHUB_TOKEN`; GitHub then merges when the **required** checks pass. Not eligible ⇒ label `catalog-review` + one checklist comment (updated in place on re-runs). If GitHub refuses auto-merge the PR also takes the review path.

## Enable (owner, once)
Settings → General → Pull Requests → tick **Allow auto-merge** (currently off, so nothing auto-merges until then). Required today by branch protection on `main`: `full-suite`, `keeper-suite` (up-to-date branch, signed commits); the ruleset adds no extra checks. The other ~31 checks a PR reports are not required — confirm `full-suite` covers `catalog-address-guard`, or add it as required.

## Pause
Settings → Secrets and variables → Actions → Variables → `CATALOG_AUTO_MERGE` = `off` (any other value or unset = active). Takes effect on the next run; the step is skipped and PRs stay plain. To cancel an already-armed PR: `gh pr merge <n> --disable-auto`.

## Reviewing a `catalog-review` PR
1. Read the checklist comment: unchecked rows name what failed and why.
2. Diff semantically, not by line (volume fields churn on ~every row): `git diff` of the JSON is noise; compare added/removed rows (the PR body's Counts block lists the first 20).
3. Removed rows: confirm the token genuinely left the trusted lists (not a source outage; the build already fails closed on outage). Added rows ≥ cap on an L2: spot-check the single-source `admission` volumes and the on-chain symbol/decimals.
4. Merge by hand (squash, GitHub UI) once CI is green, or close it — the next weekly run supersedes it.

## Known limits
- Branch protection has "require up-to-date": after the first of the three weekly PRs merges, the others go BEHIND and stall until someone clicks **Update branch** (a `GITHUB_TOKEN` update would not start CI).
- A merge performed by auto-merge armed with `GITHUB_TOKEN` may not trigger `push`-to-`main` workflows; check post-merge deploy/CI runs on the first auto-merge.
