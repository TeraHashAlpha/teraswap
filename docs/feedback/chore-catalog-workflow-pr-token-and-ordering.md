# Feedback — chore/catalog-workflow-pr-token-and-ordering

Scope: `.github/workflows/token-catalog-refresh.yml` + this file only. Not dispatched (first real run = Mon 06:00 UTC).

- [x] C1 (a1c39b5) — `gh pr create` via `CATALOG_PR_TOKEN` (step-level env), GITHUB_TOKEN fallback + `::warning::`
- [x] C2 (89a6180) — order: build → gate → counts → push+verified commit → PR → close superseded; alert LAST, `if: failure()`; counts → stdout
- [ ] C3 — `ubuntu-latest` → `ubuntu-24.04` (this workflow only)
- [ ] actionlint (shellcheck on) clean
- [ ] stub-`gh` run: order, fallback warning, no token leak
- [ ] pushed + compare link

### Edge case
- Counts step: the YAML sends `report-diff.ts` stdout to `$GITHUB_OUTPUT` (→ PR body), not `$GITHUB_STEP_SUMMARY`; the step-summary write the brief cites is not in the YAML (presumably inside `report-diff.ts`, outside this goal's read allowlist — not verified). Fix = `tee` the same stdout into the log; the step summary is left untouched.
