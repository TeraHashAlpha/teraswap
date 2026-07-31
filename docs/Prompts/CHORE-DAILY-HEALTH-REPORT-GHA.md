# CHORE-DAILY-HEALTH-REPORT-GHA

Move daily health-report generation + persistence off the sandbox (no SSH signing key → the
persistence commit fails every run) to a scheduled GitHub Action, and close the
"MONITOR_SECRET/SUPABASE_SERVICE_ROLE_KEY unset locally" check-gap by running the checks against
production.

- **Branch:** `chore/daily-health-report-gha` (off `origin/main`), SSH-signed
- **No Auditor gate** (CI/infra, not fund-flow) — Auditor note in the PR body.

---

## Context

The health-report generator ran as an owner-level sandboxed scheduled task. Its PERSIST step
(`node scripts/commit-audit-report.mjs`) failed every run: `fatal: either user.signingkey or
gpg.ssh.defaultKeyCommand needs to be configured` — that sandbox has no SSH signing key. ~20
reports were generated on disk and never committed (visible in the "Erro na persistência" section
of every recent `Audits/Daily/health-*.md`). The same sandbox also checked local env vars
(`MONITOR_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) that are simply unset there, producing a permanent
false "unreachable/unconfigured" warning unrelated to production's real state.

---

## Requirements

1. New scheduled Action `.github/workflows/daily-health-report.yml` (cron daily,
   `workflow_dispatch` too). Runs the health checks against **production** — site, `/api/health`,
   the protected `/api/monitor` endpoint (`MONITOR_SECRET`), the Base keeper's native balance via
   RPC against warning/critical thresholds, SSL. Writes
   `Audits/Daily/health-<YYYY-MM-DD>.md` in a clear, consistent structured format. Commits + pushes
   as `github-actions[bot]`. Concurrency guard against overlapping runs.
2. Exact repo secrets needed, documented in the PR body and a runbook:
   `MONITOR_SECRET`, `HEALTH_RPC_URL_BASE`, `KEEPER_ADDRESS_BASE`. Never echoed/logged.
3. Running against prod closes the local check-gap: `/api/health`'s public branch self-reports
   real prod status (200/503 reflecting whether Supabase env vars are set on Vercel), so there is
   no more "unset locally" false warning.
4. `scripts/commit-audit-report.mjs` stays for manual use (Weekly/Monthly/Quarterly, and ad hoc
   Daily runs) — doc comment only, noting the Action is now primary for Daily.

---

## Do NOT

- Touch product code, the keeper, or fund-flow.
- Hardcode any secret/RPC URL.
- Open a PR (owner-manual).

---

## Files affected

| File | Change |
|---|---|
| `.github/workflows/daily-health-report.yml` | **new** — scheduled health-report Action |
| `scripts/commit-audit-report.mjs` | doc comment only |
| `docs/Runbooks/DAILY-HEALTH-REPORT-GHA.md` | **new** — exact secrets + design notes |

---

## Design decision: where the report is persisted

The workflow pushes directly to the `audits/cadence` branch — the same target
`scripts/commit-audit-report.mjs` already uses — via a temp detached worktree, **not** to `main`
and **not** through a PR. `main` requires signed commits at branch protection (CLAUDE.md rule
#12); a plain `git commit` from an Actions runner is not cryptographically signed and would be
rejected the same way the sandbox was, just server-side instead of client-side.
`audits/cadence` does not enforce that — which is exactly why the pre-existing script already
targets it instead of `main`. This is a deviation from the literal "commits + pushes as
github-actions bot (GitHub-signed)" framing in the goal: a plain Actions-runner commit is not
itself cryptographically signed (no "Verified" badge); what actually makes this workable without
a local key is that `audits/cadence`, unlike `main`, does not require one.

---

## Auditor note

CI/infra chore, not fund-flow — no blocking gate. Two things worth a glance:

1. **Secrets scope.** `HEALTH_RPC_URL_BASE` is a read-only RPC URL used for exactly one
   `eth_getBalance` call — deliberately separate from any RPC credential the app or keeper use in
   production, so this workflow can never share a key with something that can sign or spend.
2. **Persistence target.** Reports land on `audits/cadence`, never `main`, never via PR — see
   "Design decision" above for why. This mirrors the existing `commit-audit-report.mjs` convention
   exactly, so it introduces no new persistence pathway, only automates the existing one.
