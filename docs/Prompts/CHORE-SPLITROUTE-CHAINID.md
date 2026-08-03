# CHORE-SPLITROUTE-CHAINID — thread chainId into the split sub-quote fetch (activates Base split routing)

> **Source:** `INVESTIGATE-SPLITROUTE-CHAIN-AWARENESS` triage (PR #262, 2026-07-02). **CONFIRMED MEDIUM**, display/
> availability class — **NOT fund-flow** (execution re-derives every leg chain-aware). Root cause
> `src/hooks/useSplitRoute.ts:106-113` omits `chainId` from the sub-quote fetch → `/api/quote` (route.ts:177) applies
> its P217 mainnet default → on Base the sub-quotes 502 and **split routing is silently dead**. One-line fix + the
> URL-assertion test that was missing. **Standard Code Agent, no Auditor pass.** SSH-signed (noreply committer).

## Context
- `useSplitRoute.ts:106-113` builds the sub-quote `URLSearchParams` **without `chainId`**; `/api/quote` then defaults
  to mainnet (P217). Ironically #261 already threaded `chainId` into this same hook **two lines below** (for
  executable-source filtering) — the fetch just wasn't updated.
- **Effect on Base:** sub-quotes **502** (mainnet token addresses) → `findBestSplit` sub-quote map empty → **split
  routing silently dead on Base** (no wrong savings shown; the feature just never fires) + **11 wasted rate-limited
  requests** per >$5k analysis. A 14-token same-address niche (ETH/sentinel/cbBTC/USDC-family) instead mis-prices →
  wrong displayed savings + suboptimal execution ratios.
- **Not fund-flow:** execution (`useSplitSwap`) re-derives each leg via chainId-threaded `/api/swap`, `legMinOutput`
  from the fresh `toAmount`, R1/selector/simulation gates re-run. The analysis quote only sets ratios / displayed
  savings / a fail-closed fee-integrity reference. Distinct call site from the `c8ca8b1` server-side RPC fix; this is
  client-side, missed by the P217/219/221 chain-threading passes.

## Objective
Thread the active `chainId` into the split sub-quote fetch so split analysis is correct on every chain — which
**activates split routing on Base** (previously dead, a net best-execution gain) — and lock it with the missing
URL-assertion test. No execution-gate or contract change.

## Requirements
1. In `useSplitRoute.ts` (~:106-113), add `chainId` to the sub-quote `URLSearchParams`. **Use the same active-chain
   source of truth #261 already threaded into this hook two lines below** — do not hardcode a chain, do not re-derive.
2. **Add the URL-assertion test that was missing** (the existing hook test never asserts the sub-quote fetch URL —
   that is how the bug survived): assert the sub-quote request carries the correct `chainId` — `8453` when the active
   chain is Base, `1` on mainnet.
3. **Verify the activation:** on Base, confirm the sub-quotes now resolve (no 502), `findBestSplit` can assemble a
   split, the 14-token same-address niche no longer mis-prices, and the 11 wasted rate-limited requests are gone.
4. **Confirm execution stays safe on the newly-live path:** add/confirm a test that a Base split executes with
   chain-correct `legMinOutput` (the execution path is already chain-aware per the triage — this guards the now-active
   Base split path against regression).

## Do NOT
- No execution-gate change (already chain-aware), no contract change, no on-chain change. Don't touch the #261
  `executable-sources` scoping beyond reading its chainId source. Don't hardcode a chain.

## Files affected (verify on main)
- `src/hooks/useSplitRoute.ts` (~:106-113 sub-quote fetch) + its test (add the fetch-URL/`chainId` assertions); a
  Base-split execution test if not already present.

## Expected output
- Branch `chore/splitroute-chainid` off latest `origin/main`; SSH-signed; CI green. The sub-quote fetch carries the
  active `chainId`; Base split routing assembles (no 502); the URL-assertion test locks the regression; a Base split
  executes with chain-correct `legMinOutput`. FEEDBACK: confirm Base split now fires + the wasted-request count → 0.

## Quality criteria
Split sub-quotes are priced on the active chain; split routing works on Base; the fetch-URL `chainId` is test-asserted
(regression-proof); execution stays chain-correct; zero execution-gate / contract change. (Behaviour change: Base split
routing is now **live** — a net best-execution gain, tested.)

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-SPLITROUTE-CHAINID per docs/Prompts/CHORE-SPLITROUTE-CHAINID.md. Branch
chore/splitroute-chainid off origin/main, SSH-signed (noreply committer), CI green.
Display/availability fix — NOT fund-flow (triage PR #262); no Auditor pass, no
execution-gate change, no contract change.

Context: src/hooks/useSplitRoute.ts:106-113 builds the split sub-quote
URLSearchParams WITHOUT chainId -> /api/quote (route.ts:177) applies its P217
mainnet default -> on Base the sub-quotes 502 (mainnet addresses) -> findBestSplit
map empty -> split routing is SILENTLY DEAD on Base (+11 wasted rate-limited reqs
per >$5k analysis; a 14-token same-address niche mis-prices). #261 already threaded
chainId into this same hook two lines below (for exec-source filtering) — the fetch
just wasn't updated. NOT fund-flow: execution (useSplitSwap) re-derives each leg
chain-aware (chainId-threaded /api/swap, legMinOutput from fresh toAmount, R1/sim
gates re-run).

Do:
1. In useSplitRoute.ts (~:106-113) add chainId to the sub-quote URLSearchParams,
   using the SAME active-chain source #261 already threaded into this hook two lines
   below. Do not hardcode / re-derive.
2. Add the URL-assertion test that was missing (the hook test never asserts the
   sub-quote fetch URL — how the bug survived): assert the sub-quote request carries
   chainId 8453 on Base, 1 on mainnet.
3. Verify activation on Base: sub-quotes resolve (no 502), findBestSplit assembles a
   split, the 14-token same-address niche no longer mis-prices, the 11 wasted
   rate-limited requests are gone.
4. Confirm execution safe on the now-live path: test a Base split executes with
   chain-correct legMinOutput (path already chain-aware — guard against regression).

Do NOT: change execution gates / contracts / on-chain; touch the #261
executable-sources scoping beyond reading its chainId source; hardcode a chain.

Files (verify on main): src/hooks/useSplitRoute.ts (~:106-113) + its test (fetch-URL
chainId assertions); a Base-split execution test if absent. FEEDBACK: confirm Base
split now fires + wasted-request count -> 0. Note the behaviour change: Base split
routing is now live.
```
