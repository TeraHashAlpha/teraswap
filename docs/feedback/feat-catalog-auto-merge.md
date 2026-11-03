# Feedback — feat/catalog-auto-merge

- [x] C1 eligibility script + tests · [ ] C2 workflow wiring · [ ] C3 runbook · [ ] verify + push

## Premise deltas (owner answer supersedes; proceeded on the safe reading)
- **Branch protection requires 2 checks, not 33**: classic protection = `full-suite`, `keeper-suite` (strict/up-to-date, signed commits, 0 approvals); ruleset `main-protection` = no deletion/force-push + PR. 33 is what a PR *reports*. Auto-merge waits for those 2 only. Unverified: whether `full-suite` runs `catalog-address-guard` — owner to confirm or add it as required.
- **PR author is the owner's login** (`TeraHashAlpha`, PAT owner), not a bot → C7 uses PAT login (`gh api user`) + branch pattern with this run's id + single head commit by `github-actions[bot]` with the workflow headline.
- Row flag is `admission.rule = 'single-source-volume'` (not `single-source`); C5 tests for any `admission`.
- `strict` + 3 PRs/week: after the first merges, the others go BEHIND and auto-merge stalls until "Update branch" (GITHUB_TOKEN update-branch would not trigger CI). Not solved here — see runbook.
- "Allow auto-merge" is currently `false` on the repo → nothing auto-merges until the owner enables it.

## 1. Rules (C1–C9) and additions cap
C1 Guard=success · C2 only `token-catalog.<chain>.json` + trust fixture · C3 0 rows removed (catalog+trust) · C4 adds ≤ **10**, mainnet ≤ 1000 rows · C5 chain 1 has no `admission` row · C6 added rows: EIP-55, decimals int 0–36, symbol/name non-empty, verified, same-origin logo · C7 identity · C8* no symbol/decimals change on existing rows, trust edits only own chain · C9* PR opened with PAT (CI runs). *=stricter than brief.
Cap data (net adds, last 11 merged refresh PRs #548–#598): 2,2,4,4,4,5,9,9,10,23,51 → median 5, 9/11 ≤ 10; the two over are 23 (Base) and 51 (+1 removal, mainnet). Open: #644 +2, #645 +80, #646 +140 (single-source rule ON for L2s → those always go to review at cap 10).
