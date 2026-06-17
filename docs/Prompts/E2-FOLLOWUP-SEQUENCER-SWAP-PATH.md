# PROMPT — Swap-path sequencer-gate reinforcement (E-2 follow-up, belt-and-suspenders)

**For:** Code Agent (implements). **Reviewed-by-after:** LIGHT Auditor before prod.
**Branch:** `fix/sequencer-swap-path` off latest `origin/main`.
**Classification:** SECURITY GATE (rule #9) — additive defense-in-depth. Rules #2/#3 apply: no
gate weakening, no deploy without an Auditor 0C/0H pass.

---

## Context
E-2 (merged PR #167) added the L2 sequencer-uptime gate to the Base **quote** path: `fetchMetaQuote`
(`src/lib/api.ts:107`) calls `isSequencerUp(chainId, getPublicClientForChain(chainId))` and throws
`SequencerDownError(chainId)` when the Base sequencer is down or inside the recovery grace window;
`src/app/api/quote/route.ts` (lines ~190, ~275) maps that to a calm `503 { error, sequencerDown: true }`
with `Retry-After: 60`.

The E-2 audit (`Audits/Sprint/SPRINT-E2-AUDIT.md`, finding E2-I-01) noted that an **explicit** gate on
the swap-build/execution path is a clean belt-and-suspenders — **not required** (the quote gate is
upstream of any swap, and the P218 oracle price-read gate already rejects stale prices on the swap
path), but defense-in-depth worth having. This prompt implements exactly that follow-up.

## Objective
Add an explicit `isSequencerUp` check on the Base **swap-build** path (`POST /api/swap` in
`src/app/api/swap/route.ts`, where the tx is built for `chainId === 8453`). If the Base sequencer is
down or within the grace window, refuse with a clear `503 { error, sequencerDown: true }` JSON,
**reusing the SAME `isSequencerUp` + grace-window logic** as the quote gate. Mainnet is unaffected
(no sequencer feed there) and must stay byte-identical.

## Requirements
1. **Single source of truth — REUSE, do not duplicate.** Import and call the existing
   `isSequencerUp` and `SequencerDownError` from `@/lib/chains/sequencer-check`, and the public-client
   helper `getPublicClientForChain` from `@/lib/chains/clients`. Mirror the call shape used in
   `src/lib/api.ts:107` exactly:
   `const seqUp = await isSequencerUp(chainId, getPublicClientForChain(chainId))` →
   on `!seqUp`, refuse. Do **not** read the feed address, the grace constant
   (`SEQUENCER_GRACE_PERIOD_SEC`), or re-derive any threshold locally — they live only in
   `sequencer-check.ts`.
2. **Placement.** Insert the gate in `POST /api/swap` immediately **after** the existing chain-activation
   gate (`src/app/api/swap/route.ts`, the `if (chainId != null) { getChainStatus(...) }` block, ~lines
   98–111) — i.e. once the chain is known to be supported + active — and **before** the rate limiter and
   the `fetchSwapFromSource(...)` call, so a sequencer-down request burns neither rate-limit budget nor
   an upstream fetch.
3. **Mainnet byte-identical / chain-awareness.** Only consult the sequencer for a non-mainnet chain,
   using the same guard the rest of the route already uses: `chainId == null` (absent → mainnet
   default) and `Number(chainId) === DEFAULT_CHAIN_ID` must both **skip** the check entirely (no
   `isSequencerUp` call, no client construction). `DEFAULT_CHAIN_ID` is imported already in the route.
4. **Refusal shape — match the quote gate.** On `!seqUp`, return
   `NextResponse.json({ error: '<calm Base-sequencer-down message>', sequencerDown: true }, { status: 503, headers: { 'Retry-After': '60' } })`.
   Keep the message wording consistent with the quote route's so the client can render one "paused" UX.
   (You may either `throw new SequencerDownError(chainId)` and catch→map it like the quote route, or
   check `isSequencerUp` inline and return the 503 directly — pick whichever matches the route's
   existing error-handling style, but the JSON shape + status + Retry-After must match the quote gate.)
5. **Fail-safe direction.** Preserve `isSequencerUp`'s existing fail-safe (an RPC error inside
   `isSequencerUp` resolves to "down" → refuse). Do not add a fail-open branch.

## Do NOT
- Do **not** weaken, fork, or duplicate the gate logic, the grace window, or the feed address — reuse
  `sequencer-check.ts` as the only source (rule #9, and the E-2 single-source design).
- Do **not** touch any other gate (Chainlink/P218 price-read, DefiLlama, depeg, staleness), any
  adapter, any Solidity/contract, the FeeCollector routing, the recipient/selector checks, or
  constants beyond importing what already exists.
- Do **not** change the quote path or `src/lib/api.ts` — this is swap-path only.
- Do **not** expose any key client-side; keys stay server-only (no `NEXT_PUBLIC_`).
- Do **not** alter mainnet behaviour in any observable way.

## Files affected
- `src/app/api/swap/route.ts` — add the reused gate + 503 mapping (the only source change expected).
- `src/app/api/swap/route.test.ts` — add the negative-path tests below.
- `FEEDBACK.md` — append a section per the Code-Agent Feedback Convention if anything surfaces.

## Expected output / tests (TDD)
Negative-path unit tests in `src/app/api/swap/route.test.ts`, mocking `isSequencerUp` (reuse the
quote-route test pattern — `vi.mock('@/lib/chains/sequencer-check', …)` or inject via the client):
1. **Base sequencer down → swap-build refused:** `chainId=8453`, `isSequencerUp` resolves `false` →
   response `503`, body `{ sequencerDown: true, error: /sequencer/i }`, `Retry-After: 60`, and
   `fetchSwapFromSource` was **not** called and `checkRateLimit` was **not** consumed (assert the
   gate runs before both).
2. **Within grace window → refused:** `isSequencerUp` resolves `false` for the grace case (recovered
   `< SEQUENCER_GRACE_PERIOD_SEC` ago) → same 503 shape. (Grace logic lives in `isSequencerUp`; the
   test asserts the route honours its `false`.)
3. **Sequencer up → normal swap:** `chainId=8453`, `isSequencerUp` resolves `true` → swap proceeds
   exactly as today (reaches `fetchSwapFromSource`, normal 200 path).
4. **Mainnet byte-identical:** `chainId` absent AND `chainId=1` → `isSequencerUp` is **never called**
   (assert `0` calls / `getPublicClientForChain` not invoked for the sequencer purpose) and the
   response is identical to current behaviour.

## Quality criteria
- Atomic, **SSH-signed** commit(s) (rule #12). CI **green**, including the real blocking
  `test-contracts` gate (do not disturb it).
- No duplicate threshold/feed; the diff for the gate is small and points at `sequencer-check.ts`.
- Mainnet path provably unchanged (test-pinned).
- `FEEDBACK.md` appended if any edge case / assumption / concern surfaces (e.g. if the route's
  error-handling style forces the throw-and-catch variant, document why).
- Hand off to the LIGHT Auditor with: branch `fix/sequencer-swap-path`, the commit hashes, and a
  one-line `/goal`. Per rules #2/#3 this gate change does **not** deploy without an Auditor 0C/0H pass.
