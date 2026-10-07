# Feedback — chore/catalog-workflow-pr-token-and-ordering

Scope: `token-catalog-refresh.yml` + this file. Not dispatched — first real run Mon 06:00 UTC: check PR author = TeraHashAlpha, 33 checks.

- [x] C1 a1c39b5 · C2 89a6180 · C3 3b2de2d (all SSH-signed `G`) · actionlint clean · stub run · pushed

**1. Diff hunks (condensed)**
- C1: PR step `env:` `+CATALOG_PR_TOKEN: ${{ secrets.CATALOG_PR_TOKEN }}` (step-level only); `gh pr create` → `if [ -z "$CATALOG_PR_TOKEN" ]; then warn; create` / `elif ! GH_TOKEN="$CATALOG_PR_TOKEN" gh pr create …; then warn; create` (fallback = step's GITHUB_TOKEN). Header note rewritten.
- C2: old PR step split into `commit` (push + createCommitOnBranch, outputs `changed`/`branch`) → `pr` (only step with the PAT, outputs `url`) → `supersede` (jq `+select(.headRefName != "${BRANCH}")`, `+set -o pipefail`, comment cites new PR URL); alert moved last, `+COMMIT/PR/SUPERSEDE_OUTCOME` → FAILED_STEP; counts `+set -o pipefail` + `report-diff.ts … | tee "$REPORT_FILE"`.
- C3: `-    runs-on: ubuntu-latest` / `+    runs-on: ubuntu-24.04` (×2: `chains`, `refresh`).

**2. Step order (refresh job, after npm ci)**
- Before: build → gate → counts → **alert** → PR step (close superseded → push → commit → create)
- After: build → gate → counts → commit → pr → supersede (`if: steps.pr.outcome == 'success'`) → **alert** (`if: failure()`, last)

**3. Stub `gh` log** — steps extracted to `/private/tmp/…/scratchpad/runs/*/step-NN-*.sh`, `bash -e`, PyYAML `${{ }}`/`if:` eval
```
A| git push origin HEAD:refs/heads/…-42161-…-99999(new) ; gh api graphql --input <payload> [GITHUB_TOKEN]
A| gh pr create … --head …-99999(new) [GH_TOKEN=PAT]
A| gh pr list … --jq <prefix-and-not-new> [GITHUB_TOKEN]
A| gh pr close 590 … [GITHUB_TOKEN]            # #601 (new) and #591 (chain 8453) skipped
A| git push origin --delete …-42161-…-11111(old)
B| gh pr create … [GH_TOKEN=GITHUB_TOKEN]     # CATALOG_PR_TOKEN unset
B| run.log: ::warning::CATALOG_PR_TOKEN missing or expired — PR will not trigger CI; close/reopen it manually
C| gh pr create … [PAT] → HTTP 401 → same ::warning:: → gh pr create … [GITHUB_TOKEN] → close 590
D| gh pr create [PAT] ✗ → [GITHUB_TOKEN] ✗ → supersede SKIPPED (590 stays open)
D| gh issue create --title [token-catalog-guard] chain 42161 refresh failed [GITHUB_TOKEN]
D| run.log: ::error::token-catalog-refresh FAILED for chain 42161 at step pr (gh pr create)
leak: 0 matches of dummy PAT in all stub/run logs, scripts, outputs (positive control w/ echo: 1)
```

**4. actionlint 1.7.12** (`-shellcheck /opt/homebrew/bin/shellcheck`): `Found total 0 errors` (only pyflakes rule off: not installed).

**5. `git diff --stat origin/main...HEAD`**: workflow `241 +++---`, this file `+`; 2 files changed.

### Edge case
- Counts step: the YAML sent `report-diff.ts` stdout to `$GITHUB_OUTPUT` (→ PR body), not `$GITHUB_STEP_SUMMARY`; any step-summary write lives in `report-diff.ts` (outside the read allowlist, not verified). Fix = `tee` that stdout to the log; step summary untouched.
- Fallback warning fires on ANY PAT-path failure, not only 401 (scenario D). If the GITHUB_TOKEN retry also fails → step fails → alert; the old PR is never closed first.

### Concern
- Header L20-22 still says the branch commit is "unsigned" — stale since createCommitOnBranch (#540); untouched (scope).
