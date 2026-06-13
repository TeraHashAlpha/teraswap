# REVIEW-QUALITY 2026-06-11 — deep code-quality & correctness review (application code)

A thorough engineering code review of TeraSwap's TypeScript/React/Node application code, by the project
owner, to find bugs, improve correctness and consistency, and fix what's safe. Ordinary deep code
review — depth over speed. Read `CLAUDE.md` first (roles, conventions, the 12 "Do NOT" rules).

Scope: `src/**` (frontend, hooks, lib, adapters, components, chains, app/api routes), `.github`,
`package.json`/lockfile, config. **Out of scope here:** Solidity contracts and the on-chain
oracle/fee logic — those go through the normal Auditor process separately.

You are the **orchestrator**. Fan out many review subagents in layers and check code AND logic. Fix
the safe findings (with tests); for anything sensitive, write a remediation prompt instead of changing
it.

## What to look for (we hit several of these recently — find MORE)
1. **Chain-aware consistency (top priority).** Any code that assumes Ethereum mainnet (chainId 1, a
   mainnet RPC/client, etherscan links, a mainnet token/feed address, a mainnet-only constant) on a
   code path that also runs on Base. This has been the most frequent defect. Make every multi-chain
   path consistently use the active chain.
2. **Dependency hygiene.** Confirm the lockfile resolves a SINGLE instance of each important dependency
   (wallet/connection libs, qr, viem); flag over-loose semver ranges that could let a transitive bump
   silently change the build; recommend tighter pins. (We recently had a transitive bump crash the UI
   and a duplicated wallet library.)
3. **Reliability of async/error paths.** API routes and client fetches always returning well-formed
   JSON (never an HTML error page); timeouts/abort on slow upstream calls; graceful fallbacks; no
   unhandled rejections; React render paths that can't throw to a blank error boundary.
4. **State & lifecycle correctness.** Hooks, effects, memoization, and provider setup: stable
   singletons, correct dependency arrays, no stale closures, no double-init, clean teardown
   (wallet/session lifecycle has been fragile — review it carefully).
5. **Consistency & dead code.** Duplicated logic, drifted constants, unused modules/exports, mismatched
   types, and places where one code path was updated but a sibling wasn't.
6. **Env & config hygiene.** No server-only secret behind a NEXT_PUBLIC_ prefix; Preview/prod env
   differences handled gracefully; headers/config sane.
7. **Type safety & tests.** `any`/unsafe casts on critical paths; thin test coverage on important
   logic (especially Base/multi-chain paths and the order-engine UI flow).

## Layered review (fan out widely)
- **Layer 0 — Recon (1–2 agents):** map `src/**` + config; list the modules and the cross-cutting
  invariants (chain-awareness, single-source constants, error-shape) each later agent verifies. No edits.
- **Layer 1 — Domain reviews (parallel, one+ agent each):** (A) app/api routes; (B) hooks; (C)
  lib/utilities; (D) adapters/aggregation client code; (E) components/UI + swap flow; (F)
  chains/registry/token-catalog; (G) dependencies/lockfile/config; (H) tests/coverage.
- **Layer 2 — Cross-cutting consistency (3–4 agents):** sweep for the chain-awareness class across ALL
  domains; verify constants have a single source of truth; verify error-shape consistency; find
  "updated here but not there" drift.
- **Layer 3 — Synthesis + fixes:** dedupe, consolidate, classify severity (High/Med/Low/Info),
  RICE-rank, then fix/escalate.

## Fix rules
- **FIX on a branch (TDD + CI green):** correctness/consistency/chain-awareness fixes that keep
  mainnet behaviour byte-identical (test-guarded), dead-code removal (prove zero refs first; never
  delete docs/ADR/incident/spec files — rule #4), dependency pins, error-handling hardening, type
  fixes, added tests. One atomic SSH-signed commit per fix; CI green (test-contracts is a real gate —
  keep it green).
- **Do NOT change (write a remediation prompt instead):** anything that alters the behaviour of an
  on-chain price/oracle/fee path or any value the contracts rely on — flag for the Auditor. Do not
  touch Solidity. No hardcoded secrets / no NEXT_PUBLIC_ server secrets. Marketing out of the repo
  (rule #10). Every commit signed (rule #12).
- Evidence per finding: file:line, why it's a defect, severity, fix, effort — from reading the code /
  running a test, not assumption.

## Output
1. `Audits/REVIEW-QUALITY-2026-06-11.md` — exec summary, findings table (severity, file:line,
   disposition FIXED-PR#/ESCALATED), and a RICE-ranked plan split "auto-fixed (PRs)" vs "needs human
   review".
2. Branches/PRs for every safe fix (signed, CI green).
3. Remediation prompts for the rest.
4. FEEDBACK with anything the review surfaced.
Stop at human-only boundaries (real-device testing, deploys); document, no loop.
