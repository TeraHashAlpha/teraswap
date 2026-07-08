# TeraSwap — Architect Artifact Index

**Purpose:** single entry point to every architectural document in this workspace. Maintained by the Architect role. Last updated: 2026-07-08 (Sprint 9B in progress; post-9B `CHORE-*` stream APPROVED 0C/0H).

If you're looking for implementation code, see `src/`, `contracts/`, `scripts/`. If you're looking for *why* something is built the way it is, start here.

---

## 1. Decision records (ADRs)

Location: `docs/ADR/`

| # | Title | Status | Summary |
|---|---|---|---|
| [ADR-001](docs/ADR/ADR-001-monitoring-architecture.md) | Monitoring & Incident Response Architecture | Accepted (2026-04-14) | Four-component stack: H1 health check + H2 TLS/DNS watcher + H5 quorum + H6 Telegram bot + kill-switch. Rejects H3 (Twitter API) and H4 (anomaly detection). $0/mo runtime. |
| [ADR-002](docs/ADR/ADR-002-cloudflare-registrar.md) | Domain Registrar & DNS Hardening | Accepted (2026-04-14) | Migrate `teraswap.app` to Cloudflare Registrar + Registry Lock + DNSSEC + YubiKey. Rejects MarkMonitor ($3–5k/yr) at current scale. |
| [ADR-003](docs/ADR/ADR-003-cloudflare-worker-scheduler.md) | Cloudflare Worker as monitoring scheduler | Accepted (2026-04-15) | Use a Cloudflare Worker `* * * * *` to POST to Vercel `/api/monitor/tick`. Rejects Vercel Pro Cron ($20/mo) and Vercel Hobby Cron (daily-only). $0/mo. |
| [ADR-004](docs/ADR/ADR-004-upstash-kv-over-redis-cloud.md) | Upstash KV (via Vercel) over Redis Cloud | Accepted (2026-04-15) | Use Upstash for both rate-limiter and monitoring state — `@vercel/kv` is HTTP REST and incompatible with Redis Cloud's TCP. Closes incident 2026-04-14-002. |
| [ADR-005](docs/ADR/ADR-005-state-persistence-vercel-kv.md) | Source state persistence via Vercel KV with per-tick cache | Accepted (2026-04-15) | Replace in-memory `Map` with Vercel KV; add `beginTick()` per-request cache. Closes C-01 (incident 2026-04-15-002). |
| [ADR-006](docs/ADR/ADR-006-positive-slippage-sharing.md) | Positive Slippage Sharing on Non-CoW Routes | Proposed (2026-05-12) | Share positive slippage (mev_savings_actual) with users on non-CoW routes; depends on FeeCollector V2 + H-04 minimumOutput (P66–P68). |
| [ADR-007](docs/ADR/ADR-007-morpho-vault-curator.md) | TeraSwap as Morpho Vault Curator | Proposed (2026-05-18) | Phase 4 protocol play — curate Morpho vaults using surplus data from ADR-006. Depends on P68 deploy + multi-chain. |
| [ADR-008](docs/ADR/ADR-008-wagmi-v3-migration.md) | Wagmi v3 Migration | Proposed | Defer until RainbowKit v3 compat |
| [ADR-009](docs/ADR/ADR-009-multi-chain-architecture.md) | Multi-chain architecture | Accepted | Chain-aware reads/writes across mainnet + Base (routers, feeds, order signing, splitroute). |
| [ADR-010](docs/ADR/ADR-010-bebop-rfq-source.md) | Bebop RFQ source | Accepted | Add Bebop as an RFQ liquidity source alongside CoW/1inch/0x. |
| [ADR-011](docs/ADR/ADR-011-feecollector-augustus-whitelist.md) | FeeCollector Augustus whitelist | Accepted | Whitelist Velora Augustus V5/V6/V6.2 routers on-chain in FeeCollector V2. |
| [ADR-012](docs/ADR/ADR-012-avoid-transitive-copyleft-deps.md) | Avoid transitive copyleft deps | Accepted | Dependency policy: reject transitive copyleft (GPL-family) licenses in the supply chain. |
| [ADR-013](docs/ADR/ADR-013-order-onchain-floor.md) | Order on-chain floor | Accepted | On-chain minimum order-amount floor for conditional orders (SC-hardening). |

New ADRs go in `docs/ADR/` with filename `ADR-NNN-short-slug.md`. Update the table above.

---

## 2. Incident reports

Location: `Audits/Incidents/`

| ID | Date | Title | Severity | TeraSwap exposure |
|---|---|---|---|---|
| [INC-2026-04-14-001](Audits/Incidents/2026-04-14-cowswap-dns-hijack.md) | 2026-04-14 | CoW Swap DNS hijack (ecosystem-level) | Medium (ecosystem) | Zero |
| [INC-2026-04-14-002](Audits/Incidents/2026-04-14-002-ratelimit-misconfigured.md) | 2026-04-14 | Rate-limiter silently broken for 13 days | S3 | None detected (degraded only) |
| [INC-2026-04-15-001](Audits/Incidents/2026-04-15-001-vercel-cron-hobby-rejected.md) | 2026-04-15 | Vercel Hobby tier silently rejecting per-minute cron | S2 | Sprint 5A blocked ~24h, no user impact |
| [INC-2026-04-15-002](Audits/Incidents/2026-04-15-002-c01-inmemory-state.md) | 2026-04-15 | C-01: monitoring state lost between lambda invocations | S2 | None (caught by auditor before reaching prod) |
| [INC-2026-04-19-001](Audits/Incidents/2026-04-19-001-vercel-breach-env-exposure.md) | 2026-04-19 | Vercel platform breach — non-sensitive env vars exposed | **S1 (Critical)** | HIGH — non-sensitive env vars assumed compromised, site taken offline |
| [INC-2026-05-31-001](Audits/Incidents/INC-2026-05-31-001.md) | 2026-05-31 | `/api/quote` 502 on all chains after Sprint 9C/9D deploy | High | RESOLVED — fixed via PR #118 |
| [INC-2026-06-03-001](Audits/Incidents/INC-2026-06-03-001.md) | 2026-06-03 | WalletConnect prod outage (no wallet could connect) | High | Fixed (SPRINT-9K) |
| [INC-2026-06-09-001](Audits/Incidents/INC-2026-06-09-001.md) | 2026-06-09 | Connect-modal crash in prod (`qr@0.6.0` breaking change) | High | Mitigated by rollback, fixed via PR #156 |

Reactivation criteria for disabled sources live inside the incident report (§4.3 of INC-2026-04-14-001 for `cowswap`).
Rotation runbook for INC-2026-04-19-001: [`docs/Runbooks/vercel-breach-rotation.md`](docs/Runbooks/vercel-breach-rotation.md).

---

## 3. Execution plans and prompt packets

Sprint plans (root of workspace):

- [`SPRINT5A-PLAN.md`](SPRINT5A-PLAN.md) — Monitoring + contention (COMPLETE 2026-04-15, 9/9 prompts). Covers Prompts 25–29.
- [`SPRINT4-PROMPTS.md`](SPRINT4-PROMPTS.md) — Sprint 4 prompts; includes Prompt 21 (Permit2 UX).
- [`SPRINT4-AUDIT-BRIEF.md`](SPRINT4-AUDIT-BRIEF.md) — Sprint 4 audit brief.
- [`TERASWAP-EXECUTION-PLAN.md`](TERASWAP-EXECUTION-PLAN.md) — overall execution plan.
- [`ROADMAP.md`](ROADMAP.md) — product/security roadmap.

Extracted prompt packets (long-lived, not sprint-bound):

- [`docs/Prompts/UX-SECURITY.md`](docs/Prompts/UX-SECURITY.md) — Prompts 21–24: COMPLETE. Permit2 modal, BOLD token, CoinGecko categories, TokenAddressBadge.
- [`docs/Prompts/SPRINT-5A.md`](docs/Prompts/SPRINT-5A.md) — **Sprint 5A consolidated packet (Prompts 25 → 29)** — COMPLETE. All 9 prompts shipped with commit hashes and auditor verdicts. 0C/0H open.
- [`docs/Prompts/SPRINT-5B.md`](docs/Prompts/SPRINT-5B.md) — **Sprint 5B: H5 quorum cross-check (Prompts 30–31)** — COMPLETE. Auditor approved.
- [`docs/Prompts/SPRINT-5C.md`](docs/Prompts/SPRINT-5C.md) — **Sprint 5C: H6 interactive Telegram bot (Prompts 32–34)** — COMPLETE. Auditor approved.
- [`docs/Prompts/AUDIT-COMPREHENSIVE-POST-5C.md`](docs/Prompts/AUDIT-COMPREHENSIVE-POST-5C.md) — **Comprehensive audit prompt (post-5C)** — full codebase security & architecture review. 6 phases, 25 audit areas.
- [`docs/Prompts/SPRINT-6A.md`](docs/Prompts/SPRINT-6A.md) — **Sprint 6A: Smart contract pre-launch blockers (Prompts 36–38)** — COMPLETE. 4/4 SC findings closed.
- [`docs/Prompts/SPRINT-6B.md`](docs/Prompts/SPRINT-6B.md) — **Sprint 6B: API auth + monitoring hardening (Prompts 39–44)** — COMPLETE + APPROVED. 6/6 findings closed.
- [`docs/Prompts/SPRINT-6C.md`](docs/Prompts/SPRINT-6C.md) — **Sprint 6C: Medium priority fixes (Prompts 46–49)** — COMPLETE + APPROVED. 4/4 findings closed.
- [`docs/Prompts/SPRINT-6D.md`](docs/Prompts/SPRINT-6D.md) — **Sprint 6D: Hardening, dashboard & UX (Prompts 50–53)** — COMPLETE + APPROVED. FE-L-01 closed, status page live, transaction preview live.
- [`docs/Prompts/SPRINT-7.md`](docs/Prompts/SPRINT-7.md) — **Sprint 7: Forensic & post-execution security (Prompts 54–58)** — COMPLETE + APPROVED (2026-04-21). 0 findings, 4 INFO/NOTE.
- [`docs/Prompts/SPRINT-8.md`](docs/Prompts/SPRINT-8.md) — **Sprint 8: @vercel/kv → @upstash/redis migration (Prompts 59–62)** — COMPLETE + APPROVED (2026-04-22). 4/4 prompts shipped. 0 findings.
- [`docs/Prompts/SPRINT-9A.md`](docs/Prompts/SPRINT-9A.md) — **Sprint 9A: Quick-win security fixes (Prompts 63–65)** — COMPLETE (2026-04-23). 3/3 findings closed (H-01, H-02, H-03). Pending auditor review.

- [`docs/Prompts/SPRINT-9B.md`](docs/Prompts/SPRINT-9B.md) — **Sprint 9B: FeeCollector minimumOutput validation (Prompts 66–68)** — 2/3 done (P66 contract, P67 frontend shipped); P68 mainnet deploy pending. Closes H-04.
- Sprints 9C–9Z, `SPRINT-DCA-*`, `SPRINT-ORDER-*`, `SPRINT-RWA-GOLD.md`, `SPRINT-TOKEN-SELECTOR-UX.md` — see `docs/Prompts/` (all COMPLETE unless noted in-file).
- **Post-9B `CHORE-*` stream** (parallel to P68, not sprint-numbered — see `docs/Prompts/CHORE-*.md`): stablecoin canon
  (PR #278), fail-closed oracle >$10k gate (PR #280), quorum low-confidence fix (PR #272/#275), DCA visibility/stats
  (PR #281), DCA custom periods (PR #286), DefiLlama adapter, AZ security batch. Combined P2/keeper hardening audit —
  **APPROVED 0C/0H** (see `docs/security/`).

Individual historical prompts: **removed 2026-04-17** (18 files, superseded by consolidated packets above). Git history preserves audit trail.

---

## 3.5. Operational hygiene

- [`docs/OPS-HYGIENE-REVIEW.md`](docs/OPS-HYGIENE-REVIEW.md) — **Operational hygiene review (2026-04-16)** — 16 items across 7 categories. 5 P0, 6 P1, 4 P2, 1 P3. Covers: email separation, secret rotation, 2FA, Vercel scoping, branch protection, wallet separation, legal.

---

## 4. Manual execution runbooks

- [`FASE-A-CLOUDFLARE-DNS.md`](FASE-A-CLOUDFLARE-DNS.md) — step-by-step Cloudflare Registrar migration (TeraHash, scheduled 2026-04-15).
- [`FASE-A-MANUAL.md`](FASE-A-MANUAL.md) — broader Fase A manual hardening actions.
- [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) — operational runbooks (legacy single-file, see `docs/Runbooks/` for new ones).
- [`docs/Runbooks/KV-troubleshooting.md`](docs/Runbooks/KV-troubleshooting.md) — Vercel KV / Upstash diagnosis and repair.
- [`docs/Runbooks/worker-deployment.md`](docs/Runbooks/worker-deployment.md) — Cloudflare Worker deployment, secret rotation, route migration.
- [`docs/Runbooks/rate-limiter-verification.md`](docs/Runbooks/rate-limiter-verification.md) — verify rate-limiter end-to-end after infra changes (prevents recurrence of 2026-04-14-002).
- [`docs/guides/`](docs/guides/) — deploy guides, Supabase setup, E2E fork test.

---

## 5. External communications

- [`TeraSwap_CoWIncident_Response.md`](TeraSwap_CoWIncident_Response.md) — tweet thread + banner copy for the CoW incident (drafted, not yet posted).

---

## 6. Audits

Location: `Audits/` (delivered reports, DOCX) and `docs/audits/` (working markdown).

- `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx` — **Post-5C comprehensive audit (2026-04-15)** — APPROVED WITH WARNINGS. 2C/7H/6M/5L. Sprints 6A-6D planned.
- `Audits/TeraSwap-Security-Audit-Report-Consolidado.docx` — consolidated audit report (pre-5A)
- `Audits/TeraSwap-Sprint4-Audit-Report.docx` — Sprint 4 audit
- `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf` — **External technical analysis (2026-04-22)** — 20 pages, 4H/5M/4L. Covers architecture, security, operations, maturity. Sprint 9 planned.
- `Audits/TeraSwap-Analysis-Response-2026-04-23.docx` — **Response to external analysis (2026-04-23)** — Factual corrections, missing coverage, findings response, remediation plan. Sent to analyst for final document revision.
- `Audits/{Daily,Weekly,Monthly,Quarterly}/` — cadenced review folders
- `Audits/Incidents/` — incident reports (see §2)
- `docs/security/AUDIT-TOTAL.md`, `docs/security/PREAUDIT-REMEDIATION-REPORT.md`, `docs/security/SECURITY.md`
- `audit-reports/` — **removed 2026-04-17** (superseded by `Audits/Weekly/`). Git history preserves audit trail.
- `docs/archive/` — historical audit artifacts (external remediation, session log)

---

## 7. Memory (architect brain, cross-conversation)

Location: `/mnt/.auto-memory/` (outside this workspace, persists across Claude sessions)

- `MEMORY.md` — index
- `user_terahash.md` — user profile
- `project_teraswap.md` — project state snapshot (kept current)
- `feedback_architect_role.md` — role constraints (PT-PT, EN prompts, RICE)
- `feedback_no_direct_code_edits.md` — **never Edit/Write source files — always prompt the code agent**
- `reference_defi_hacks_cowswap_frontend.md` — CoW incident quick reference
- `reference_defi_hacks_hyperbridge.md` — Hyperbridge exploit reference

---

## 8. Conventions

- **Language:** PT-PT for user-facing architect output; EN for all agent prompts and code artifacts.
- **Prompts:** structured as Context / Objective / Requirements / Do NOT / Files affected / Expected output / Quality criteria.
- **ADR lifecycle:** Proposed → Accepted → Superseded (never deleted; supersession links between files).
- **Incident reports:** one file per incident, ID format `INC-YYYY-MM-DD-NNN`, never overwritten.
- **Prioritization:** RICE (Reach × Impact × Confidence / Effort).
- **No direct code edits by Architect.** Every code change is a prompt for the code agent with a commit hash paired in the plan.
