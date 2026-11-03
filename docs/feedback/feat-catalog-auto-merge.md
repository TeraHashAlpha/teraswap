# Feedback — feat/catalog-auto-merge (no PR)
- [x] script+tests  [x] workflow  [x] runbook  [x] verify+push

## Premise deltas (owner answer supersedes; proceeded on the safe reading)
- Protection requires 2 checks (`full-suite`, `keeper-suite`), not 33; ruleset adds none. ASKED → OWNER
  ANSWER (2026-11-03): "I will add guard checks as required" — owner does it; no code change here. Prereq
  before enabling "Allow auto-merge" (runbook).
- PR author is the PAT owner (not a bot): C7 = PAT login + branch/run-id + 1 commit by github-actions[bot].
- Flag is `admission.rule='single-source-volume'`. "Allow auto-merge" is OFF → nothing merges until enabled.
- Open: up-to-date rule stalls PRs 2–3 of a week; GITHUB_TOKEN merge may skip post-merge push workflows.

## 1. Rules (all required) — cap 10
C1 Guard=success | C2 only chain JSON + trust fixture | C3 0 rows removed | C4 adds<=10, chain 1<=1000 rows
C5 no `admission` on chain 1 | C6 added rows: EIP-55, decimals 0–36, symbol/name, verified, local logo
C7 branch+run-id+PAT author+1 bot commit | C8* no symbol/decimals change on old rows | C9* PAT-opened (CI runs)
Net adds, last 11 merged PRs (#548–#598): 2 2 4 4 4 5 9 9 10 23 51 → median 5, 9/11 <= 10. (*stricter)

## 2. Fixtures: 32/32 pass (all-pass, >=1 fail per C1–C9, hostile symbol, 4 CLI on temp git repo)
`npx vitest run scripts/token-catalog/auto-merge-eligibility.test.ts` → Tests 32 passed (32)

## 3. Workflow (actionlint clean) — `git diff origin/main...HEAD -- .github/workflows/token-catalog-refresh.yml`
-permissions: contents: write, pull-requests: write, issues: write      (workflow-wide, incl. `chains`)
+permissions: contents: read                                            (workflow default)
+refresh: permissions: contents: write (push, merge) · pull-requests: write · issues: write (alert)
+pr step:  records PAT login + ci_triggered (PAT path only) as step outputs
+new step: if steps.supersede.outcome=='success' && vars.CATALOG_AUTO_MERGE != 'off'
+          eligible → gh pr merge --auto --squash --match-head-commit <sha>   (GITHUB_TOKEN, not the PAT)
+          else → label catalog-review + marker comment (upsert, idempotent)
+alert step: + AUTOMERGE_OUTCOME mapping. Total +108/−4.

## 4. Dry run vs PR heads (read-only; author check tautological here)
#644 c1  +2/−0, 989 rows           → eligible=true
#645 c42161 +80                    → false: C4 80>10
#646 c8453 +140, −1 (CADC)         → false: C3 removal, C4 140>10

## 5. Verify
suite 400f/6346t vs origin/main 399f/6314t (+1/+32 mine) · tsc clean · eslint 93w/0e = origin/main 93w/0e (Δ0)
diff: 5 files +683/−4 · compare: github.com/TeraHashAlpha/teraswap/compare/main...feat/catalog-auto-merge
