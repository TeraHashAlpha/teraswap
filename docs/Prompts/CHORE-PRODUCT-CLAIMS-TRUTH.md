# CHORE-PRODUCT-CLAIMS-TRUTH — one module owns user-facing source/chain/order claims

> **Source:** measured defect 2026-08-29. Display / docs only — **no Auditor gate** (no fund-flow).
> SSH-signed, noreply committer. Branch `chore/product-claims-truth` off `origin/main` in a
> dedicated worktree. 4 droppable commits.

CONTROL: model Grok · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the files listed below · FEEDBACK <= 1 screen.

## Context

User-facing surfaces state FOUR source counts and contradict each other on chains and order types:

- sources: 10 (`layout.tsx:25`, `LandingBelowFold.tsx:812`), 11 (`SwapBox.tsx:1117`, `DCAPanel.tsx:1243`), 12 (`DocsPage.tsx` ×3, `README.md:4`). `src/lib/adapters/index.ts` exports `ADAPTER_REGISTRY: DEXAdapter[]` — the code's own list. That is the source of truth; nothing else counts.
- chains: `LandingBelowFold.tsx:961` + `LandingPage.tsx:335` say "Ethereum Mainnet"; `README.md:124` says Mainnet, Base AND Arbitrum; registry has 1, 8453, 42161.
- DCA: `README.md:110` says "DCA live"; `LandingBelowFold.tsx:914` + `DocsPage.tsx:92` say "Coming Soon". Gate: `NEXT_PUBLIC_DCA_ENABLED`, default off.

## Requirements

### Commit 1 — claims module + this spec

1. `src/config/product-claims.ts` — ONE module deriving from code, never prose:
   - (a) the count as `ADAPTER_REGISTRY.length` (`adapters/index.ts`) — never a file scan or filename blocklist. Claim string: `"N integrated DEX sources"` — `integrated` is what the registry proves. No surface may call a source best or winning in static copy.
   - (b) the chains that actually execute swaps, from the registry.
   - (c) each order type's availability from its launch flag.

### Commit 2 — surfaces read the module

2. Every user-facing surface reads from it: `layout.tsx` (incl. the OG/meta description), `LandingPage`, `LandingBelowFold`, `DocsPage`, `SwapBox`, `DCAPanel`. Leave no hard-coded count or chain list there. `/swap` and `/app` now exist as routes rendering SwapBox — scan them too.

### Commit 3 — CI checker

3. `scripts/check-product-claims.mjs` — fail CI when a user-facing file hard-codes a digit or spelled-out number next to "source(s)"/"DEX", or names a chain in a live-status claim, instead of importing the module. Controls: today's tree must FAIL before commit 2 and PASS after; a fixture with a hard-coded "11 sources" must fail.

Wire the check into `package.json`, the CI lint job and `vitest.config.ts` — those three only. ADD alongside, never replace or reorder existing checks.

### Commit 4 — README

4. `README.md`, addresses handled with care:
   a. Line 110 claims "DCA live" on Base — contradicted by the product surfaces and the flag. State the deployed contract only; assert no live status the flag does not support.
   b. Line 124 and the landing footer disagree on chains. Make README match the registry.
   c. The address table is INCOMPLETE, not wrong: all five addresses match `docs/DEPLOYMENTS.md` exactly — verified; do NOT "fix" any. It omits the Base OrderExecutor v2 and Arbitrum V3 rows and never qualifies v2 vs V3 per chain — that is what reads as a mismatch. ADD those rows and the qualifier by copying from `docs/DEPLOYMENTS.md` WITH A SCRIPT — never retype a hex, never alter an existing address, print a length sentinel (42) per address.

## Do NOT

- Change any 0x address value; retype any hex by hand.
- Edit marketing voice, superlatives, taglines or the roadmap (owner decisions, separate PR).
- Touch `contracts/`, `keeper/`, `src/lib/chains` logic or any swap-gate path.
- Invent a source count.
- Open a GitHub PR or watch CI.
- Auditor gate (display / docs only, no fund-flow).

## Files affected (read ONLY these)

- `src/config/product-claims.ts` (new)
- `src/config/product-claims.test.ts` (new)
- `src/app/layout.tsx`
- `src/app/swap/`
- `src/app/app/`
- `src/components/LandingPage.tsx`
- `src/components/LandingBelowFold.tsx`
- `src/components/DocsPage.tsx`
- `src/components/SwapBox.tsx`
- `src/components/DCAPanel.tsx`
- `src/lib/adapters/`
- `src/lib/chains/registry.ts`
- `README.md`
- `docs/DEPLOYMENTS.md` (read; copy addresses via script only)
- `scripts/check-product-claims.mjs` (new)
- `scripts/check-product-claims.test.mjs` (new)
- `scripts/sync-readme-deployments.mjs` (new; copies hex from DEPLOYMENTS.md)
- `package.json`
- `vitest.config.ts`
- `.github/workflows/ci.yml`
- `docs/Prompts/CHORE-PRODUCT-CLAIMS-TRUTH.md` (this file)
- `docs/feedback/` (per-PR, only if a real finding applies)

## Expected output

Branch `chore/product-claims-truth` pushed, compare link reported, local verification done. 4 SSH-signed noreply commits (`TeraHash <256859133+TeraHashAlpha@users.noreply.github.com>`). CI runs once the OWNER opens the PR and must be green before merge — PR creation is never the agent's job. Do not watch CI after pushing.

The PR body must state the address table was extended by script and no address was modified.

## Quality criteria

- Full suite green.
- Both req.3 controls present.
- A test asserting `layout.tsx`'s meta-description count equals the derived value.
- `ADAPTER_REGISTRY.length` is the only source count; no invented N.
