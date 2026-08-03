# FIX-ORACLE-FAIL-CLOSED — Make the depeg check fail-closed

> Spec as issued by the Architect (`/goal`, 2026-07-27). Committed with the implementation per the
> post-#273 process fix. Branch: `fix/oracle-fail-closed`.

## Context

The depeg check is currently fail-open: when the Chainlink read errors, reverts, or is stale, the
check passes and the swap proceeds as if the peg were verified. A guard that cannot verify must
block, not pass.

Named as a follow-up in [ADR-016](../ADR/ADR-016-explicit-rpc-endpoints.md), which recorded that an
unreliable third-party RPC endpoint we never chose was in a position to influence whether a depeg
check silently passed.

## Objective

Introduce an explicit UNVERIFIED state that blocks, with copy distinct from DEPEGGED.

## Requirements

1. `useDepegCheck` models two outcomes (ok/depegged). Add a third: UNVERIFIED — read error, revert,
   missing feed, or data older than the staleness threshold.
2. UNVERIFIED must BLOCK, exactly as DEPEGGED does. Never silently pass.
3. UNVERIFIED needs DIFFERENT copy from DEPEGGED. Never tell a user an asset is depegged when the
   truth is we could not check. Intent: "We couldn't verify the price right now — try again in a
   moment." Match existing copy conventions; reuse an existing retry affordance if present, invent
   no new UI.
4. In-flight is NOT UNVERIFIED. A first read still loading shows the existing pending state.

### Staleness threshold

- Report what threshold (if any) is applied to Chainlink `updatedAt` today.
- It MUST come from the real feed heartbeat, not invented. If one already exists in the repo, reuse
  it — no second source of truth.
- If the heartbeat CANNOT be determined from the repo, STOP: implement everything else, mark the
  staleness case clearly, report the blocker. A wrong threshold is worse than none — too tight
  blocks healthy swaps, too loose reinstates the hole under a new name.

### Also in scope (same root cause)

`useActiveChainId()` falls back to `DEFAULT_CHAIN_ID` (1) when `useAccount().chain` is undefined,
routing oracle reads to the mainnet transport during transient states. The depeg check can then read
the WRONG CHAIN'S feed and answer confidently. Resolve undefined to UNVERIFIED, or document
precisely why the fallback is safe. Flag any impact on other consumers.

## Do NOT

- Touch any Solidity file. On-chain guards remain the terminal backstop, unchanged.
- Modify `src/lib/chains/clients.ts` or `src/lib/rpc.ts`. That fund-flow factory stays isolated.
- Widen into a general error-handling refactor. List other fail-open hooks for separate triage.
- Run `npm install` / `npm update`.
- Stage anything not changed. Explicit paths only, never `git add -A`.

## Files affected

- `src/lib/depeg-gate.ts` — the pure verdict + new states
- `src/hooks/useDepegCheck.ts` — the decision tree
- `src/hooks/useChainId.ts` — no-fallback chain resolution for safety gates
- `src/components/SwapBox.tsx`, `src/components/SwapButton.tsx` — block wiring + copy
- tests for each of the above

## Expected output

One signed commit, branch pushed, no PR opened.

## Quality criteria

Tests covering: read error → UNVERIFIED blocked; revert → blocked; stale → blocked; healthy read →
passes; real depeg → blocked with depeg copy; in-flight → pending, not blocked. Any existing test
asserting fail-open must be updated and named in feedback with file and line — never quietly deleted.

Verify: `npx tsc --noEmit` (2 expected pre-existing errors: `@playwright/test`, `cuer`) ·
`npm run lint` · `npm test` (1 expected pre-existing failure: `cuer`).
