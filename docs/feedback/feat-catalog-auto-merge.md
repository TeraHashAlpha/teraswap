# Feedback — feat/catalog-auto-merge (3 commits, no PR; head = see compare link)

- [x] C1 eligibility script + tests · [x] C2 workflow wiring · [x] C3 runbook · [x] verify + push

## Premise deltas — owner answer supersedes; I proceeded on the safe reading
- **Protection requires 2 checks, not 33**: classic = `full-suite`, `keeper-suite` (+ up-to-date, signed commits, 0 approvals); ruleset `main-protection` adds none. 33 = what a PR *reports*. **Owner: confirm `full-suite` runs `catalog-address-guard`, or add it as required** (unverified; ci.yml out of read scope).
- **PR author = owner's login** (PAT), not a bot → C7 binds to PAT login + branch/run-id + 1 commit by `github-actions[bot]`. Row flag is `admission.rule='single-source-volume'` (C5 = any `admission`).
- "Allow auto-merge" is **off** today → nothing auto-merges until enabled (step then labels + comments, never fails the run).
- Up-to-date rule: PRs 2–3 of a week go BEHIND after #1 merges and stall until "Update branch". Auto-merge by `GITHUB_TOKEN` may not trigger post-merge `push` workflows — check the first one. Both unsolved; in runbook.

## 1. Rules + cap
C1 Guard=success · C2 only chain JSON + trust fixture · C3 0 rows removed · C4 adds ≤ **10**, chain 1 ≤ 1000 rows · C5 no `admission` on chain 1 · C6 added rows valid (EIP-55, decimals 0–36, symbol/name, verified, same-origin logo) · C7 identity · C8* existing rows keep symbol/decimals, trust edits only own chain · C9* PAT-opened (CI runs). *stricter than brief.
Net adds, last 11 merged PRs (#548–#598): 2,2,4,4,4,5,9,9,10,23,51 → median 5, 9/11 ≤ 10 (51 also had a removal; 2 of 11 changed a name/symbol casing → C8 would have reviewed them). Cap 10; L2 PRs with the single-source rule ON (+80/+140 now) always go to review.

## 2. Fixtures — `npx vitest run scripts/token-catalog/auto-merge-eligibility.test.ts`: **32/32 pass** (1 all-pass, ≥1 failing fixture per C1–C9, hostile-symbol injection, 4 CLI tests on a temp git repo). Stub-`gh` run of the workflow step on #644: eligible → `gh pr merge --auto --squash --match-head-commit`; forced refusal → label + comment.

## 3. Workflow (`actionlint` clean) — new step after supersede; skipped when repo var `CATALOG_AUTO_MERGE=off`; merge/label/comment use `github.token` (PAT stays create-only); comment upserted by marker (idempotent). Permissions: workflow default `contents: read` (was write/PR/issues for all jobs incl. `chains`); `refresh` job: `contents: write` (push + auto-merge), `pull-requests: write`, `issues: write` (alert) — nothing broader.

## 4. Dry run (read-only, vs PR heads; expected-author = actual author, so C7-author is tautological here)
#644 chain 1 (+2/−0, no admission, 989 rows): **eligible=true** · #645 chain 42161: **false** — C4 +80 > 10 · #646 chain 8453: **false** — C3 1 row removed (CADC) + 1 trust row; C4 +140 > 10.

## 5. Verify — suite 400 files / 6346 tests (origin/main: 399 / 6314; +1/+32 = mine) · tsc clean · eslint 93 warnings (baseline 93, 0 errors) · no change to guard/admission/size bounds/protection/other workflows · no deps/secrets · SSH-signed.
Stat: 5 files, +683/−4 (workflow +108, script 289, test 238, runbook 38).
