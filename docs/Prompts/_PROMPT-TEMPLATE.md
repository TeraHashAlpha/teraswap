# _PROMPT-TEMPLATE — Architect → Code-Agent prompt format (canonical)

> **What this is.** The standard shape of every Architect prompt in `docs/Prompts/`, plus the TeraSwap invariants that
> keep prompts accurate. This file is the *reference* — the **`/goal` paste itself always stays ≤ 4000 chars** and pulls
> in **only the facts relevant to that task**. Purpose: minimum credit burn, right-sized model, correct guardrails.
> PT-PT to the owner; **EN in every prompt/goal**. Updated 2026-09-23 per Anthropic's Opus 5.5 guidance (https://claude.dev/blog/getting-the-most-out-of-opus-5-5/).

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

**Cost checklist on every `/goal`:** model+effort matched · `read ONLY <files>` (no repo scan) · `NO CI polling` ·
`FEEDBACK ≤ 1 screen` · batched with siblings, parallel only on disjoint files · parallel → own git worktree · fan-out
only for broad tasks.

---

## 1. The CONTROL header — first line of EVERY `/goal`

```
CONTROL: model <Haiku|Sonnet|Opus> · effort <low|medium|high> · NO CI polling (push + report, don't watch) · read ONLY <the listed files> · FEEDBACK <= 1 screen.
STOP only if blocked or before anything irreversible (force-push, delete, prod DB write, secrets); otherwise keep going and put status in the same message as your next action.
```

NEVER invoke credential helpers or read the keychain (git credential-*, security find-*) for any purpose; if an action needs auth the session lacks, report the manual step and stop.

---

## 1b. Finish line — explicit exit condition in the CONTROL line

Every goal states `Exit = <one testable sentence>` in the CONTROL line itself (e.g., `Exit = branch pushed + compare link reported`). Never use "PR open" or "CI green" as exit conditions — rule #14 forbids both. A testable exit condition is verifiable at the moment the agent completes work, not something that requires the owner to act first or wait for external systems.

---

## 1c. What NOT to write in the `/goal` itself

Never write "think carefully", "step by step", "explain your reasoning", or other prose that asks the agent to reproduce its reasoning. The `effort` setting on the `/goal` command is the tool that controls reasoning depth — `medium` or `high` handle that. In `/goal` text, ask for EVIDENCE: commands and their output, file:line citations, commit hashes, sha256 digests. Make the work verifiable.

---

## 2. Auditor gating (decide up front, in the blockquote)

- **fund-flow / gate / signer / contract** → flag **→ Auditor**; PR **UNMERGED until 0C/0H**.
- **contract change** → 0C/0H **+ 48h timelock + migration + runbook**; **never deploy un-audited**.
- **display / docs / read-only / frontend-only** → **no Auditor**.
- **gate-adjacent but strictly tightening** (e.g. threading `chainId` into a value gate) → **Auditor note** (can ride a
  future review).
- **Auditor scope > ~15 files:** split by module into subagents, each returning C/H/M/L with file:line; the parent
  re-verifies every C and H itself before reporting. **For recon goals with several questions:** answer each question
  once; later questions reuse earlier answers, never re-derive.

---

## 3. TeraSwap invariants & facts

*(Reference — pull only what the task needs into the `/goal`, keep it ≤ 4000.)*

- **What/where.** Permissionless, no-KYC meta-aggregator, 0.1% fee. **LIVE on Ethereum mainnet, Base and Arbitrum
  One.** 12 registered adapters, 4 in `DISABLED_SOURCES` (`src/lib/constants.ts`) → 8 live sources.
- **Contracts** (Solidity 0.8.28, Foundry). Addresses come only from the Contracts table in `docs/DEPLOYMENTS.md`,
  always qualified by chain: one address is a different contract per chain. `0xeFC3…f130` is the mainnet
  `OrderExecutor` v2 but the `FeeCollector` on Base and Arbitrum (swap fns only, **no** `executeOrder`) — **BaseScan
  mislabels it "OrderExecutor"**; env `NEXT_PUBLIC_BASE_FEE_COLLECTOR=0xeFC3…f130`. Base and Arbitrum each have an
  `OrderExecutor V3` (oracle floor) row; for whether it is operational, read its "Verified facts" column **and** the
  dated notes above the table (the 2026-11-13 note supersedes the Arbitrum row's "NOT operational").
- **Chain-awareness = the #1 historical root cause.** Most past bugs = a path not chain-aware (RPC URL, price feeds,
  safety/oracle gates, router whitelist) → Base priced/gated off mainnet. For ANY prompt touching pricing / gates / RPC
  / routers, require *"is this chain-aware?"*. Router whitelist: **mainnet Augustus V5 / Base V6**.
- **On-chain guards = terminal backstop.** `executeOrder` enforces `recipient == order.owner` + on-chain
  `minimumOutput` + chain-correct router whitelist. `api/swap` fail-closed gates: **SC-04** (`isKnownSwapSelector`) +
  **R1** (`validateCallDataRecipient`). **Chainlink validation is mandatory** for all swaps (29 mainnet feeds);
  **DefiLlama blocks swaps > $10k** when unavailable; never trust single-source price.
- **DCA floor (flagship P1a).** On the v2 signing path DCA signs `minOut = 1 wei` → the on-chain `minimumOutput` is a
  **NO-OP** there. Where V3 is wired (`getOrderExecutorV3(chainId)`, which `isDcaLive` requires) DCA signs a derived
  `minAmountOut`, never 1 (`src/components/DCAPanel.tsx`), and **OrderExecutor V3 enforces a per-chunk floor on-chain
  (ADR-013)**: the higher of the oracle floor and the scaled signed minimum, or the latter alone with no usable feed. The
  keeper adds its own floor (`order-floor.js`) with a price quorum (ADR-024: two agreeing sources → normal floor; one →
  tighter floor and a $ cap; none, or two that disagree → skip the cycle; never fill blind). Base uses the **sequencer
  private mempool** (not public-mempool-sandwichable).
- **Order engine.** DCA/Limit/SL·TP are **L2-only** (Base first; mainnet gas unviable for small orders). **Keeper is
  self-hosted** (Gelato deprecated Mar-2026); `executor.js` signs + pays gas; **keeper stays on KMS**, never
  `ALLOW_PLAINTEXT_KEY` in prod. DCA go-live = flip `NEXT_PUBLIC_DCA_ENABLED=true` (default off); DCA is live on a
  chain only when `isDcaLive(chainId)` holds (`src/lib/dca-launch.ts`: the chain is in `DCA_CHAINS` = 8453, 42161 —
  mainnet deliberately absent — is active, and has an `OrderExecutorV3` wired).
- **Stack invariants.** Next.js 16 · React 18 · TS 5.9 · wagmi 2 · viem 2 · RainbowKit 2 · Zustand 4 · Tailwind 3
  (exact pins: `package.json`). Backend: Next API Routes on **Vercel Pro** (no CPU cap) + **Upstash Redis** + **Supabase (PostgreSQL +
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
   Create docs/feedback/<branch>.md in the FIRST commit with this goal's task checklist; tick items and add
   findings as you go; the final FEEDBACK is the last edit of that file, not a report written at the end.
   Exit = branch pushed + compare link reported + local verification done. CI runs once the OWNER opens the
   PR and must be green before merge — PR creation is never the agent's job.
   **Why:** compaction kills interim feedback; session death before final report loses the evidence. A
   file updated as you go survives both.
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

---

## 6a. UI goals — design habits to leave out

For any frontend or UI goal, list the visual habits you do NOT want: decorative gradients, cards-inside-cards nesting, icons without function, placeholder copy, or other details that add visual noise or bulk without user value.

---

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
