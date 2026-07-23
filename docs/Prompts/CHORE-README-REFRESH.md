# CHORE-README-REFRESH

**Type:** Chore (docs only)
**Date:** 2026-07-23
**Branch:** `chore/readme-refresh`

## Context

The public README had drifted from reality: it listed Ethereum + Base only (Arbitrum went live in
production 2026-07-20 per `docs/DEPLOYMENTS.md`), a stale 1,600+ test badge, a "29 feeds" oracle
claim that (by coincidence) still holds for mainnet alone but wasn't scoped as such, an "11 sources"
count that's now 12 registered adapters, and prose that implied Limit/Stop-Loss/Take-Profit orders
are live when only DCA (Base) is. The Architecture diagram also rendered as raw CSS/text on GitHub —
the fenced block had been pasted from a rendered DOM instead of mermaid source.

## Objective

Bring README.md's factual claims back into agreement with the codebase, with every number sourced
from a verification command, not memory or guesswork.

## Verification sources (read-only)

- `docs/DEPLOYMENTS.md` — network/contract live status
- `src/lib/chains/chainlink-feeds.ts` + `src/lib/constants.ts` — Chainlink feed counts per chain
- `src/lib/adapters/index.ts` (`ADAPTER_REGISTRY`) — liquidity source count
- `docs/ADR/ADR-010-bebop-rfq-source.md` — Bebop status (still `Proposed`, not `Accepted`)
- `src/lib/dca-launch.ts` — DCA launch gating (flag + chain allowlist + v3 executor wiring)
- `npx vitest run` — actual passing TS test count
- `forge test --summary` (contracts/order-engine) — actual passing Foundry test count
- `docs/erc7730/`, `contracts/clear-signing/registry-submission/`, `Audits/Sprint/audit-sprint-15*.md`
  — ERC-7730 descriptor status (lint-clean, prepared for upstream submission; no evidence of an
  upstream merge in-repo)

## Changes

1. **Networks:** badge + prose updated to Ethereum + Base + Arbitrum (Arbitrum FeeCollector live
   2026-07-20 per DEPLOYMENTS.md). Conditional orders/DCA remain Base-only (Arbitrum's OrderExecutor
   v3 slot is unset — swaps only).
2. **Test badge:** 1,600+ → 2,900+ (actual: 2,913 TS tests passing across 213/214 files at time of
   writing — see feedback for the one broken local file, an environment issue unrelated to the code)
   plus a Foundry count (119, up from the stale 74 in CLAUDE.md).
3. **Oracle badge:** "29 feeds" reworded to "Chainlink-validated across 3 chains" since 29 was
   mainnet-only; Base and Arbitrum add 4 and 5 more respectively.
4. **Source count:** "11 liquidity sources" → "12 integrated liquidity sources," sourced from
   `ADAPTER_REGISTRY`. Bebop's ADR-010 is still `Proposed` (not `Accepted`) — flagged in feedback
   rather than asserted as fully approved.
5. **Order-type honesty:** split into "Live: DCA (Base)" vs "Coming soon: Limit, Stop-Loss,
   Take-Profit" instead of listing all four as shipped.
6. **Claim audit:**
   - MEV protection via CoW — kept (CoW is a live, registered quote source).
   - Gasless approvals via Permit2 — reworded to "approve once on-chain, then sign (gasless) for
     every swap after" to match the actual one-time-approve-then-sign-per-swap flow in
     `useApproval.ts` / the in-app copy, rather than implying zero on-chain approval ever happens.
   - Clear signing (ERC-7730) — softened to "in progress" (descriptor is lint-clean and packaged for
     submission per Sprint 15, but nothing in-repo confirms an upstream LedgerHQ registry merge).
7. **Architecture diagram:** replaced the broken block (rendered mermaid CSS/DOM output pasted as
   plain text) with clean mermaid flowchart source that renders on GitHub.

## Do NOT

- Did not touch any file besides `README.md` and this spec.
- Did not invent any numbers — every count above is diffed against a source in this doc.
- Did not assert Bebop or ERC-7730-upstream-merged as fact; both are flagged for owner review.

## Expected output

Branch pushed, compare link reported. No PR opened (owner's call). No Auditor pass (docs-only chore).
