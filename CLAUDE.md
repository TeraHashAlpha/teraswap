# TeraSwap

Multi-chain meta-aggregator on Ethereum Mainnet (1), Base (8453) and Arbitrum One (42161) — contracts per chain in `docs/DEPLOYMENTS.md`, the only source for addresses. All pricing, gating, RPC and router logic MUST be chain-aware. 12 adapters are registered (`src/lib/adapters/index.ts:15-19`); 4 are in `DISABLED_SOURCES` (`src/lib/constants.ts:202-232`: Balancer — dead SOR endpoint; Odos — vendor shutdown 2026-07-30, permanent; OpenOcean and Bebop — no vendor key, INC-2026-09-03-001), leaving 8 liquidity sources live. Each disabled entry carries its own written re-enable criterion. Also: conditional orders through OrderExecutor (UI v2 shows Limit and SL/TP as "Soon" — `src/ui/v2/__tests__/parity-sweep.test.tsx:12-13`), CoW Protocol as an ordinary source (the "Force MEV Protection" toggle is retired — `src/ui/v2/swap/retire-force-mev.swap.test.tsx:3-7`), Permit2 approvals (`src/ui/v2/modals/permit2-sheet.test.tsx`). Contracts: TeraSwapFeeCollector + TeraSwapOrderExecutor (Solidity 0.8.28, Foundry — `contracts/foundry.toml:6`, `contracts/order-engine/foundry.toml:5`).

**State:** see "Current state" at the bottom — every number there was measured on the date it names.

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
- **Bash compatibility:** every `.sh` in this repo must run on macOS stock bash 3.2.57 — no `${var,,}` / `${var^^}`, no `declare -A`, no `mapfile` / `readarray`, no `globstar`. Lowercase via `tr '[:upper:]' '[:lower:]'`.
- **Grok Build launch:** in this repo Grok is launched ONLY via `scripts/grok-dispatch.sh` or from a shell that sourced `scripts/grok-guard.sh`. A bare `grok` here has no credential guard. Their `--deny` flags (`Read(.env*)`, `Bash(security*)`, `Bash(git credential-*)`) do NOT protect `.env*` — measured (`docs/security/GROK-DENY-CANARY-2026-08-28.md`): Grok routes around a denied read by choosing a different command, because a `Bash(...)` deny rule matches the invoked command name, not its arguments, so `Bash(*.env*)` cannot match `cat .env.canary`. Only `--deny "Bash(*)"` actually refuses, and that blocks the whole shell — unusable for real work, so there is no usable middle. Treat those three flags as speed bumps and intent signals only, never as enforcement. What actually holds: (a) `--deny "Bash(*)"`, when acceptable to run unusable-for-real-work; (b) running in a git worktree that does not contain `.env*` at all — `scripts/grok-dispatch.sh` creates its worktree outside this repo (`${TS_WORKTREE_BASE:-$HOME/ts-worktrees}`, never under `.claude/worktrees/`, which is still inside the repo and reachable via `../../../`).
- **Marketing:** all marketing content goes to `dex-aggregator 2.marketing/`, NEVER in this repo.
- **Git references:** outside sprint packets, cite a change by its PR number (`PR #675`) and nothing else — branch names get recreated and commit hashes change under squash/rebase.
- **PRs:** the owner opens and merges every PR; an agent never opens, merges, approves or closes one. A PR that needs an Auditor pass is opened as Draft — say "Auditor required" in the report.
- **Branches:** never force-push a branch that has an open PR (it rewrites history under review); any other force-push needs the owner's explicit word (rule 15).
- **Alerts:** never dismiss, close or suppress a security alert (CodeQL, Dependabot, gitleaks). Fix it, or report it to the owner with the evidence.
- **CI:** NO CI polling — no `gh run watch`, no sleep-and-check loops. Push, report the compare link, stop; the owner reads CI.
- **Secrets:** never print, echo or log a secret value. Check an env var by NAME (`[ -n "${NAME:-}" ]`) and report set/unset.
- **Owner-terminal only:** `ssh` to any host, `pm2`, and `cast send` (any on-chain write) run only in the owner's terminal. The agent prepares the exact command and stops.

---

## Memory Stores (Claude Platform)

When running as a Managed Agent, these stores are mounted automatically:

- `/mnt/memory/config` → **dex-config** (RO) — sources, contracts deployed, rate limits, architecture
- `/mnt/memory/security` → **security-knowledge** (RW) — audit findings, incidents, ADRs, remediations, threat model
- `/mnt/memory/ops` → **ops-state** (RW) — health stack H1–H6, kill-switch, sprint progress, deploys
- `/mnt/memory/arch` → **architect-brain** (RW) — design decisions, roadmap, conventions, prompt templates
- `/mnt/memory/prefs` → **user-preferences** (RW) — shared cross-project, TeraHash profile and global rules

Consult security-knowledge **before** approving any change to contracts or fund flows. Update ops-state after each sprint close.

---

## Key references

- [`ARCHITECT-INDEX.md`](ARCHITECT-INDEX.md) — master index of all architectural artifacts
- [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md) — contracts, wallets and keeper signers per chain (source of truth for addresses)
- [`docs/ADR/`](docs/ADR/) — architectural decision records, ADR-001 to ADR-026 (status is in each file's header)
- [`docs/Prompts/`](docs/Prompts/) — sprint packets (`SPRINT-*.md`, highest numbered: `SPRINT-48-ARBITRUM-DCA-PREP.md`) and prompt packets
- [`docs/feedback/`](docs/feedback/) — one feedback file per branch (see the convention below)
- [`Audits/`](Audits/) — audit reports, external analysis, incident reports (`Audits/Incidents/`)
- [`docs/Runbooks/`](docs/Runbooks/) — operational procedures (executor operations, deploys, KV troubleshooting, monitoring alerts, signed commits, ...)
- [`docs/security/`](docs/security/) — SECURITY.md, AUDIT-TOTAL.md, PREAUDIT-REMEDIATION-REPORT.md
- [`ROADMAP.md`](ROADMAP.md) — product roadmap
- [`TERASWAP-EXECUTION-PLAN.md`](TERASWAP-EXECUTION-PLAN.md) — full execution plan with RICE table
- Scoped agent context, read when you work in that tree: [`src/ui/v2/CLAUDE.md`](src/ui/v2/CLAUDE.md), [`src/app/api/CLAUDE.md`](src/app/api/CLAUDE.md), [`contracts/order-engine/CLAUDE.md`](contracts/order-engine/CLAUDE.md)
---

## Stack

Versions from `package.json:42-76` (exact pins).

- **Frontend:** Next.js 16.4.3 (App Router), React 18.3.1, TypeScript ~5.9.3, Tailwind 3.4.19, wagmi 2.19.5, viem 2.57.3, RainbowKit 2.2.10, Zustand 4.5.7, TanStack Query 5.104.5; tests on vitest 4.1.12
- **Backend:** Next.js API routes on Vercel (45 `route.ts` under `src/app/api`), Upstash Redis (`@upstash/redis` 1.39.0) for rate limiting + state, Supabase (`@supabase/supabase-js` 2.118.0; schema in `supabase/`)
- **Blockchain:** Solidity 0.8.28 / Foundry (`contracts/`, `contracts/order-engine/`); Chainlink feed registry per chain in `src/lib/chains/chainlink-feeds.ts`; contracts per chain in the state section below
- **Keeper:** self-hosted Node process, one instance per chain (`contracts/order-engine/executor/executor.js:40-44`), tests via `node --test`
- **Browser → server:** on-chain reads go through `/api/rpc` (Ethereum, Base, Arbitrum — `src/app/api/rpc/route.ts:20-27`), CoW Protocol through `/api/cow/*` (`src/lib/kv-rate-limiter.ts:47-48`); the CSP `connect-src` is `'self'` plus wallet hosts only (`csp-policy.js:12-13`) and the CI job `third-party-hosts` fails any other host (`.github/workflows/e2e.yml:93-99`)
- **Monitoring:** Cloudflare Worker scheduler (ADR-003), GitHub Actions watchdog (`monitoring-watchdog.yml`), Telegram alerts (`@teraswap_monitor_bot` — `docs/Runbooks/MONITORING-ALERTS.md:17`), Sentry (`@sentry/nextjs`)
- **Infra:** Vercel (`vercel.json`), Supabase, Cloudflare (DNS + Worker, `workers/`), GitHub Actions CI — Node 22 for the app jobs, Node 20 in `keeper-tests.yml`

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
13. **NEVER invoke credential helpers or read the keychain** (`git credential-*`, `security find-*`) for any purpose; if an action needs auth the session lacks, report the manual step and stop. Why: two agent sessions independently reached for the macOS keychain, one nearly self-merging a PR (keychain near-miss, 2026-07-09).
14. **NEVER treat "PR open" as a goal's exit condition** — exit = branch pushed + compare link reported + local verification done. CI runs once the OWNER opens the PR and must be green before merge — PR creation is never the agent's job. Why: a stop-hook deadlocked 9 cycles requiring "PR open" when PR creation is owner-manual (stop-hook deadlock, 2026-07-09); a follow-up deadlocked again requiring "CI green" pre-PR when this repo's CI only triggers on push/PR to `main` (CHORE-HYGIENE-2, 2026-07-11).
15. **STOP only if blocked or before anything irreversible** (force-push, delete, prod DB write, secrets); otherwise keep going and put status in the same message as your next action. Why: a session died 2026-09-19 before writing its feedback file, and the run's evidence was lost.

---

## Code Agent Feedback Convention

**Per-PR, not shared.** The old shared append-only `FEEDBACK.md` conflicted on every parallel PR — GitHub's
squash/rebase merge does not honor the `merge=union` git attribute (tried in `CHORE-FEEDBACK-MERGE-UNION`),
so every PR touching it paid a rebase tax. Each PR now carries its **own** feedback instead: either a
`## Feedback` section in the PR body, or a per-PR file at `docs/feedback/<branch-name>.md`. Never append to
the old shared `FEEDBACK.md` (archived, see below) — a new PR never has a reason to touch it.

**Feedback file lifecycle:** Create `docs/feedback/<branch>.md` in the FIRST commit with this goal's task checklist.
Tick items and add findings as you go. The final FEEDBACK is the last edit of that file, not a report written at
the end. **Why:** compaction kills interim feedback; session death before final report loses the evidence.

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

## Current state (measured 2026-11-11 at origin/main, PR #675)

Each line names what proves it. Re-measure before relying on a number; a line this file cannot prove is not here.
The block below is generated from the repo and checked in CI (`node scripts/gen-claude-state.mjs --check`, `lint` job); the bullets after
it are hand-measured on the date above.

<!-- state:begin -->
<!-- Generated by scripts/gen-claude-state.mjs from repo content only (no date, no sha). Do not edit by hand:
     node scripts/gen-claude-state.mjs --write && node scripts/check-agents-parity.mjs --write -->

**Contracts** — copied from the "Contracts" table of `docs/DEPLOYMENTS.md`. One address can be a different contract on another chain:
always qualify by chain. Operational status and the checks behind each row are in that file's "Verified facts" column.

| Role | Chain | Address |
|------|-------|---------|
| FeeCollector V2 (instant swaps) | Ethereum Mainnet (1) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` |
| FeeCollector (instant swaps) | Base (8453) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` |
| FeeCollector V1 (frozen) | Ethereum Mainnet (1) | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` |
| OrderExecutor (conditional orders) | Ethereum Mainnet (1) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` |
| OrderExecutor (conditional orders) | Base (8453) | `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` |
| OrderExecutor V3 (conditional orders, oracle floor) | Base (8453) | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` |
| FeeCollector (instant swaps) | Arbitrum One (42161) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` |
| OrderExecutor V3 (conditional orders, oracle floor) | Arbitrum One (42161) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` |
| OrderExecutor (testnet) | Sepolia (11155111) | `0xeFC31ADb…f130` + `0xa298e6ed9CF510b708a1F16c9729Bd69c6ee00f2` |

**Workflows** (10, `.github/workflows/`): CI (`ci.yml`), CodeQL (`codeql.yml`), Daily health report (`daily-health-report.yml`), Dependabot auto-merge (`dependabot-auto-merge.yml`), E2E (real-render) (`e2e.yml`), Gitleaks (`gitleaks.yml`), Keeper Tests (`keeper-tests.yml`), Monitoring Watchdog (`monitoring-watchdog.yml`), Security Audit (`security-audit.yml`), Token catalog refresh (`token-catalog-refresh.yml`)

**ADRs** (`docs/ADR/`): 27 files, ADR-001 to ADR-027; latest `ADR-027-basket-dca-three-orders`, Status: Proposed

**Test files:** vitest 493 (the `include` globs of `vitest.config.ts`) · keeper node:test 52 · Foundry 3
<!-- state:end -->

- **Chains:** Ethereum Mainnet (1), Base (8453), Arbitrum One (42161), plus a Sepolia testnet row — `docs/DEPLOYMENTS.md`, whose per-row
  "Verified facts" say whether each deployed contract is operational and when that was checked (the file's own header says it was
  verified on-chain 2026-06-13, with later rows dated individually). Contracts per chain: the generated block above.
- **UI v2:** a parallel tree (`src/ui/v2/`, `src/app/v2/`) behind one server-side switch in `src/proxy.ts` — `UI_V2_ENABLED=true`, or a
  signed `ts_ui` cookie (ADR-025, Status: Proposed). v1 never imports v2 (`src/ui/v2/isolation.test.ts`). Content parity v1 ⊆ v2 is
  gated by `src/ui/v2/__tests__/parity-sweep.test.tsx`. Scoped rules: `src/ui/v2/CLAUDE.md`.
- **Visitor privacy:** browser RPC reads go through `/api/rpc` (per-chain read-only method allow-list, `src/app/api/rpc/route.ts:24-28`),
  CoW through `/api/cow/*`; rate-limit buckets use an HMAC of the client IP, never the address (`src/lib/client-ip-key.ts:1-8`); the CSP
  `connect-src` is `'self'` plus wallet hosts (`csp-policy.js:12`); CI job `third-party-hosts` records every cross-origin request on
  v1 and v2 for all three chains and fails on any host outside its allow-list (`.github/workflows/e2e.yml:93-99`).
- **Keeper (`contracts/order-engine/executor/`):** ADR-026 (Proposed): a miss caused by our infrastructure does not count against a
  user's order — only `order` misses advance the 8-miss ladder (`retry-policy.js:40-57`, ADR-026 Decision 2); ADR-024 (Accepted): DCA floor price quorum,
  skip the cycle, never the order; per-chain gas tiers (`gas-tier.js:1-17`); one instance per chain, verified against the chain at
  boot (`executor.js:46-60`). Scoped rules: `contracts/order-engine/CLAUDE.md`.
- **Supply chain:** the CI `audit` job runs `scripts/audit-gate.mjs` (`ci.yml:73-86`). `audit-allowlist.json` holds 6 entries; every
  entry carries `expires`, and an expired or undated entry blocks (`audit-allowlist.json` `$comment`; `scripts/audit-gate-lib.mjs:5-9`).
  Earliest expiry: 2026-11-22.
- **Force-MEV retired (owner decision 2026-11-06):** the toggle, its notice and the "Use Gasless Route" CTA are gone from v1 and v2; CoW
  stays an ordinary, ranked source. The test header records why: CoW's free quote API has answered 429 to our servers since 2026-10-29
  (`src/ui/v2/swap/retire-force-mev.swap.test.tsx:3-7`).
- **Token catalog:** one shared pipeline, `npm run tokens:sync` (`scripts/token-catalog/build.ts`), writes
  `src/config/generated/token-catalog.{1,8453,42161}.json` (994 / 450 / 376 entries); `token-catalog-refresh.yml` runs it Mondays 06:00 UTC.
  `src/lib/chains/arbitrum-catalog*.ts` is the superseded manifest pipeline, kept in place.
- **CI:** `ci.yml` job `full-suite` runs the whole vitest suite with no file list (`ci.yml:442-470`); the per-file guard jobs are additive.
  ADR-025 and ADR-026 are Proposed, ADR-013 and ADR-024 Accepted (their `Status` lines).
- **Tests (real runs, Node 25.6.1 on the owner's Mac, 2026-11-11):** `CI=true npx vitest run` → 8249 tests in 463 files, 0 failed;
  keeper `node --test` in `contracts/order-engine/executor` → 1240 tests, 0 failed; `forge test` as CI runs it (`ci.yml:520-527`) → 119
  (order-engine) + 19 (FeeCollector) = 138, 0 failed. CI runs the keeper suite on Node 22 (`ci.yml:487-498`) and Node 20 (`keeper-tests.yml:43`).
- **Open findings:** `docs/security/AUDIT-TOTAL.md` (1606 lines) has no entry dated after 2026-10-11 (`AUDIT-TOTAL.md:1589`). Read it, and the
  latest `docs/Prompts/` packet, before any fund-flow change (Do NOT 2 and 5); this file does not claim a current open-finding count.
