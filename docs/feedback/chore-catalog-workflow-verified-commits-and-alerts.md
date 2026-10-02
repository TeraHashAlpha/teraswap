# Feedback — chore/catalog-workflow-verified-commits-and-alerts

- [x] C0 no branch collisions (run-id suffix) + delete superseded bot branch
- [x] C1 verified commits via GraphQL `createCommitOnBranch` (no signing key)
- [x] C2 alert on ANY failure (`id: build`, `if: failure()`, names the failed step)
- [x] C3 explicit `Guard: PASS` line + counts in the PR body
- [x] Evidence 1-3 below; `git diff --stat` at bottom

## Evidence 1 — hunks (all in `.github/workflows/token-catalog-refresh.yml`, one step)
- Branch naming: `BRANCH=...-${TODAY}-${{ github.run_id }}` (:184); superseded-PR loop now reads
  `[.number, .headRefName]` and runs `git push origin --delete "$SUPERSEDED_BRANCH"` (:192-200).
- PR commit: `git config`/`checkout -b`/`commit`/`push` replaced by `git push origin
  "HEAD:refs/heads/${BRANCH}"` (branch ref only, no new commit) + `gh api graphql -f query=... -F
  input=@file` calling `createCommitOnBranch` with `fileChanges.additions` base64 content,
  `expectedHeadOid=$(git rev-parse HEAD)` (:202-231).
- Alert: `id: build` added to the rebuild step (:80); condition `failure() &&
  steps.gate.outcome=='failure'` → `failure()` (:117); body now names `$FAILED_STEP` from
  build/gate/diff outcomes (:124-151); `gate-output.log` reads guarded with `2>/dev/null || ...`
  since it may not exist when build fails first.
- Guard line: one line `Guard: PASS (...) — run ${RUN_URL} — ${COUNTS_LINE}` appended to the PR
  body, both vars from `env:` (:237-240).

## Evidence 2 — actionlint + dry GraphQL payload
`actionlint .github/workflows/token-catalog-refresh.yml` and full-repo `actionlint` → **exit 0**
(both). Two self-introduced issues caught and fixed before the final commit: a second literal
`${{ }}` (empty expression) in a comment broke GH's expression parser, and the new single-quoted
GraphQL mutation string needed `# shellcheck disable=SC2016` (intentional — `$input` is a GraphQL
variable, not shell).

Dry payload (`/tmp/catalog-dry-run`, fake 2-file change, same `jq` invocation copy-pasted from the
step): produced exactly `branch{repositoryNameWithOwner,branchName}`,
`message{headline}`, `fileChanges{additions[]{path,contents}}`, `expectedHeadOid` — base64
`contents` round-tripped (`base64 -d`) back to the original fake JSON for both files, byte-exact.

## Evidence 3 — `if:` matrix
| Scenario | build | gate | diff (`always()`) | alert (`failure()`) | PR step (`gate==success`) |
|---|---|---|---|---|---|
| build fails | failure | **skipped** | runs, succeeds (missing-file-safe) | **fires**, names "build" | skipped — no PR |
| gate fails | success | failure | runs, succeeds | **fires**, names "gate" | skipped — no PR |
| diff fails | success | success | failure | **fires**, names "diff" | **runs anyway** (pre-existing; see Concern) |
| all pass | success | success | success | skipped | runs — opens/updates PR with `Guard: PASS` line |

### Concern — diff-step failure doesn't block the PR step (pre-existing, not fixed here)
The PR step's only gate is `steps.gate.outcome == 'success'`; it has no dependency on `diff`.
If `report-diff.ts` itself throws, `DIFF_SUMMARY`/`GITHUB_OUTPUT` may be malformed (unterminated
heredoc) but the PR step still runs and reads `DIFF_SUMMARY`/`COUNTS_LINE` from the job-level
output. Out of scope here (goal is alert-on-build-failure + guard line, not this step's gating;
Do-NOT also excludes other logic changes) — flagging for a follow-up.

## `git diff --stat` (workflow + this file only, vs origin/main)
```
.github/workflows/token-catalog-refresh.yml        | 97 +++++++++++++++++-----
docs/feedback/chore-catalog-workflow-verified-commits-and-alerts.md |  8 ++
2 files changed, 85 insertions(+), 20 deletions(-)
```
