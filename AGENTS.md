<!-- claude-md-sha256: 9f698307fdd9d886219a335d4f73bff921752eef4cd41114250970863253fa7f -->
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

## Hard rules (verbatim from `CLAUDE.md` — do not paraphrase these away)

**Address hygiene.** No hand-typed hex. Addresses and hashes flow script → config, never keyboard → file.
Hex equality is never checked by eye — always computed. Re-extract addresses from chain state at the point of
use, don't trust a value carried from an earlier step. Every on-chain assertion ships a positive AND a
negative control (prove it fails on the wrong input, not just passes on the right one). Print a length
sentinel for every derivation (hash, address, slice) so truncation or corruption is visible in the log, not
silent.

**Credential hygiene.** Never read the macOS keychain or any credential helper (`git credential-*`,
`security find-*`), even read-only. Never read or print `.env`, `.env.local`, `.env.production`, or
`.env.production.local`. If a task needs auth the agent lacks, report the manual step and stop — do not work
around it.

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

## What a Grok Build task must never touch

`contracts/**`, `keeper/**`, any path or symbol containing `executor`, `src/lib/chains/**`, or any
swap/gate/signer code path — these are fund-flow-adjacent and stay Claude/Opus + Auditor territory unless a
specific prompt says otherwise. `scripts/grok-dispatch.sh` refuses to dispatch a spec whose "Files affected"
list matches these paths in non-interactive (`--always-approve`) mode; see the dispatcher's own refusal
checks for the exact patterns.

## Drift guard

This file carries a `<!-- claude-md-sha256: ... -->` comment on its first line. `scripts/check-agents-parity.mjs`
recomputes the sha256 of `CLAUDE.md` and fails if it no longer matches the embedded hash — that means
`CLAUDE.md` changed and this file needs a human review to see whether the parity content above still holds.
The hash is never hand-typed: regenerate it with `node scripts/check-agents-parity.mjs --write` after
reviewing and updating this file, then commit both files together.

## Pointers

- `docs/Prompts/_PROMPT-TEMPLATE.md` — canonical prompt shape, model/effort tiers, Auditor gating rules.
- `docs/security/AUDIT-TOTAL.md` — open and closed audit findings; check before any fund-flow change.
- `CLAUDE.md` — full, normative project conventions. Read it in full, not just this file.
