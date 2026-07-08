# TeraSwap

Ethereum Mainnet meta-aggregator — 11 liquidity sources, conditional orders (Limit/SL/TP/DCA), MEV protection via CoW Protocol, gasless approvals via Permit2. Smart contracts: TeraSwapFeeCollector + TeraSwapOrderExecutor v2 (Solidity 0.8.28, Foundry).

**State:** Phase 1 complete. Sprint 9B in progress (FeeCollector V2 minimumOutput — P68 mainnet deploy pending); parallel `CHORE-*` stream running post-9B (stablecoin canon, fail-closed oracle gate, DCA visibility/custom periods, DefiLlama adapter). 2587 TS + 74 Foundry tests passing. 8 CI workflows (`ci`, `codeql`, `e2e`, `gitleaks`, `keeper-tests`, `monitoring-watchdog`, `security-audit`, `token-catalog-refresh`).

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
- **Infra:** Vercel (deploy), Supabase (PostgreSQL + RLS + real-time), Cloudflare (DNS + Worker), GitHub Actions CI (8 jobs)

---

## Do NOT

1. **NEVER edit source files directly** (Architect/Auditor) — always produce a prompt for the Code Agent.
2. **NEVER approve changes to contracts or fund flows** without checking open audit findings in `docs/security/AUDIT-TOTAL.md`.
3. **NEVER deploy without audit pass** (0C/0H). Sprint must be APPROVED before merge.
4. **NEVER delete files** — git history preserves everything. Mark as superseded/deprecated **or** move to
   `archive/<original-path>/` (mirroring the file's original location, e.g. `docs/Prompts/FOO.md` →
   `archive/docs/Prompts/FOO.md`), preserving content and history. Use `archive/` when a file is fully retired
   (no longer referenced anywhere) but still worth preserving verbatim — e.g. a superseded FEEDBACK.md, a removed
   prompt packet, a dead runbook. Use superseded/deprecated marking in place when the file is still linked from
   the index or referenced by ID (ADRs, incidents). Either way, nothing is ever deleted.
5. **NEVER ignore open findings** — check `docs/security/AUDIT-TOTAL.md` and the latest sprint packet before starting work.
6. **NEVER create ADRs or incidents outside conventions** — use the naming, format, and location defined above.
7. **NEVER hardcode secrets or API keys** — all via env vars, no `NEXT_PUBLIC_` for server-only secrets.
8. **NEVER re-enable disabled sources** without fulfilling reactivation criteria in the incident report (e.g., §4.3 of INC-2026-04-14-001).
9. **NEVER trust single-source price data** — Chainlink validation is mandatory for all swaps. DefiLlama blocks swaps >$10k when unavailable.
10. **NEVER put marketing files in this repo** — use `dex-aggregator 2.marketing/` to avoid leaking strategy via git.
11. **NEVER push without CI green** — lint, typecheck, test, audit must pass. Admin bypass only for documented emergencies.
12. **NEVER commit without a GPG/SSH signature** — every commit on every branch must be cryptographically signed; `main` rejects unsigned commits at branch protection. Setup: `docs/Runbooks/SIGNED-COMMITS.md`.

---

## Code Agent Feedback Convention

**Per-PR, not shared.** The old shared append-only `FEEDBACK.md` conflicted on every parallel PR — GitHub's
squash/rebase merge does not honor the `merge=union` git attribute (tried in `CHORE-FEEDBACK-MERGE-UNION`),
so every PR touching it paid a rebase tax. Each PR now carries its **own** feedback instead: either a
`## Feedback` section in the PR body, or a per-PR file at `docs/feedback/<branch-name>.md`. Never append to
the old shared `FEEDBACK.md` (archived, see below) — a new PR never has a reason to touch it.

When implementing a prompt, if you encounter any of the following, document it in the PR's own feedback
(PR body section or `docs/feedback/<branch>.md`):

- **Edge case not covered by the prompt** — e.g. a function that also needs the fix but wasn't listed
- **Assumption that turned out wrong** — e.g. an import path that changed, a deprecated API
- **Security concern discovered during implementation** — e.g. an unvalidated input found while fixing a nearby one
- **Test gap** — e.g. a code path with zero test coverage that's related to the change
- **Performance concern** — e.g. a loop that's O(n²) on a growing dataset

Format:

```
## Feedback — P{number} ({commit hash})

### Edge case
- {description}

### Concern
- {description}
```

Within a single PR the file/section is append-only — each prompt in that PR adds its own section, never removes
previous entries. If no feedback applies to a prompt, do NOT create a feedback section/file (no empty sections).
The Architect reviews each PR's feedback at merge time and triages items into the backlog.

The legacy shared `FEEDBACK.md` is archived at `archive/FEEDBACK.md` (rule #4 escape valve) — its content is
preserved for historical reference; do not append to it or resurrect it at the repo root.

---

## Current state (updated 2026-07-08)

- **Sprint 9B:** 2/3 done — P66 (contract) + P67 (frontend) shipped. P68 (mainnet deploy) pending.
- **Parallel `CHORE-*` stream (post-9B, pre-P68):** stablecoin canon (PR #278), fail-closed oracle >$10k gate
  (PR #280), DCA visibility/stats (PR #281), DCA custom periods (PR #286), DefiLlama adapter — combined P2/keeper
  audit APPROVED 0C/0H.
- **Open findings:** 0C/0H from internal audits. External analysis: 4H closed, 5M/4L in backlog (Sprint 9C+).
- **Next milestones:** P68 deploy → Sprint 9A/9B auditor review → Sprint 9C (frontend integration tests, M-01).
- **Known tech debt:** SC-02 (DCA dust), FE-01 (localStorage → Web Crypto V2), npm audit (1H/13M).
- **Test/CI reality (2026-07-08):** 2587 TS tests + 74 Foundry tests passing. 8 CI workflows: `ci`, `codeql`, `e2e`,
  `gitleaks`, `keeper-tests`, `monitoring-watchdog`, `security-audit`, `token-catalog-refresh`.
