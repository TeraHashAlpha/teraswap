# Evidence appendix — feat/catalog-auto-merge (companion to feat-catalog-auto-merge.md)

## A. Branch protection: required vs reported (read-only: `gh api .../branches/main/protection`, `gh pr view 644 --json statusCheckRollup`)
Required by classic protection (strict/up-to-date, signed commits, 0 approvals, enforce_admins=false): `full-suite`, `keeper-suite`.
Ruleset `main-protection` (active): deletion + non_fast_forward + pull_request (0 approvals); no status-check rule.
Reported on PR #644 (33 entries, NOT required unless listed above; names may repeat across workflows):
```
1x Analyze (javascript-typescript)
1x CodeQL
1x Secret Scanning
1x Vercel
1x Vercel Preview Comments
1x api-hardening-guard
2x audit
1x build
1x catalog-address-guard
1x category-scroll
1x client-ip-trust-guard
1x dca-resilience-guard
1x dca-visibility-guard
1x deployed-sources-guard
1x fee-usd-guard
1x feed-resolution-guard
1x full-suite
1x keeper-suite
1x keeper-tests
1x lint
1x lockfile-lint
1x minimum-output-guard
1x oracle-advisory-guard
1x oracle-value-guard
1x quote-quorum-guard
1x quote-source-guard
1x signing-price-integrity-guard
1x source-health-guard
1x stablecoin-constant-guard
1x test-contracts
1x token-catalog-pipeline-guard
1x typecheck
```
Owner decision 2026-11-03: owner adds the guard checks as required (not done on this branch).

## B. Full workflow diff (`git diff origin/main...87a353d -- .github/workflows/token-catalog-refresh.yml`)
```diff
diff --git a/.github/workflows/token-catalog-refresh.yml b/.github/workflows/token-catalog-refresh.yml
index 72db44b..6df5ba0 100644
--- a/.github/workflows/token-catalog-refresh.yml
+++ b/.github/workflows/token-catalog-refresh.yml
@@ -32,6 +32,17 @@
 #    with a ::warning:: — the PR still opens but CI will NOT run on it; close/reopen it
 #    by hand. The fallback needs the repo setting "Allow GitHub Actions to create and
 #    approve pull requests".
+#
+# Auto-merge [feat/catalog-auto-merge] — owner's scoped exception to "owner merges every PR":
+#  - After the PR exists, scripts/token-catalog/auto-merge-eligibility.mjs checks nine
+#    conditions (guard PASS, data-files-only diff, 0 removals, <=10 additions + size bound,
+#    no single-source rows on mainnet, valid added rows, workflow identity, ...). ALL pass →
+#    `gh pr merge --auto --squash` (GitHub waits for the branch-protection required checks;
+#    nothing is bypassed). Otherwise → label `catalog-review` + a checklist comment.
+#  - Needs the repo setting Settings → General → "Allow auto-merge" (OFF today → the step
+#    degrades to the review path with an explanatory comment, never fails the run).
+#  - Pause: set repo variable CATALOG_AUTO_MERGE=off (Settings → Variables → Actions).
+#    Runbook: docs/Runbooks/CATALOG-AUTO-MERGE.md.
 
 name: "Token catalog refresh"
 
@@ -40,10 +51,10 @@ on:
     - cron: "0 6 * * 1" # Mondays 06:00 UTC
   workflow_dispatch: {}
 
+# Least privilege [feat/catalog-auto-merge]: read-only by default; the one job that pushes the
+# branch, opens/labels/merges PRs and files the failure alert (refresh) declares its own scopes.
 permissions:
-  contents: write
-  pull-requests: write
-  issues: write
+  contents: read
 
 concurrency:
   group: token-catalog-refresh
@@ -66,6 +77,10 @@ jobs:
 
   refresh:
     needs: chains
+    permissions:
+      contents: write # push the refresh branch, createCommitOnBranch, delete superseded branches
+      pull-requests: write # open/close PRs, label + comment, enable auto-merge
+      issues: write # failure-alert issue (gh issue create/comment)
     strategy:
       fail-fast: false # one chain's failure must never cancel the others' jobs
       matrix:
@@ -232,15 +247,30 @@ jobs:
           # back to GITHUB_TOKEN with a warning — the PR still opens, the token never fails the run.
           PR_ARGS=(--title "chore(catalog): scheduled token-catalog refresh — chain ${CHAIN}" --body-file "$BODY_FILE" --base main --head "$BRANCH")
           PR_TOKEN_WARNING="::warning::CATALOG_PR_TOKEN missing or expired — PR will not trigger CI; close/reopen it manually"
+          OPENED_WITH=pat
           if [ -z "$CATALOG_PR_TOKEN" ]; then
             echo "$PR_TOKEN_WARNING"
             PR_URL="$(gh pr create "${PR_ARGS[@]}")"
+            OPENED_WITH=fallback
           elif ! PR_URL="$(GH_TOKEN="$CATALOG_PR_TOKEN" gh pr create "${PR_ARGS[@]}")"; then
             echo "$PR_TOKEN_WARNING"
             PR_URL="$(gh pr create "${PR_ARGS[@]}")"
+            OPENED_WITH=fallback
           fi
           echo "chain ${CHAIN}: opened ${PR_URL}"
-          echo "url=${PR_URL}" >> "$GITHUB_OUTPUT"
+          # [feat/catalog-auto-merge] The workflow's PR identity = the PAT's owner (its PRs are NOT
+          # authored by a bot) and CI only starts on a PAT-opened PR. Login is public, never a secret.
+          PR_AUTHOR="github-actions[bot]"
+          CI_TRIGGERED=false
+          if [ "$OPENED_WITH" = pat ]; then
+            CI_TRIGGERED=true
+            PR_AUTHOR="$(GH_TOKEN="$CATALOG_PR_TOKEN" gh api user --jq .login 2>/dev/null || true)"
+          fi
+          {
+            echo "url=${PR_URL}"
+            echo "author=${PR_AUTHOR}"
+            echo "ci_triggered=${CI_TRIGGERED}"
+          } >> "$GITHUB_OUTPUT"
 
       - name: Close superseded refresh PRs for this chain (after the new PR exists)
         if: steps.pr.outcome == 'success'
@@ -268,6 +298,73 @@ jobs:
               git push origin --delete "$SUPERSEDED_BRANCH" || true
             done
 
+      # [feat/catalog-auto-merge] Runs only after the PR exists AND its superseded siblings are closed.
+      # Pause switch: repo variable CATALOG_AUTO_MERGE=off skips this whole step (PR stays plain).
+      - name: Auto-merge when eligible, else label for review (chain ${{ matrix.chain }})
+        if: steps.supersede.outcome == 'success' && vars.CATALOG_AUTO_MERGE != 'off'
+        id: automerge
+        env:
+          GH_TOKEN: ${{ github.token }} # NOT the PAT: the PAT is used for `gh pr create` only
+          REPO: ${{ github.repository }}
+          CHAIN: ${{ matrix.chain }}
+          BRANCH: ${{ steps.commit.outputs.branch }}
+          PR_URL: ${{ steps.pr.outputs.url }}
+          EXPECTED_AUTHOR: ${{ steps.pr.outputs.author }}
+          CI_TRIGGERED: ${{ steps.pr.outputs.ci_triggered }}
+          GUARD_OUTCOME: ${{ steps.gate.outcome }}
+          RUN_ID: ${{ github.run_id }}
+        run: |
+          MARKER='<!-- catalog-auto-merge -->'
+          PR_NUM="${PR_URL##*/}"
+          git fetch --no-tags --depth=2 origin "refs/heads/${BRANCH}"
+          HEAD_SHA="$(git rev-parse FETCH_HEAD)"
+          PR_AUTHOR="$(gh pr view "$PR_URL" --repo "$REPO" --json author --jq .author.login)"
+          RESULT_FILE=$(mktemp)
+          CHECKLIST_FILE=$(mktemp)
+          # Base = this job's checkout (the exact commit the refresh branch was created on).
+          if ! node scripts/token-catalog/auto-merge-eligibility.mjs \
+            --base "$(git rev-parse HEAD)" --head "$HEAD_SHA" --head-ref "$BRANCH" \
+            --guard "$GUARD_OUTCOME" --pr-author "$PR_AUTHOR" --expected-author "$EXPECTED_AUTHOR" \
+            --ci-triggered "$CI_TRIGGERED" --run-id "$RUN_ID" \
+            --checklist-file "$CHECKLIST_FILE" > "$RESULT_FILE"; then
+            echo "eligible=false" > "$RESULT_FILE"
+            echo '**Catalog auto-merge: NOT eligible** — the eligibility script crashed (fail-closed). See the run log.' > "$CHECKLIST_FILE"
+          fi
+          cat "$RESULT_FILE"
+          # First line only: reasons are sanitised in the script, but the verdict never depends on later lines.
+          ELIGIBLE=false
+          if [ "$(head -n1 "$RESULT_FILE")" = "eligible=true" ]; then ELIGIBLE=true; fi
+
+          if [ "$ELIGIBLE" = true ]; then
+            # --match-head-commit: only merge the exact commit that was just checked.
+            if MERGE_ERR="$(gh pr merge "$PR_URL" --repo "$REPO" --auto --squash --match-head-commit "$HEAD_SHA" 2>&1)"; then
+              echo "chain ${CHAIN}: auto-merge enabled on ${PR_URL} (squash, waits for required checks)"
+              printf '\nAuto-merge enabled (squash) — GitHub merges once every required check is green.\n' >> "$CHECKLIST_FILE"
+            else
+              ELIGIBLE=false
+              # gh's error text, first line only, reduced to a safe charset before it reaches a log command or a comment.
+              ERR_LINE="$(printf '%s' "${MERGE_ERR%%$'\n'*}" | tr -cd '[:alnum:] .,:;()/_-')"
+              echo "::warning::chain ${CHAIN}: eligible, but enabling auto-merge failed — is Settings → General → 'Allow auto-merge' on? (${ERR_LINE})"
+              # shellcheck disable=SC2016 # backticks are literal markdown in the comment, not a command substitution
+              printf '\n> Eligible, but GitHub refused to enable auto-merge: `%s`. Likely the repo setting "Allow auto-merge" is off — merge by hand.\n' "$ERR_LINE" >> "$CHECKLIST_FILE"
+            fi
+          fi
+          if [ "$ELIGIBLE" != true ]; then
+            echo "chain ${CHAIN}: NOT auto-merging ${PR_URL} — labelling catalog-review"
+            gh label create catalog-review --repo "$REPO" --color FBCA04 \
+              --description "Catalog refresh PR needs human review (auto-merge ineligible)" 2>/dev/null || true
+            gh pr edit "$PR_URL" --repo "$REPO" --add-label catalog-review
+          fi
+
+          # One checklist comment per PR, updated in place on re-runs (idempotent).
+          { echo "$MARKER"; cat "$CHECKLIST_FILE"; } > "${CHECKLIST_FILE}.body"
+          EXISTING="$(gh api "repos/${REPO}/issues/${PR_NUM}/comments" --paginate --jq ".[] | select(.body | startswith(\"${MARKER}\")) | .id" | sed -n '1p')"
+          if [ -n "$EXISTING" ]; then
+            gh api -X PATCH "repos/${REPO}/issues/comments/${EXISTING}" -F body=@"${CHECKLIST_FILE}.body" > /dev/null
+          else
+            gh api "repos/${REPO}/issues/${PR_NUM}/comments" -F body=@"${CHECKLIST_FILE}.body" > /dev/null
+          fi
+
       - name: Loud failure alert — never a silent skip (chain ${{ matrix.chain }})
         # [chore/catalog-workflow-verified-commits-and-alerts] was `failure() &&
         # steps.gate.outcome == 'failure'` — if the REBUILD step throws (the most likely
@@ -285,6 +382,7 @@ jobs:
           COMMIT_OUTCOME: ${{ steps.commit.outcome }}
           PR_OUTCOME: ${{ steps.pr.outcome }}
           SUPERSEDE_OUTCOME: ${{ steps.supersede.outcome }}
+          AUTOMERGE_OUTCOME: ${{ steps.automerge.outcome }}
         run: |
           # First offending line from the guard's own output — [fatal] rows name the guard
           # check + address directly; an AssertionError (e.g. the mainnet size guard) is the
@@ -305,6 +403,8 @@ jobs:
             FAILED_STEP="pr (gh pr create)"
           elif [ "$SUPERSEDE_OUTCOME" = "failure" ]; then
             FAILED_STEP="supersede (close superseded PRs)"
+          elif [ "$AUTOMERGE_OUTCOME" = "failure" ]; then
+            FAILED_STEP="automerge (eligibility + auto-merge/label)"
           fi
           TITLE="[token-catalog-guard] chain ${{ matrix.chain }} refresh failed"
           BODY_FILE=$(mktemp)
```

## C. Lint baseline (measured, same command on both trees: `npx eslint . --max-warnings 94`)
origin/main 7731d49: 93 problems (0 errors, 93 warnings) · this branch: 93 problems (0 errors, 93 warnings) → delta 0.
