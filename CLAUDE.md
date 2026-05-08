# TeraSwap

Ethereum Mainnet meta-aggregator — 11 liquidity sources, conditional orders (Limit/SL/TP/DCA), MEV protection via CoW Protocol, gasless approvals via Permit2. Smart contracts: TeraSwapFeeCollector + TeraSwapOrderExecutor v2 (Solidity 0.8.28, Foundry).

**State:** Phase 1 complete. Sprint 9B in progress (FeeCollector V2 minimumOutput — P68 mainnet deploy pending). 423 TS + 19 Foundry tests passing.

---

## Roles

- **Architect** (Cowork/Claude): design, specs, ADRs, prompts. NEVER edits source files. Output in PT-PT. Uses RICE for prioritisation.
- **Code Agent** (Claude Code): implements Architect prompts. Each change = 1 commit with hash referenced in sprint packet. Output in EN.
- **Auditor**: reviews each sprint. Classifies findings by severity (C/H/M/L). 0C/0H = approved. Produces prompts for Code Agent, never edits directly.

---

## Conventions

- **Language:** PT-PT for architect output, EN for all prompts/code.
- **Prompt format:** Context / Objective / Requirements / Do NOT / Files affected / Expected output / Quality criteria.
- **ADR lifecycle:** Proposed → Accepted → Superseded (never deleted). Location: `docs/ADR/ADR-NNN-slug.md`.
- **Incidents:** one file per incident, `INC-YYYY-MM-DD-NNN`, never overwritten. Location: `Audits/Incidents/`.
- **Prioritisation:** RICE (Reach × Impact × Confidence / Effort).
- **Sprint naming:** `docs/Prompts/SPRINT-{N}{A-Z}.md` — one file per sprint phase.
- **Commits:** each prompt = 1 atomic commit, hash recorded in sprint packet.
- **Marketing:** all marketing content goes to `dex-aggregator 2.marketing/`, NEVER in this repo.

---

## Memory Stores (Claude Platform)

When running as a Managed Agent, these stores are mounted automatically:

- `/mnt/memory/config` → **dex-config** (RO) — 11 sources, contracts deployed, rate limits, architecture
- `/mnt/memory/security` → **security-knowledge** (RW) — audit findings, incidents, ADRs, remediations, threat model
- `/mnt/memory/ops` → **ops-state** (RW) — health stack H1–H6, kill-switch, sprint progress, deploys
- `/mnt/memory/arch` → **architect-brain** (RW) — design decisions, roadmap, conventions, prompt templates
- `/mnt/memory/prefs` → **user-preferences** (RW) — shared cross-project, TeraHash profile and global rules

Consult security-knowledge **before** approving any change to contracts or fund flows. Update ops-state after each sprint close.

---

## Key references

- [`ARCHITECT-INDEX.md`](ARCHITECT-INDEX.md) — master index of all architectural artifacts
- [`docs/ADR/`](docs/ADR/) — architectural decision records (ADR-001 to ADR-005+)
- [`docs/Prompts/`](docs/Prompts/) — sprint packets (Prompts 21–68+)
- [`Audits/`](Audits/) — audit reports, external analysis, incident reports
- [`docs/Runbooks/`](docs/Runbooks/) — operational procedures (KV troubleshooting, Worker deploy, rate limiter, signed commits)
- [`docs/security/`](docs/security/) — SECURITY.md, AUDIT-TOTAL.md, PREAUDIT-REMEDIATION-REPORT.md
- [`ROADMAP.md`](ROADMAP.md) — product roadmap (Phase 1 ✅, Phase 2–4 planned)
- [`TERASWAP-EXECUTION-PLAN.md`](TERASWAP-EXECUTION-PLAN.md) — full execution plan with RICE table

---

## Stack

- **Frontend:** Next.js 16, React 18, TypeScript 5.5, Tailwind 3.4, Wagmi 2.19, Viem 2.47, RainbowKit 2.1, Zustand 4.5
- **Backend:** Next.js API Routes on Vercel (serverless), Upstash Redis (@upstash/redis) for rate limiting + state
- **Blockchain:** Solidity 0.8.28, Foundry, OrderExecutor v2 + FeeCollector on Ethereum Mainnet, Chainlink oracles (29 feeds)
- **Monitoring:** Cloudflare Worker cron → POST tick, GitHub Actions watchdog, Telegram alerts (@teraswap_monitor_bot), Sentry
- **Infra:** Vercel (deploy), Supabase (PostgreSQL + RLS + real-time), Cloudflare (DNS + Worker), GitHub Actions CI (6 jobs)

---

## Do NOT

1. **NEVER edit source files directly** (Architect/Auditor) — always produce a prompt for the Code Agent.
2. **NEVER approve changes to contracts or fund flows** without checking open audit findings in `docs/security/AUDIT-TOTAL.md`.
3. **NEVER deploy without audit pass** (0C/0H). Sprint must be APPROVED before merge.
4. **NEVER delete files** — git history preserves everything. Mark as superseded/deprecated instead.
5. **NEVER ignore open findings** — check `docs/security/AUDIT-TOTAL.md` and the latest sprint packet before starting work.
6. **NEVER create ADRs or incidents outside conventions** — use the naming, format, and location defined above.
7. **NEVER hardcode secrets or API keys** — all via env vars, no `NEXT_PUBLIC_` for server-only secrets.
8. **NEVER re-enable disabled sources** without fulfilling reactivation criteria in the incident report (e.g., §4.3 of INC-2026-04-14-001).
9. **NEVER trust single-source price data** — Chainlink validation is mandatory for all swaps. DefiLlama blocks swaps >$10k when unavailable.
10. **NEVER put marketing files in this repo** — use `dex-aggregator 2.marketing/` to avoid leaking strategy via git.
11. **NEVER push without CI green** — lint, typecheck, test, audit must pass. Admin bypass only for documented emergencies.
12. **NEVER commit without a GPG/SSH signature** — every commit on every branch must be cryptographically signed; `main` rejects unsigned commits at branch protection. Setup: `docs/Runbooks/SIGNED-COMMITS.md`.

---

## Current state (updated 2026-04-27)

- **Sprint 9B:** 2/3 done — P66 (contract) + P67 (frontend) shipped. P68 (mainnet deploy) pending.
- **Open findings:** 0C/0H from internal audits. External analysis: 4H closed, 5M/4L in backlog (Sprint 9C+).
- **Next milestones:** P68 deploy → Sprint 9A/9B auditor review → Sprint 9C (frontend integration tests, M-01).
- **Known tech debt:** SC-02 (DCA dust), FE-01 (localStorage → Web Crypto V2), npm audit (1H/13M).
