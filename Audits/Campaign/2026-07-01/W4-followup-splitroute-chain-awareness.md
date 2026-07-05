# W4 follow-up — useSplitRoute chain-awareness triage (READ-ONLY)

> **Campaign:** T-SAF 2026-07-01 · **Packet:** `docs/Prompts/INVESTIGATE-SPLITROUTE-CHAIN-AWARENESS.md`
> (source: PR #261 FEEDBACK) · **Runner:** Auditor (read-only) · **Executed:** 2026-07-05.
> **Baseline:** `origin/main` = `b600a0511d490fbd5d2b4529ef48de584e354954` (post-#261).
> **Zero changes:** no code, no behaviour, no execution-path change — code reads + two read-only prod
> HTTP probes only.

## Verdict

**CONFIRMED — but display/feature-availability class, NOT fund-flow.** `useSplitRoute`'s sub-leg quote
fetch omits `chainId`, so every sub-amount quote is priced on **mainnet** regardless of the active
chain. On Base the dominant symptom is not mis-pricing but **silent feature death**: the mainnet
lookup of Base token addresses fails (502) → the sub-quote map stays empty → `findBestSplit` can never
assemble a split → **split routing never fires on Base**. A narrow same-address-token niche (14
tokens) can instead produce genuinely mis-priced analyses. Execution safety is intact in every path —
no Auditor pass needed for the fix.

## 1. Root cause — the `chainId` drop, file:line

| Step | Location | What happens |
|------|----------|--------------|
| Sub-quote request built WITHOUT `chainId` | **`src/hooks/useSplitRoute.ts:106-112`** | `fetchQuoteAtAmount` builds `URLSearchParams` with `src/dst/amount/srcDecimals/dstDecimals` only |
| Request sent | **`src/hooks/useSplitRoute.ts:113`** | `fetch('/api/quote?' + params)` |
| Server: absent param → `undefined` | `src/app/api/quote/route.ts:177` | `chainIdParam ? Number(chainIdParam) : undefined` |
| Mainnet default applied | `src/lib/api.ts:106-108` | `fetchMetaQuote(..., chainId?)` — “[P217] Omitted → mainnet (DEFAULT_CHAIN_ID)” |

The bitter irony: PR #261 threaded `chainId` **into this very hook** (`useSplitRoute.ts:51`) and uses
it for executable-source filtering (`:116`, `:126`) — but the fetch two lines above was never
threaded. The top-level quote is NOT affected: `useQuote.ts:63` sets `chainId` correctly, so the
displayed single-source best is always chain-correct.

## 2. Base reproduction (read-only, prod, 2026-07-05)

Exact request shape `fetchQuoteAtAmount` emits for a Base WETH→USDC split leg (50% of 2 WETH):

```
GET https://www.teraswap.app/api/quote?src=0x4200…0006&dst=0x8335…2913
    &amount=1000000000000000000&srcDecimals=18&dstDecimals=6        ← NO chainId
→ observed: HTTP 502 "error code: 502"          (Base addresses priced on MAINNET → all adapters fail)
→ expected: a Base-priced quote set

CONTROL — identical request + &chainId=8453:
→ observed: 200, best=velora 1774003033, responders [velora, kyberswap, cowswap,
            sushiswap, openocean, uniswapv3]     (chain-aware path fully works)
```

`useSplitRoute.ts:114` turns the 502 into `[]` (`if (!res.ok) return []`), `split-router.ts:76-78`
silently swallows failures, and `findBestSplit` (`split-router.ts:113-115`) requires a sub-percent
quote from BOTH legs of every combo — with only the 100% seeds present, **no split can ever beat the
single route**. Observed chain: 1. Expected: 8453. Reproduced.

## 3. Blast radius

Split analysis is **enabled on Base** — `SwapBox.tsx:252` gates only on `isConnected &&
isCorrectChain` and passes `activeChainId`; `SPLIT_MIN_USD = 5_000`, `SPLIT_MIN_IMPROVEMENT_BPS = 10`.
Only chains 1 + 8453 are live today.

| Chain × pair class | Analysis outcome | Displayed? | Executed? |
|--------------------|------------------|-----------|-----------|
| Mainnet (any pair) | ✅ correct — the missing param defaults to 1 = the active chain | correct | correct |
| **Base, ≥1 token address not on mainnet** (the overwhelming majority — canonical WETH/USDC/…) | sub-fetches 502 → **split silently never recommended** | nothing wrong shown (no fake savings) — the feature is just **dead** | never reached |
| **Base, BOTH tokens same-address on both chains** (niche: **14 catalog tokens** incl. the native-ETH sentinel `0xeeee…`, cbBTC `0xcbb7…33bf`, USDe-family `0x6985…71cd` — e.g. an ETH↔cbBTC split) | sub-legs get REAL **mainnet** prices/liquidity → analysis mis-priced | **wrong "you save X bps" + wrong ratios can display** | a split CAN execute — with suboptimal (mainnet-derived) leg ratios; **safety intact, see below** |
| Side cost (every Base trade ≥ $5k) | **11 doomed mainnet requests per analysis** (unique sub-percents of `SPLIT_CONFIGS_2WAY`+`_3WAY`: 15,20,25,30,33,34,40,50,60,70,80) | — | burns the per-IP `/api/quote` rate-limit budget + server load for nothing |

**Critical fork resolved — split routes DO execute** (`useSplitSwap.execute`, multi-leg, 9R two-phase
review), **but the analysis quote cannot contaminate execution safety**:

- Each leg is **re-built fresh** via `/api/swap` **with the active chainId** (`useSplitSwap.ts:103-108`,
  hook reads its own `useActiveChainId()` at `:162`) → router/calldata/recipient are chain-correct and
  server-gated (SC-04 + R1).
- `legMinOutput` derives from the **fresh build's** `swapData.toAmount` (`useSplitSwap.ts:360-362`),
  never from the mainnet-priced analysis quote (W2-L-01 refusal on unusable amounts applies).
- Client re-gates every leg: selector allowlist (`:306`), recipient-vs-wallet with chainId (`:311`),
  per-leg chainId-threaded simulation (`:327-339`).
- The analysis quote feeds only: leg **ratios** (`legAmount = totalRaw × percent/100`, `:268`), the
  displayed savings, and the fee-integrity heuristic (`:316-321`) — whose failure direction is
  fail-closed (leg refused, availability not funds).

So the worst executable outcome is a **suboptimally-ratioed but fully-gated** split in the 14-token
niche — execution *quality*, not fund-flow safety.

## 4. Cross-check vs `c8ca8b1` (SPRINT-9C) and #261

**Distinct mechanism, same chain-awareness class.** `c8ca8b1` fixed the SERVER side: on-chain
adapters resolving `getRpcUrl()` non-chain-aware (mainnet eth_calls for Base quotes) →
`getRpcUrlForChain()` + per-chain Uniswap deployments. This bug is a CLIENT call site omitting the
`chainId` query param, colliding with the deliberate P217/P219 back-compat contract (“absent →
mainnet”) on `/api/quote` — i.e. a **missed call site of the P217/P219/P221 chain-threading
program**, not a regression of `c8ca8b1`. The same P221 pass that fixed `useSplitSwap`'s build/sim
calls (`43-I-01`) never reached `useSplitRoute`'s analysis fetch.

**#261 interaction:** the `executable-sources` scoping now correctly filters sub-quote candidates by
the ACTIVE chain (`useSplitRoute.ts:116`, `:126`) — on Base it filters mainnet-priced quotes by Base
executability: moot for the 502-majority, mildly corrective in the same-address niche (quote-only
sources can't become legs). No conflict with the fix.

## 5. Severity + scoped fix recommendation

**Severity: MEDIUM (display / feature-availability).** (a) Split best-execution — the headline
feature for >$5k trades — is silently dead on Base; (b) the 14-token same-address niche can display
wrong savings and execute suboptimal ratios; (c) 11 wasted rate-limited requests per Base analysis.
**Not execution/fund-flow-affecting** (all execution inputs re-derived chain-aware; gates intact) —
**no Auditor pass required**; standard Code Agent gate (branch + CI green) suffices.

**Scoped fix (1 line + tests), for a follow-up prompt:**
- `useSplitRoute.ts` `fetchQuoteAtAmount`: thread the hook's existing `chainId` param —
  `if (chainId !== DEFAULT_CHAIN_ID) params.set('chainId', String(chainId))` (conditional keeps the
  mainnet request byte-identical, the established P217 convention).
- Tests: (1) sub-quote URL carries `chainId=8453` when the hook is driven with Base (mock fetch,
  assert query — the existing `useSplitRoute.test.ts` never asserts the URL, which is how this
  survived); (2) mainnet drive → no `chainId` param (byte-identity pin).
- Optional hardening (Architect judgement): the P219 absent→mainnet default converts a missing param
  from an internal caller into silent wrong-chain behaviour — consider a server-side log/metric when
  a same-origin caller hits `/api/quote` without `chainId`.

## FEEDBACK

- **Severity: MEDIUM, display/availability** (silent Base feature-death + niche mis-display + wasted
  rate-limit); **not fund-flow** — execution re-derives every safety-relevant input chain-aware.
- **A follow-up fix prompt IS warranted**: one-line thread + two URL-assertion tests restores split
  best-execution on Base; high value/effort ratio. Suggested name: `CHORE-SPLITROUTE-CHAINID`.
  Standard gate (no Auditor pass). Include the `useSplitRoute.test.ts` URL-assertion gap closure.

## Boundaries

Read-only: code reads on the pinned baseline + 2 read-only prod GET probes (shown verbatim in §2).
No code/behaviour/execution change; no on-chain interaction; no secrets involved.
