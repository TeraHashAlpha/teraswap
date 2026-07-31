# Feedback — CHORE-DAILY-HEALTH-REPORT-GHA

## The workflow shape

`.github/workflows/daily-health-report.yml`: `schedule` (08:00 UTC daily — adjust freely) +
`workflow_dispatch`, `concurrency: { group: daily-health-report, cancel-in-progress: false }`,
`permissions: contents: write` only. Steps: date → site/API/SSL (curl + openssl, public) →
monitor (Bearer `MONITOR_SECRET`) → keeper gas (read-only `eth_getBalance` via
`HEALTH_RPC_URL_BASE`) → git activity (`git log origin/main --since`) → compose (Node, see below)
→ persist (temp detached worktree → `audits/cadence`, mirroring `commit-audit-report.mjs`).

**Design deviation, reasoned:** the goal said "commits + pushes as github-actions bot
(GitHub-signed — NO SSH key)" and implied a `main`-style flow. A plain Actions-runner `git commit`
is **not** cryptographically signed (no "Verified" badge) — pushed to `main` it would be rejected
by the same signed-commit branch protection that blocks the sandbox (CLAUDE.md rule #12), just
server-side. So this pushes straight to `audits/cadence` instead — the exact branch
`scripts/commit-audit-report.mjs` already uses for every other cadence report, which does not
enforce that rule. No PR, no new persistence pathway; this only automates the existing one. Full
reasoning in `docs/Prompts/CHORE-DAILY-HEALTH-REPORT-GHA.md` → "Design decision."

## Exact secrets to add (Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `MONITOR_SECRET` | Same value as the Vercel prod env var |
| `HEALTH_RPC_URL_BASE` | A Base mainnet JSON-RPC URL (read-only use) |
| `KEEPER_ADDRESS_BASE` | The Base keeper wallet address |

Full detail in `docs/Runbooks/DAILY-HEALTH-REPORT-GHA.md`. Any left unset → that check is
skipped and reported as such (⚠️ + a named "Requires Attention" bullet), never silently OK.

## No secret is ever logged

Verified by grep across the whole workflow: no `set -x`, no `echo`/`printf` of `$MONITOR_SECRET`,
`$RPC_URL`, or `$KEEPER_ADDRESS`. `curl -s` (silent — suppresses curl's own error text, which can
embed the request URL) is used for every authenticated/keyed call. All three secrets reach scripts
only via step-level `env:`, matching the safe pattern the repo's own workflow-injection guidance
calls for.

## The checks match the established convention

Same shape as `Audits/Daily/health-2026-07-24.md`: Site / API Health / SSL / Monitor / Keeper gas
/ Git Activity, ETH thresholds 0.01 (warning) / 0.002 (critical) copied from that report's own
convention (not from `freeze-score.js`'s USD thresholds, which are a different signal — flagged in
both the workflow comment and the runbook). One intentional gap: the DCA-execution row (needed a
raw `SUPABASE_SERVICE_ROLE_KEY`) is **dropped**, not degraded — the goal's secret list didn't
include it, and `/api/health`'s public branch already closes the "prod secret-set" half of what
that row was checking.

## Correctness bug found and fixed during implementation

My first draft computed the overall CRITICAL/WARNING/OK status as one bash line:
`[ A ] || [ B ] || [ C ] && [ D ]`. Bash's AND-OR list is a strict left-to-right short-circuit
**chain**, not `(A||B||C) && D` — traced through by hand: with `A=true` (site down) and `D=false`
(gas not critical), the chain still evaluates `D` last and reports OK, **silently swallowing a
site-down CRITICAL**. Rewrote the whole compose step in Node (already available; heredoc'd via a
quoted `<<'NODE_EOF'`, so no shell-expansion risk) with a plain severity-max accumulator instead.
Verified with 5 scripted scenarios including the exact bug case (site down + gas healthy → now
correctly 🔴 CRITICAL) — see the PR body for the transcript.

## Edge case found and fixed

A second pass over the same logic found that a WARNING/CRITICAL report could still print
"Requires Attention: Nothing outstanding" — the bullet list only covered NOSECRET, gas-below-warn,
and SSL-expiring, so a lone Monitor-401 or RPC-failure showed as ⚠️ in the table with **no**
corresponding actionable bullet. Every ⚠️/❌ row now has a matching bullet. Re-verified all 5
scenarios after the fix.

## Test gap

No CI job exercises this workflow's own logic (it's infra, not app code, so it's outside the
`vitest`-guard-job convention). I hand-verified it instead: full YAML parse, `bash -n` on all 7
`run:` blocks, live network calls against the real production site/API/SSL (200/200/valid cert,
confirming the checks work against the actual deployment), and 5 scripted end-to-end runs of the
compose step covering healthy / warning / critical / no-secrets / RPC-fail+SSL-unknown. Consider a
`workflow_dispatch`-triggered dry run as the first real-world check once secrets are added.
