# SPRINT-9E — Base/mainnet UI parity (Compare list, all sources, 0x, USD costs)

Follow-up to INC-2026-05-31-001 (the 502 is fixed; the Base swap experience is not at parity with
mainnet). Atomic, signed commits. **Mainnet is the correct reference — do not change it; make Base
match it.**

## Problem (corrected, with evidence)

- **Mainnet (reference, correct):** swap UI shows the full **Compare** list — Uniswap V3, Velora,
  KyberSwap, CoW — each with output and a USD delta vs best; gas + platform fee shown in ETH + USD.
- **Base (wrong):** swap UI shows only **Uniswap V3** with a "Direct DEX" badge — no Compare list,
  gas in raw gas units, no USD.
- **The backend already returns multiple sources on Base:** a direct
  `GET /api/quote?src=0x4200000000000000000000000000000000000006&dst=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=1000000000000000000&srcDecimals=18&dstDecimals=6&chainId=8453`
  returns `all` = [kyberswap, velora, cowswap]. So the **frontend** is not rendering the meta-quote
  Compare on Base — it appears to use a single-source "Direct DEX" path. Plus 0x and other sources
  are missing from `all`, and USD isn't shown on Base.

The UI and quote experience must be **identical on every chain**.

## Goal

On Base, the swap UI renders exactly like mainnet: the full Compare list of every source that has a
real route, ranked, with USD deltas, and gas + platform fee in ETH + USD. 0x and the other
aggregators return on Base. No chain-specific "Direct DEX" single-source fallback.

## Workflow (in order; do not skip Phase 1)

### Phase 1 — Locate the divergence (frontend vs backend), no guessing
1. **Frontend path:** find the swap quote hook/component (e.g. `src/hooks/useQuote.ts`,
   `useSwap.ts`, and the quote/Compare UI component). Determine why Base renders a single "Direct
   DEX" source instead of the meta-quote Compare. Look for any `chainId`-conditional that switches
   Base to a direct on-chain Uniswap path or hides the Compare list / source rows off-mainnet.
2. **Backend coverage:** run the admin `&debug=sources` diagnostic for Base (WETH→USDC and native
   ETH→USDC); record each source's exact status/error. Establish which of the 11 truly return on
   Base vs error (0x, OpenOcean, SushiSwap, Balancer, 1inch, Odos).
3. **USD path:** find where mainnet computes gas-USD and platform-fee-USD for the UI, and why Base
   doesn't (missing ETH/USD price source for Base? gas shown as raw units?).
Commit a short findings note (frontend cause + per-source table) to FEEDBACK.md before fixing.

### Phase 2 — UI parity (primary)
- Make the Base swap UI consume the **same meta-quote response and Compare renderer** as mainnet.
  Remove/!disable any Base-only single-source "Direct DEX" path. Same component, chain-aware data.
- The Compare list on Base must list every returning source with output + USD delta vs best,
  identical layout to mainnet.

### Phase 3 — Source breadth on Base (0x is priority)
- Fix the missing adapters so they return on Base (or cleanly return null only when a pair has no
  real route). **0x first** — same `ZEROX_API_KEY` works on mainnet; on Base, 0x v2 uses the
  AllowanceHolder (`0x0000000000001fF3684f28c67538d4D072C22734`, already whitelisted) + `chainId`
  query param. Then OpenOcean / SushiSwap / Balancer (keyless) and 1inch / Odos. Drive each fix
  from the Phase-1 error, not assumptions.

### Phase 4 — USD costs on Base (parity)
- Show estimated gas in **ETH + USD** and platform fee in **ETH + USD** on Base, reusing the
  mainnet mechanism made chain-aware (ETH is the native token on Base too; use the Base gas price +
  an ETH/USD source). No raw-gas-units display.

### Phase 5 — Verify
- Base `&debug=sources`: recovered sources incl. 0x. Base swap UI: full Compare list + USD,
  visually identical to mainnet for the same pair. Mainnet unchanged (test-guarded).

## Do NOT
- Do NOT change the mainnet UI or quote behaviour — Base must converge to it.
- Do NOT keep any chain-specific single-source "Direct DEX" rendering path.
- Do NOT fabricate quotes; a source with no real route simply doesn't appear.
- Do NOT bypass Chainlink/cross-quote validation or the router whitelist; keep keys server-only.

## Expected output / tests
- One shared, chain-aware Compare UI; Base reaches mainnet parity (sources + USD).
- 0x returns on Base; FEEDBACK.md has the Phase-1 per-source table + frontend root cause.
- Tests: Base meta-quote renders >1 source in Compare (mocked), gas/fee USD formatter is
  chain-aware, 0x Base adapter parsing. CI green; signed commits.
- **Verify on the Vercel PREVIEW (Base UI parity + debug=sources) BEFORE promoting to production.**
