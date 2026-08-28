# _PROMPT-TEMPLATE — Architect → Code-Agent prompt format (canonical)

> **What this is.** The standard shape of every Architect prompt in `docs/Prompts/`, plus the TeraSwap invariants that
> keep prompts accurate. This file is the *reference* — the **`/goal` paste itself always stays ≤ 4000 chars** and pulls
> in **only the facts relevant to that task**. Purpose: minimum credit burn, right-sized model, correct guardrails.
> PT-PT to the owner; **EN in every prompt/goal**.

---

## 0. Pick the MODEL + EFFORT first — the biggest cost lever

Decide this **before** writing the `/goal`. Match the tier to the work; never default to the top.

| Task | Model | Effort |
|---|---|---|
| read-only **recon / reconciliation** vs `origin/main`, investigation report, grep-and-report, **doc/index refresh**, reference/link fixes, mechanical find-replace | **Haiku** | low |
| standard implementation: **frontend, API route, adapter, tests**, bounded refactor, chore across a few files | **Sonnet** | medium |
| **fund-flow, contract/Solidity, keeper/signer, gate logic**, ADR/design authoring, security reasoning, **Auditor pass on anything touching funds** | **Opus** | high |

**Effort dial:** `low` = mechanical/deterministic · `medium` = normal implementation · `high` = only when a wrong answer
costs **funds or security**. Tier the **Auditor and recon** too (recon → Haiku; Auditor on docs → Sonnet; Auditor on
fund-flow/contract → Opus).

**Cost checklist on every `/goal`:** model+effort matched · `read ONLY <files>` (no repo scan) · `NO CI-poll` ·
`FEEDBACK ≤ 1 screen` · batched with siblings, parallel only on disjoint files · parallel → own git worktree · fan-out
only for broad tasks.

---

## 1. The CONTROL header — first line of EVERY `/goal`

```
CONTROL: model <Haiku|Sonnet|Opus> · effort <low|medium|high> · NO CI-poll (push + report, don't watch) · read ONLY <the listed files> · FEEDBACK <= 1 screen.
```

NEVER invoke credential helpers or read the keychain (git credential-*, security find-*) for any purpose; if an action needs auth the session lacks, report the manual step and stop.

---

## 2. Auditor gating (decide up front, in the blockquote)

- **fund-flow / gate / signer / contract** → flag **→ Auditor**; PR **UNMERGED until 0C/0H**.
- **contract change** → 0C/0H **+ 48h timelock + migration + runbook**; **never deploy un-audited**.
- **display / docs / read-only / frontend-only** → **no Auditor**.
- **gate-adjacent but strictly tightening** (e.g. threading `chainId` into a value gate) → **Auditor note** (can ride a
  future review).

---

## 3. TeraSwap invariants & facts

*(Reference — pull only what the task needs into the `/goal`, keep it ≤ 4000.)*

- **What/where.** Permissionless, no-KYC meta-aggregator, 0.1% fee. **LIVE on Ethereum mainnet + Base L2.** 11 sources
  (+ Bebop = 12th, ADR-010).
- **Contracts** (Solidity 0.8.28, Foundry). Mainnet: real `OrderExecutor` v2 + `FeeCollector V2 = 0x47f2…7459`. Base:
  `0xeFC3…f130 = FeeCollector` (swap fns only, **no** `executeOrder`) — **BaseScan mislabels it "OrderExecutor"**; env
  `NEXT_PUBLIC_BASE_FEE_COLLECTOR=0xeFC3…f130`. **Base has NO real OrderExecutor yet** → Base conditional orders stay
  fail-closed until one is deployed.
- **Chain-awareness = the #1 historical root cause.** Most past bugs = a path not chain-aware (RPC URL, price feeds,
  safety/oracle gates, router whitelist) → Base priced/gated off mainnet. For ANY prompt touching pricing / gates / RPC
  / routers, require *"is this chain-aware?"*. Router whitelist: **mainnet Augustus V5 / Base V6**.
- **On-chain guards = terminal backstop.** `executeOrder` enforces `recipient == order.owner` + on-chain
  `minimumOutput` + chain-correct router whitelist. `api/swap` fail-closed gates: **SC-04** (`isKnownSwapSelector`) +
  **R1** (`validateCallDataRecipient`). **Chainlink validation is mandatory** for all swaps (29 mainnet feeds);
  **DefiLlama blocks swaps > $10k** when unavailable; never trust single-source price.
- **DCA caveat (flagship P1a).** DCA signs `minOut = 1 wei` → the on-chain `minimumOutput` is a **NO-OP for DCA**; the
  current bound is the **off-chain Phase-0 floor (#279, `order-floor.js`)** until the **v3 on-chain fix (ADR-013)**. Base
  uses the **sequencer private mempool** (not public-mempool-sandwichable).
- **Order engine.** DCA/Limit/SL·TP are **L2-only** (Base first; mainnet gas unviable for small orders). **Keeper is
  self-hosted** (Gelato deprecated Mar-2026); `executor.js` signs + pays gas; **keeper stays on KMS**, never
  `ALLOW_PLAINTEXT_KEY` in prod. DCA go-live = flip `NEXT_PUBLIC_DCA_ENABLED=true` (default off); the DCA gate pins
  `chainId === 8453`.
- **Stack invariants.** Next.js 16 · React 18 · TS 5.5 · Wagmi 2.19 · Viem 2.47 · RainbowKit 2.1 · Zustand 4.5 ·
  Tailwind 3.4. Backend: Next API Routes on **Vercel Pro** (no CPU cap) + **Upstash Redis** + **Supabase (PostgreSQL +
  RLS)**. Alchemy PAYG. **NEVER bump to wagmi v3** (P184 caused the WalletConnect multi-Core outage).
- **Repo conventions.** ADR: Proposed→Accepted→**Superseded (never deleted)**, `docs/ADR/ADR-NNN-slug.md`. Incidents:
  `INC-YYYY-MM-DD-NNN`, append-only, `Audits/Incidents/`. **RICE** for priority. Sprints:
  `docs/Prompts/SPRINT-{N}{A-Z}.md`. **Marketing → `dex-aggregator 2.marketing/`, NEVER in the code repo.** Stay on
  **npm** (`min-release-age=7d`). **Never re-enable a disabled source** without its incident's reactivation criteria.
  Rule #4 = never delete → mark superseded OR move to `archive/`.
- **Roles & hard Do-NOTs.** Architect never edits source (produce prompts); Auditor never edits (classifies C/H/M/L,
  0C/0H = approved). **Never approve a contract/fund-flow change without checking `docs/security/AUDIT-TOTAL.md` + the
  latest sprint packet.** **Never deploy without 0C/0H.** Never hardcode secrets; no `NEXT_PUBLIC_` for server secrets.

---

## 4. The spec skeleton (`docs/Prompts/<NAME>.md`)

```
# <NAME> — <one-line what+why>

> **Source:** <finding / PR / AZ review>. <fund-flow? → Auditor? / docs-only → no Auditor>. SSH-signed.
> Branch off latest origin/main in a dedicated worktree. <N droppable commits>.

## Requirements            (numbered; per-commit if multi)
## Do NOT                  (explicit guardrails — the "never" list)
## Files affected (read ONLY these)   (the allow-list that scopes the agent)
## Expected output         (branch name, SSH-signed, push+report-not-poll, tests, FEEDBACK <= 1 screen)
   Exit = branch pushed + compare link reported + local verification done. CI runs once the OWNER opens the
   PR and must be green before merge — PR creation is never the agent's job.
## Quality criteria        (the acceptance bar)

---

### `/goal` paste for the Code Agent (<=4000)   ← hard limit; include only the relevant §3 facts
```<goal fenced block — starts with the CONTROL header, self-contained>```
```

---

## 5. Parallelism & git hygiene (learned 2026-07-08)

- **Each parallel session runs in its OWN git worktree** — `git worktree add ../wt-<branch> origin/main`; never share
  the main checkout (a stray `git checkout` moves HEAD → one branch's commit leaks onto another's).
- **Parallelise only on non-overlapping files.**
- **Stray commit on an unmerged feature branch** → `rebase`-drop it, then **RE-SIGN the replayed commits** (rebase makes
  new objects → they lose signatures; verify `git log --show-signature` before force-push). Feature-branch force-push is
  fine; `main` protection stays intact.

---

## 6. Standing prompt-mechanics conventions

- **`/goal` ≤ 4000 chars**; the full spec lives here in `docs/Prompts/`.
- **Commit the spec in its implementation PR.** If the agent reports "missing spec file": **proceed from the
  self-contained `/goal` AND commit this spec in the PR**.
- **SSH-signed commits, noreply committer** (rule #12) — `main` rejects unsigned.
- **Per-PR feedback** (PR body or `docs/feedback/<branch>.md`), **not** the shared append-only `FEEDBACK.md`.
- **PT-PT to the owner, EN in prompts.**

*(Memory: `feedback_architect_prompt_template`, `feedback_agent_cost_optimization`, `feedback_goal_char_limit`,
`feedback_commit_prompt_specs`; project memories under `project_*`.)*

---

## 7. Dispatching to Grok Build

Grok Build (xAI's coding-agent CLI) is a second Code Agent alongside Claude Code. It reads `AGENTS.md`, not
`CLAUDE.md`, so a spec's own `/goal` payload is the only thing carrying the rules to it — the `/goal` written
under §1–§4 above **is** the Grok Build payload, unchanged.

- **`scripts/grok-dispatch.sh <spec> <branch> [--dry-run] [--execute]` is the only sanctioned entry point.**
  Never invoke `grok` directly against this repo's working tree.
- **`--execute` is always a human decision.** `--dry-run` is the default and prints the plan (resolved
  model, approval mode, every refusal check) without touching anything; a real run requires the operator to
  pass `--execute` explicitly, after reviewing a `--dry-run` first.
- The dispatcher resolves the Grok model from the CONTROL header's `effort` field and refuses to run when the
  header is missing model/effort, when "Files affected" names a `.env*` path or a keychain/credential
  reference, or forces interactive mode (never `--always-approve`) when "Files affected" touches
  `contracts/**`, `keeper/**`, an `*executor*` path, `src/lib/chains/**`, or any swap/gate/signer path — see
  `AGENTS.md` and the dispatcher's own refusal checks for the exact rules.
- The dispatcher always works in a fresh `git worktree add … origin/main`, never the main checkout, and never
  polls CI — it writes the run's JSON output plus a summary to `docs/feedback/<branch>.md` and stops.
