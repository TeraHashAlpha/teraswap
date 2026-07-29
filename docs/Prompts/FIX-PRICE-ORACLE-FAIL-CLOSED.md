# FIX-PRICE-ORACLE-FAIL-CLOSED — Make useChainlinkPrice fail closed

> Spec as issued by the Architect (`/goal`, 2026-07-29). Committed with the implementation per the
> post-#273 process fix. Branch: `fix/price-oracle-fail-closed`.

## Context

`useChainlinkPrice` lines 54-56: a read error returned `level:'none', oracleUnavailable:false` —
indistinguishable from "not loaded". This silently disabled BOTH the deviation gate and the >$10k
unpriceable gate for every feed-covered pair. Recorded as L-02 in the `AUDIT-ORACLE-FAIL-CLOSED`
entry (`docs/security/AUDIT-TOTAL.md`, 2026-07-28) and flagged there as the recommended immediate
follow-up — wider blast radius than the depeg gate itself.

## Design (follow the merged pattern; do not reinvent)

1. Model three states: loaded-ok, in-flight (first load), UNAVAILABLE (read error, revert,
   incomplete data, stale beyond threshold).
2. UNAVAILABLE must surface as `oracleUnavailable:true` so both gates engage. Never return a state
   indistinguishable from "not loaded".
3. Switch chain resolution to `useResolvedChainId()` — no `?? DEFAULT_CHAIN_ID` for oracle reads.
   This hook is the LAST oracle-adjacent consumer still defaulting to mainnet.
4. Reuse `getFeedStalenessSec`. Single source of truth, no new thresholds.
5. Reuse the dual-signal failure memory from `useDepegCheck`/`depeg-gate.ts` (`failureCount` +
   `errorUpdateCount` together — neither alone covers both the in-flight-retry window and the
   post-poll window; this was M-01, already fixed and merged, do not regress it).
6. In-flight is NOT UNAVAILABLE. First render keeps the existing neutral/loading state.

## Consumers

Enumerate every consumer of this hook's outputs; for each state whether UNAVAILABLE changes its
behavior. Explicitly confirm the deviation gate and the >$10k gate now block or demand consent when
the oracle cannot be read.

## Do NOT

Touch any Solidity file · modify `clients.ts` or `rpc.ts` · modify `useDepegCheck.ts` /
`depeg-gate.ts` beyond importing shared helpers · widen into a refactor · `npm install`/`update` ·
stage anything not changed (explicit paths, never `git add -A`).

## Tests

read error → gates engage; stale → engage; healthy → normal; first load → neutral; chain undefined →
UNAVAILABLE, not a mainnet read; sustained-outage-through-poll → no pending window (reuse the M-01
9-frame replay pattern). Any existing test asserting the old silent behavior must be updated and
named in FEEDBACK with file and line, never quietly deleted.

## Quality criteria

`npx tsc --noEmit` (2 expected pre-existing) · `npm run lint` · `npm test` (1 expected pre-existing
`cuer` failure). Auditor runs in a SEPARATE session.
