# Daily Health Report — GitHub Action

`.github/workflows/daily-health-report.yml` runs on a schedule (default: 08:00 UTC daily —
adjust the cron to taste), checks production directly, and writes
`Audits/Daily/health-<YYYY-MM-DD>.md`.

## Why this exists

The previous generator ran as an owner-level sandboxed scheduled task. Its PERSIST step
(`node scripts/commit-audit-report.mjs`) failed every run because that sandbox has no SSH signing
key configured — see the "Erro na persistência" section of any `Audits/Daily/health-*.md` from
before this workflow shipped. ~20 reports were generated on disk and never committed. It also
checked **local** env vars (`MONITOR_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`), which are simply unset
in that sandbox — producing a permanent false warning even when production is fine.

This Action fixes both: it runs on GitHub's own infrastructure (see the workflow's PERSIST-step
comment for exactly how it avoids needing a local signing key), and it checks **production**
directly via the live site and the public `/api/health` self-report, so a real misconfiguration
shows up as a real finding — not as this workflow's own environment.

## Required repo secrets

Settings → Secrets and variables → Actions → New repository secret. Exact names:

| Secret | Value | Used for |
|---|---|---|
| `MONITOR_SECRET` | Same value as the `MONITOR_SECRET` Vercel production env var | `Authorization: Bearer` header on `GET /api/monitor` |
| `HEALTH_RPC_URL_BASE` | A Base mainnet JSON-RPC URL | One read-only `eth_getBalance` call (no key, no signing, nothing sent on-chain) |
| `KEEPER_ADDRESS_BASE` | The Base keeper wallet's address | Which balance to read |

Deliberately a **separate** RPC secret from anything the app or keeper use in production — this
workflow only ever reads a balance and should never share a credential with something that can
sign or spend. `KEEPER_ADDRESS_BASE` is a public on-chain address, not sensitive; it is kept as a
secret alongside the other two for one-place ops config rather than split into a repo variable.

Any secret left unset is **not a failure** — the corresponding check is skipped and reported as
such (⚠️, with a "Requires Attention" bullet naming which secret to add), never silently treated
as healthy.

## What it checks

Same shape as the pre-existing Daily report convention: Site, API Health (which doubles as the
prod secret-set status — 200 means `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` ARE set on Vercel,
503 means they are not), SSL certificate expiry, the protected Monitor endpoint, keeper gas on
Base against a 0.01 ETH warning / 0.002 ETH critical threshold (the convention already used in
recent reports — not derived from `freeze-score.js`'s USD-denominated thresholds, which drive a
different signal for a different consumer), and `origin/main` git activity in the last 24h.

## Where reports land

Pushed directly to the `audits/cadence` branch — the same target `scripts/commit-audit-report.mjs`
already uses for every other cadence report — via a temp detached worktree, never to `main` and
never through a PR. `main` requires signed commits at branch protection (CLAUDE.md rule #12); a
plain commit from an Actions runner is not cryptographically signed and would be rejected the same
way the sandbox was, just server-side instead of client-side. `audits/cadence` does not enforce
that, which is exactly why the existing script already targets it instead of `main`.

## Manual / ad hoc runs

`workflow_dispatch` is enabled — run it on demand from the Actions tab. `scripts/commit-audit-report.mjs`
remains available too, for a locally-generated report or for the Weekly/Monthly/Quarterly cadences
this chore did not move.
