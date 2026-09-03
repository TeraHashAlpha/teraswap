# TeraSwap on DefiLlama — the listing is LIVE, and this is the follow-up PR

TeraSwap is a DEX **meta-aggregator**: swaps route through other DEXes' routers and funds never
sit in a TeraSwap contract, so on-chain TVL is **~0 by design**. The listing is volume + fees via
[`DefiLlama/dimension-adapters`](https://github.com/DefiLlama/dimension-adapters) — **not** the
`DefiLlama-Adapters` TVL repo.

## Where the adapter actually lives upstream

**`aggregators/teraswap/index.ts`** — merged 2026-07-09, category `aggregators`, TypeScript
`SimpleAdapter` `version: 2`, `pullHourly: true`.

Not `dexs/teraswap/index.js`. The earlier draft in this directory (`teraswap.js`) still describes
that path and is now `@deprecated`; it is kept, never deleted (CLAUDE.md rule #4). The file to
work from is **`teraswap.ts`** in this directory — an in-repo mirror of the merged upstream file,
so the adapter can be diffed and unit-tested here before anything is pasted upstream.

## Two defects in the LIVE adapter, and what this fixes

### 1. Arbitrum One is missing — six weeks of volume and fees reporting as zero

The live adapter configures `CHAIN.ETHEREUM` and `CHAIN.BASE` only. Arbitrum One's FeeCollector
flipped to production **2026-07-20**, eleven days *after* the upstream merge, so it was never in
scope for that PR. A chain with no entry does not error — it reports zero.

`teraswap.ts` adds `CHAIN.ARBITRUM`. Every address in it was **extracted** from the table in
`docs/DEPLOYMENTS.md` qualified by chain, never hand-typed, and verified with `eth_getCode` on
its own chain (measured 2026-09-03):

| Chain | `docs/DEPLOYMENTS.md` row | Address | Length | `eth_getCode` | RPC |
|---|---|---|---|---|---|
| Ethereum (1) | **FeeCollector V2** (instant swaps) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | 42 | 5,419 B | `ethereum-rpc.publicnode.com` |
| Base (8453) | **FeeCollector** (instant swaps) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | 42 | 5,339 B | `mainnet.base.org` |
| Arbitrum One (42161) | **FeeCollector** (instant swaps) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | 42 | 5,339 B | `arb1.arbitrum.io/rpc` |

Base and Arbitrum share a 42-char string. That is a deployer-nonce collision, **not** one
deployment: the same address is a different contract on different chains (`docs/DEPLOYMENTS.md`,
"⚠️ Key gotcha — same address, different contract per chain"). Each entry was verified on its own
chain in its own right, and mainnet is a different address entirely — the negative control.

**The Arbitrum `start` is derived, not typed.** `eth_getLogs` over the full history of chain
42161, filtered to that address and `topic0`
`0x2a90a68b9cbf4190c9d99142f26df926cebcfd5d9d5c3594c691f188b0adf060`, returns the first
`SwapWithFee` at **block 484,739,263**, tx
`0xfa0dfc578960f7d720572de5d451ede06be38cc78ed2c39e00376b1cef4a658c`, block timestamp
`1784275673` = **2026-07-17T08:07:53Z**. The RPC accepted an unbounded range, so no fallback to
the doc's 2026-07-20 prod-flip date was needed — and the derived date matters, because the flip
date is three days *later* and would have dropped the fills before it. `start: '2026-07-17'`.

That `topic0` is `keccak256` of the **7-argument** signature
`SwapWithFee(address,address,address,uint256,uint256,address,uint256)` — the same value
`TOPICS.SwapWithFee` in `src/lib/on-chain-monitor.ts` keys off, and the same topic0 carried by the
single FeeCollector log in the Arbitrum fee tx recorded in `docs/DEPLOYMENTS.md`
(`0xf14b181b91f1b3274fdaa19248d7619acadd21f0666cfbfbede40bdb660927b2`, block 485,946,212, status
`0x1`). A 5-argument `SwapWithFee` hashes to `0xe41d09ea…` and does not match — the control
against decoding a truncated ABI.

### 2. `methodology.Volume` claims coverage the event source does not have

The live text calls the FeeCollector *"the single contract every TeraSwap swap routes
fee-collection through"*. It is not. The sources in `FEE_INCOMPATIBLE_SOURCES`
(`src/lib/constants.ts`) collect the identical 0.1% through their **own partner-fee parameters**
— they never touch the FeeCollector and emit no `SwapWithFee` — so this adapter cannot see them.
At least one is live and quoting today. The claim overstates what the number covers.

`teraswap.ts` renders the excluded names from that same list rather than restating them in prose,
and `__tests__/defillama-teraswap-adapter.test.ts` asserts the list equals
`FEE_INCOMPATIBLE_SOURCES` — so the paragraph cannot drift out of date silently.

`Fees`, `Revenue` and `ProtocolRevenue` wording is **unchanged** from what is live.

## Pasting it upstream

1. Fork `DefiLlama/dimension-adapters` and open `aggregators/teraswap/index.ts`.
2. Copy the body of `teraswap.ts` over it, then make these three mechanical edits — they exist
   only because this repo has no dimension-adapters SDK to import:
   - delete the block fenced `── IN-REPO SHIM ──` … `── END IN-REPO SHIM ──` and restore the
     three imports it names (`FetchOptions`/`SimpleAdapter`, `CHAIN`, `METRIC`);
   - drop the `export` keyword from `SWAP_WITH_FEE_EVENT`, `EXCLUDED_SOURCES` and
     `EXCLUDED_SOURCE_LABELS` (they are exported here only so the tests can assert on them);
   - drop the in-repo-only header comment block if the maintainers prefer a lean file — the
     per-address source comments should stay, CodeRabbit asked for exactly that provenance
     upstream.
3. The three `chainConfig` entries, the `fetch` body, `methodology` and `breakdownMethodology`
   need **no** change — they are already in the merged file's shape.
4. Run that repo's harness for the adapter per its CONTRIBUTING guide and confirm Arbitrum
   returns non-zero volume for a day on or after 2026-07-17.
5. Open the PR with the paragraph below.

## For the upstream PR description

> **Add Arbitrum One, and stop overstating what Volume covers.**
>
> TeraSwap's FeeCollector went to production on Arbitrum One (42161) on 2026-07-20, eleven days
> after this adapter merged, so Arbitrum volume and fees have been reporting as zero ever since.
> This adds the chain. The FeeCollector there is `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`
> (5,339 bytes of code on chain 42161) — the same string as the Base entry, which is a
> deployer-nonce collision and not the same deployment; each address was verified with
> `eth_getCode` on its own chain. `start` is derived from the first `SwapWithFee` log at that
> address on 42161: block 484,739,263, 2026-07-17T08:07:53Z.
>
> It also corrects `methodology.Volume`. The current text describes the FeeCollector as the single
> contract every TeraSwap swap routes fee-collection through. That is not accurate: routes filled
> by 0x, CoW Swap and Bebop take the identical 0.1% through those venues' own partner-fee
> parameters, emit no `SwapWithFee`, and are therefore not counted by this adapter. The new text
> says so explicitly and names them, so the reported figure is understood as a floor rather than a
> total. Fees, Revenue and ProtocolRevenue are unchanged.

### Volume methodology, verbatim as the adapter renders it

> Sum of totalAmount (the pre-fee swap notional a user commits, in tokenIn) from every SwapWithFee
> event emitted by the TeraSwapFeeCollector proxy, the contract that collects the 0.1% on-chain
> before the trade is forwarded to the underlying DEX router. Not all TeraSwap volume reaches that
> contract: routes filled by 0x, CoW Swap and Bebop collect the identical 0.1% through those
> venues' own partner-fee parameters instead of the FeeCollector, emit no SwapWithFee event, and
> are therefore NOT counted here.
