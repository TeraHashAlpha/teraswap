# chore/pin-ubuntu-24-04-runners

Pin `ubuntu-latest` -> `ubuntu-24.04` ahead of the 2026-10-19 label migration (actions/runner-images#14748).

- [ ] Commit 1: mechanical pin (ci, codeql, daily-health-report, e2e, gitleaks, keeper-tests, monitoring-watchdog, security-audit)
- [ ] Commit 2: proof (grep, actionlint, diff --stat)
- [ ] Push branch, report compare link

## Notes
- Base: origin/main 8c11a2d already contains the catalog pin (PR #550 merged); `token-catalog-refresh.yml` untouched.
