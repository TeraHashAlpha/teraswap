<!-- claude-md-sha256: 4efc2119ddc4561053cc55af6d6691c6f9714a6af59bcd64622e812c5bbdce5b -->
# AGENTS.md — TeraSwap for Grok Build and other non-Claude coding agents

Grok Build reads this file, not `CLAUDE.md`. This file exists so a second coding agent gets the same
guardrails as Claude Code. **`CLAUDE.md` at the repo root is the normative source — read it in full before
touching anything.** This file is a parity layer, not a replacement: a `scripts/check-agents-parity.mjs`
drift guard (see below) fails CI if `CLAUDE.md` changes without a matching review here.

## Role split

- **Architect** (human + Claude/Cowork) designs, specs, ADRs. Never edits source.
- **Code Agent** (Claude Code, or Grok Build via `scripts/grok-dispatch.sh`) implements a written prompt/spec.
  A coding agent **never audits its own work**, **never deploys**, and **never merges a PR that touches fund
  flows** (contracts, keeper, order execution, fee collection). Those require the human owner and, where
  `CLAUDE.md` requires it, an Auditor pass with 0 Critical / 0 High findings.
- **Auditor** reviews fund-flow and gate-adjacent changes. Classifies findings C/H/M/L. 0C/0H = approved.

Prompt format, sprint/ADR/incident conventions, commit rules, and every "Do NOT" in `CLAUDE.md` apply
identically to work done by Grok Build. Start every implementation task by reading the relevant prompt in
`docs/Prompts/` — see `docs/Prompts/_PROMPT-TEMPLATE.md` for the canonical prompt shape (CONTROL header,
model/effort tier, files-affected allow-list, Do NOT list). Before touching any contract, keeper, gate, or
fund-flow code, check open findings in `docs/security/AUDIT-TOTAL.md` — never proceed against an open
Critical/High.

## Hard rules (do not paraphrase these away)

Each rule below is also stated in `CLAUDE.md`. Bash compatibility, both agent-verify rules and Grok Build launch are
copied from it; address hygiene, chain-awareness, the dependency rules and the `.env*` sentence are in its Conventions
in the same words; Credential hygiene extends its Do NOT 13, and the deletion rule is its Do NOT 4.

**Address hygiene.** No hand-typed hex. Addresses and hashes flow script → config, never keyboard → file.
Hex equality is never checked by eye — always computed. Re-extract addresses from chain state at the point of
use, don't trust a value carried from an earlier step. Every on-chain assertion ships a positive AND a
negative control (prove it fails on the wrong input, not just passes on the right one). Print a length
sentinel for every derivation (hash, address, slice) so truncation or corruption is visible in the log, not
silent.

**Credential hygiene.** Never read the macOS keychain or any credential helper (`git credential-*`,
`security find-*`), even read-only. Never read or print any `.env*` file — `.env`, `.env.local`, `.env.production` and
`.env.production.local` included; only the tracked `.env*.example` templates may be read. If a task needs auth the
agent lacks, report the manual step and stop — do not work around it.

**Chain-awareness is the #1 root cause of past incidents.** Any change touching pricing, a safety/value gate,
an RPC transport, or router selection must explicitly answer: *"is this chain-aware?"* A path that silently
reuses a mainnet assumption on another chain (or vice versa) is the single most common defect class in this
repo's incident history.

**Dependency and deletion policy.** Never bump to wagmi v3. npm only, `min-release-age=7d` — no yanking a
dependency the moment it publishes. Never delete a file — supersede it in place (mark deprecated/superseded)
or move it verbatim to `archive/<original-path>/`. Nothing is ever deleted; git history is not considered a
substitute for this rule.

**Bash compatibility.** Every `.sh` in this repo must run on macOS stock bash 3.2.57 — no `${var,,}` /
`${var^^}`, no `declare -A`, no `mapfile` / `readarray`, no `globstar`. Lowercase via
`tr '[:upper:]' '[:lower:]'`. `scripts/check-bash3-compat.mjs` enforces this on every tracked `.sh` file.

**agent-verify checks.** `scripts/agent-verify.sh` always runs `suite`, `lint-delta` (CI's `npm run lint` on HEAD and on the merge-base; a crashed eslint is a FAIL), `tsc`, `build`, `v1-css` (`scripts/check-v1-css.mjs` on that build, also a step of the CI `build` job), `v1v2-parity` and `rpc-budget`; `--codeql` and `--keeper` add theirs.

**agent-verify `--codeql`.** `scripts/agent-verify.sh --codeql` pins the CodeQL query pack (`CODEQL_JS_PACK_VERSION` in `scripts/codeql-local.sh`). A `codeql FAIL tool failure: …` (pack not readable by the installed CLI) is not a finding and not a reason to rerun, repair or install anything; report it and stop.

**Grok Build launch:** in this repo Grok is launched ONLY via `scripts/grok-dispatch.sh` or from a shell that sourced `scripts/grok-guard.sh`. A bare `grok` here has no credential guard. Their `--deny` flags (`Read(.env*)`, `Bash(security*)`, `Bash(git credential-*)`) do NOT protect `.env*` — measured (`docs/security/GROK-DENY-CANARY-2026-08-28.md`): Grok routes around a denied read by choosing a different command, because a `Bash(...)` deny rule matches the invoked command name, not its arguments, so `Bash(*.env*)` cannot match `cat .env.canary`. Only `--deny "Bash(*)"` actually refuses, and that blocks the whole shell — unusable for real work, so there is no usable middle. Treat those three flags as speed bumps and intent signals only, never as enforcement. What actually holds: (a) `--deny "Bash(*)"`, when acceptable to run unusable-for-real-work; (b) running in a git worktree that does not contain `.env*` at all — `scripts/grok-dispatch.sh` creates its worktree outside this repo (`${TS_WORKTREE_BASE:-$HOME/ts-worktrees}`, never under `.claude/worktrees/`, which is still inside the repo and reachable via `../../../`).

## What a Grok Build task must never touch

`contracts/**`, `keeper/**`, any path or symbol containing `executor`, `src/lib/chains/**`, any
swap/gate/signer code path, `scripts/token-catalog/**`, or `src/config/generated/token-catalog.*.json` —
these are fund-flow-adjacent and stay Claude/Opus + Auditor territory unless a specific prompt says
otherwise. The token-catalog pipeline and its generated JSON are address-hygiene-critical (they are the
sole source of the addresses `src/lib/chains/tokens.ts` renders and swaps against, across all three
chains — see CLAUDE.md's Token catalog note) and fall under the same Address hygiene rule above: a wrong
or hand-edited address here routes a real swap to the wrong contract. The refresh holds back a source list that
grew by more than 50% and adds at most 25 tokens per chain (CLAUDE.md, Token catalog note):
`scripts/token-catalog/accepted-source-sizes.json` is the owner's decision record for accepting a new list size, so
no agent adds a line to it, and no agent commits a regenerated catalog or raises a size bound
(`src/lib/chains/token-catalog.test.ts`, `CATALOG_SIZE_BOUND` in `scripts/token-catalog/lib/config.ts`) to make a
refresh pass. `scripts/grok-dispatch.sh` refuses to
dispatch a spec whose "Files affected" list matches these paths in non-interactive (`--always-approve`)
mode; see the dispatcher's own refusal checks for the exact patterns.

## Drift guard

This file carries a `<!-- claude-md-sha256: ... -->` comment on its first line. `scripts/check-agents-parity.mjs`
recomputes the sha256 of `CLAUDE.md` **with its generated state block removed** (everything from
`<!-- state:begin -->` through `<!-- state:end -->`, markers included) and fails if it no longer matches the
embedded hash — that means a hand-written rule of `CLAUDE.md` changed and this file needs a human review to see
whether the parity content above still holds. Regenerating the state block (`node scripts/gen-claude-state.mjs
--write`) never moves the pin, so two open PRs no longer conflict on line 1; a missing, duplicated or reversed
marker fails the check loudly. The hash is never hand-typed: regenerate it with
`node scripts/check-agents-parity.mjs --write` after reviewing and updating this file, then commit both files
together.

## Pointers

- `docs/Prompts/_PROMPT-TEMPLATE.md` — canonical prompt shape, model/effort tiers, Auditor gating rules.
- `docs/security/AUDIT-TOTAL.md` — open and closed audit findings; check before any fund-flow change.
- `docs/security/GROK-DENY-CANARY-2026-08-28.md` — measured evidence that Grok's `--deny` flags do not protect
  `.env*`; read this before trusting or re-adding any Grok deny-flag enforcement claim.
- `CLAUDE.md` — full, normative project conventions. Read it in full, not just this file.
- `src/ui/v2/CLAUDE.md`, `src/app/api/CLAUDE.md`, `contracts/order-engine/CLAUDE.md` — scoped rules for those trees (UI v2 parity, API
  rate-limit/proxy rules, keeper and contracts). Read the one that covers the directory you are about to touch. They are not pinned by the
  drift guard above, which hashes only the root `CLAUDE.md`.
