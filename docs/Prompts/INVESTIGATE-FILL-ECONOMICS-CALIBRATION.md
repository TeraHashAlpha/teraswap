# INVESTIGATE-FILL-ECONOMICS-CALIBRATION — measure gas-vs-fee economics of v3 fills and calibrate the owner's budget formula (READ-ONLY + report)

> **Source:** owner 2026-07-22. The first two production OE_V3 fills cost ~0.002 ETH (~$4) gas each vs
> $0.01-0.02 protocol fee. Before the keeper policy sprint (SPRINT-KEEPER-FILL-ECONOMICS, blocked on P1b),
> we need NUMBERS: where does the gas actually go, how much does a compact canonical route save, and what
> defaults make the owner's formula (`gas ≤ chunkBudget − fee`, budget = signed maxSlippageBps × notional)
> viable at which chunk sizes. READ-ONLY on the repo; on-chain reads + local estimation only; deliverable =
> `docs/Reports/FILL-ECONOMICS-CALIBRATION.md`. No code changes, no txs, no env changes.

## Requirements
1. **Decompose the two real fills** (OE_V3 Base txs at blocks 48934744 and 48934819, resolve hashes from
   chain): L2 execution gas vs L1 data fee (Base receipt fields l1Fee/l1GasUsed etc.), calldata size of the
   Velora route, gas price context. State the % of cost that is L1 data fee.
2. **Estimate the compact alternative:** build (locally, no sending) a canonical SwapRouter02
   exactInputSingle calldata for the same WETH→USDC fills; estimate via eth_estimateGas + current Base L1
   fee params what the SAME fill would have cost. Table: aggregator route vs canonical route, absolute $ and
   ratio. Also sample 2-3 other pairs/sizes ($10/$100/$1000 chunks).
3. **Price-delta cost:** for those samples, quote both routes (existing quote infra or direct QuoterV2
   reads) and quantify the user-output delta between best aggregated route and canonical UniV3 — the
   "worse price" the owner accepts in exchange for low gas. Express in bps and $.
4. **Calibrate the formula:** table of chunk sizes ($10-$5000) × route type → gas$, fee$ (0.1%), minimum
   maxSlippageBps budget needed for `gas ≤ budget − fee`; mark the viability frontier. Recommend: default
   budget presets for the DCAPanel UX ($ and bps), a MIN_ORDER_AMOUNT/chunk recommendation for DCA public
   go-live, and the defer-window default for the keeper gate. Note Base gas volatility (sample l1 fee at a
   few times if possible).
5. Write the report; ≤3 pages, every number sourced (tx/block/method).

## Do NOT
Change any code/config; send any transaction; touch envs; open a PR (branch `report/fill-economics` +
compare link; owner opens).

## Expected output
Branch + compare link. FEEDBACK ≤1 screen: the headline decomposition (L1 share), aggregator-vs-canonical
cost ratio, the viability frontier line, and the three recommended defaults.
