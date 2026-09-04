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
work from is **`teraswap-adapter.ts`** in this directory — an in-repo mirror of the merged upstream
file (the name deliberately differs from the `.js` draft, so no extensionless import can resolve to
the wrong one),
so the adapter can be diffed and unit-tested here before anything is pasted upstream.

## Two defects in the LIVE adapter, and what this fixes

### 1. Arbitrum One is missing — a live chain configured as if it did not exist

The live adapter configures `CHAIN.ETHEREUM` and `CHAIN.BASE` only. Arbitrum One has been emitting
`SwapWithFee` since **2026-07-17**, after the 2026-07-09 upstream merge, so the chain was never in
scope for that PR. A chain with no entry does not error — it reports zero.

**How much volume is actually missing: very little.** Chain 42161 has emitted **five**
`SwapWithFee` events in total — one on 2026-07-17, two on 2026-07-20, two on 2026-08-03 — and none
since (checked against head block 501,410,306, 2026-09-03T18:46Z). This is a configuration error
being corrected so a live chain stops reading as zero, not the recovery of six weeks of unreported
trading.

`teraswap-adapter.ts` adds `CHAIN.ARBITRUM`. Every address in it was **extracted** from the table in
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
date is three days *later* and would silently drop the first of those five events.
`start: '2026-07-16'` — the day *before* that first log, for the run-gate reason in
[§ `start` is a run gate](#start-is-a-run-gate-not-a-provenance-note). (`docs/DEPLOYMENTS.md` now
carries this first-log line on its Arbitrum FeeCollector row, so the doc and the chain no longer
disagree.)

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

`teraswap-adapter.ts` renders the excluded names from that same list rather than restating them in prose,
and `__tests__/defillama-teraswap-adapter.test.ts` asserts the list equals
`FEE_INCOMPATIBLE_SOURCES` — so the paragraph cannot drift out of date silently.

`Fees`, `Revenue` and `ProtocolRevenue` wording is **unchanged** from what is live.

### 3. Mainnet counts only the live V2 FeeCollector — the frozen V1 contract's history is invisible

Mainnet had a FeeCollector before V2: `docs/DEPLOYMENTS.md`'s "FeeCollector V1 (frozen)" row,
`0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` — "deprecated, do not route here" for new swaps, but
its 14 historical `SwapWithFee` logs (2026-03-04 through 2026-04-24) are real settled volume and
predate V2's own first log (2026-05-26) by 83 days. The live adapter only reads V2's address and
event shape, so this entire pre-V2 window — TeraSwap's first six weeks on mainnet — reads as zero.

V1 emits a narrower, 5-argument `SwapWithFee(address,address,address,uint256,uint256)` — topic0
`0xe41d09ea59537dbbeb0d52b509aff6db0348253cb4f871b7d2c163002576c042` — instead of V2's 7-argument
form. `tokenIn`, `totalAmount` and `feeAmount` sit in the same three positions in both (confirmed
against `contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol`, V1's actual source), so
`teraswap-adapter.ts` decodes both into the same log shape and sums them: it issues a second
`getLogs` on chain 1, against V1's own address (`legacyFeeCollector` in `chainConfig`) and its own
event ABI, and folds the result into the same `dailyVolume`/`dailyFees` as V2. V1's address and
topic0 both differ from V2's, so a V2 log can never satisfy V1's filter or vice versa —
`__tests__/defillama-teraswap-adapter.test.ts` asserts both differences as a structural
double-counting guard, not a comment.

Mainnet's `start` changes accordingly: it now derives from V1's first log (2026-03-04) rather than
the previously configured 2026-05-08, which was neither V1's nor V2's real first log (V2's is
2026-05-26). **Mainnet total: 37** — 14 from V1, 23 from V2.

### `start` is a run gate, not a provenance note

The first cut of this change set each chain's `start` to the exact UTC day of its own first log —
mainnet `2026-03-04`, Base `2026-06-04`, Arbitrum `2026-07-17`. Measured against DefiLlama's own
harness on 2026-09-04, **that zeroed the opening day of every chain**, including Base's, which the
live upstream file reports as `2.71k`.

The mechanism is one line of upstream code, not anything in `fetch`. `setChainValidStart` in
`adapters/utils/runAdapter.ts` admits a chain to the slot ending at `endTimestamp` only when
`start <= endTimestamp - 86400`, and because this adapter is `pullHourly: true`, the runner splits
each day into 24 one-hour slots (`runHourlyMultiSlot`, `cli/testAdapter.ts`). A `start` equal to the
day being measured clears that test only for the final slot, 23:00–00:00 UTC, and the chain is
skipped for the other 23 hours. Every one of these chains emitted its first log in the morning, so
each opening day read `0.00`.

So each `start` is the day **before** its first log: mainnet `2026-03-03`, Base `2026-06-03`,
Arbitrum `2026-07-16`. The extra day holds no logs and sums to zero, and the first-log block, tx and
timestamp stay recorded verbatim per chain, so the derivation is still checkable.
`__tests__/defillama-teraswap-adapter.test.ts` asserts the gate arithmetic directly and keeps the
three rejected same-day values as a negative control.

## Pasting it upstream

1. Fork `DefiLlama/dimension-adapters` and open `aggregators/teraswap/index.ts`.
2. Copy the body of `teraswap-adapter.ts` over it, then make these three mechanical edits — they exist
   only because this repo has no dimension-adapters SDK to import:
   - delete the block fenced `── IN-REPO SHIM ──` … `── END IN-REPO SHIM ──` and restore the
     three imports it names (`FetchOptions`/`SimpleAdapter`, `CHAIN`, `METRIC`);
   - drop the `export` keyword from `SWAP_WITH_FEE_EVENT`, `SWAP_WITH_FEE_EVENT_V1`,
     `EXCLUDED_SOURCES` and `EXCLUDED_SOURCE_LABELS` (they are exported here only so the tests can
     assert on them);
   - drop the in-repo-only header comment block if the maintainers prefer a lean file — the
     per-address source comments should stay, CodeRabbit asked for exactly that provenance
     upstream.
3. The `chainConfig` entries, the `fetch` body, `methodology` and `breakdownMethodology` need
   **no** change — they are already in the merged file's shape (`fetch`'s second, conditional
   `getLogs` call for mainnet's `legacyFeeCollector` is ordinary control flow, not a shape change).
4. **Run DefiLlama's harness — the mandatory protocol in the next section. This is not optional and
   the in-repo suite does not substitute for it.**
5. Open the PR with the paragraph below.

## MANDATORY — run DefiLlama's own harness before submitting

**A green in-repo vitest suite is NOT evidence that this adapter works.** Every guard in
`__tests__/defillama-teraswap-adapter.test.ts` and `__tests__/defillama-upstream-artifact.test.ts`
tests the artifact's *form* — addresses against the deployments doc, topic0 hashes, methodology
prose, generator drift, TypeScript compilation. None of them can run DefiLlama's SDK, so none of
them observe what the adapter **returns**. PR #476 shipped behind a fully green suite and zeroed the
Base chain; the suite noticed nothing, because there was nothing in it that could.

The only evidence that counts is DefiLlama's own runner, on all four dates below, for **both** the
current upstream file (the baseline) and our artifact, compared cell by cell.

### 1. Clone and install — in a scratch dir, never in this repo

```bash
cd /tmp && rm -rf dimension-adapters
git clone --depth 1 https://github.com/DefiLlama/dimension-adapters.git
cd /tmp/dimension-adapters && pnpm i
```

Never commit anything into that clone, and never clone it under this repo.

### 2. Baseline FIRST — what their file returns today, untouched

```bash
cd /tmp/dimension-adapters
cp aggregators/teraswap/index.ts /tmp/baseline-teraswap-index.ts   # keep it to restore later
for d in 2026-03-05 2026-05-27 2026-06-05 2026-07-18; do
  echo "===== baseline @ $d ====="
  pnpm test aggregators teraswap "$d"
done
```

Record the per-chain rows under `TOTAL DAILY AGGREGATED`. Runs where only one chain is eligible
print a single `ETHEREUM 👇` block instead of a table — read that as the ethereum row.

### 3. Then ours — the generated artifact, same four dates

```bash
cd /tmp/dimension-adapters
cp /path/to/teraswap/integrations/defillama/upstream/index.ts aggregators/teraswap/index.ts
for d in 2026-03-05 2026-05-27 2026-06-05 2026-07-18; do
  echo "===== ours @ $d ====="
  pnpm test aggregators teraswap "$d"
done
```

Paste the **generated** `upstream/index.ts`, never `teraswap-adapter.ts` — the mirror still carries
the in-repo shim. Regenerate it first with `npm run build:defillama`.

### 4. The dates — and why these four

**The date argument is the END of the window: date `D` measures the day `D-1`.** Get this wrong and
every number moves by a day.

| date arg | day measured | what it proves |
|---|---|---|
| `2026-03-05` | 2026-03-04 | mainnet's V1-only window: the frozen V1 contract emitted 2 `SwapWithFee` logs that day, 83 days before V2 existed. Non-zero here is the whole point of the V1 read. |
| `2026-05-27` | 2026-05-26 | V2's own first log day. Mainnet must be unchanged from baseline — the control that the V1 read did not disturb V2. |
| `2026-06-05` | 2026-06-04 | **Base's opening day — the regression canary.** Baseline reports `2.71k`; anything less is a regression. |
| `2026-07-18` | 2026-07-17 | Arbitrum's opening day. Baseline cannot see the chain at all; ours must report it non-zero. |

### 5. The comparison — measured 2026-09-04

| date arg | baseline (their live file) | #476 as shipped (the regression) | ours, fixed |
|---|---|---|---|
| `2026-03-05` | no chain eligible — nothing reported | ethereum `0.00` | ethereum **`13.00`** (fees `0.0128` ≈ 0.1%) |
| `2026-05-27` | ethereum `24.00` | ethereum `24.00` | ethereum `24.00` |
| `2026-06-05` | ethereum `294.00` · base **`2.71k`** · Aggregate `3.00k` | ethereum `294.00` · base **`0.00`** · Aggregate `294.00` | ethereum `294.00` · base **`2.71k`** · Aggregate `3.00k` |
| `2026-07-18` | ethereum `900.00` · base `0.00` · Aggregate `900.00` | ethereum `900.00` · base `0.00` · arbitrum **`0.00`** · Aggregate `900.00` | ethereum `900.00` · base `0.00` · arbitrum **`0.56`** · Aggregate `900.56` |

### 6. The rules

- **A chain reading `0.00` where the baseline reads non-zero is a regression. Stop and fix it — do
  not submit, and do not explain it away as rounding.**
- Every chain in ours must be **at or above** its baseline cell on every date. Ours may add chains
  and add history; it may never subtract either.
- Mainnet's V1-only window must be non-zero, and its fees must land near 0.1% of its volume — that
  ratio is what confirms the 5-argument decode put `totalAmount` and `feeAmount` in the right slots
  rather than merely returning *some* number.
- A cell that changes for a reason you cannot name is a finding, not noise.
- Diagnostic, not a fix: `DISABLE_PULL_HOURLY=true pnpm test aggregators teraswap <date>` runs the
  same file as a single daily window instead of 24 hourly slots. If a chain is non-zero there and
  zero without it, the fault is the `start` run gate, not `fetch`.
- Restore their file (`cp /tmp/baseline-teraswap-index.ts aggregators/teraswap/index.ts`) before
  re-running a baseline, so a stale paste never gets mistaken for one.

## For the upstream PR description

> **Count mainnet's pre-V2 history, add Arbitrum One, and stop overstating what Volume covers.**
>
> TeraSwap's mainnet FeeCollector was redeployed once: a frozen V1 contract
> (`0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`) ran from 2026-03-04 to 2026-04-24 (14
> `SwapWithFee` events) before the current V2 contract took over. This adapter has only ever read
> V2, so mainnet's first six weeks read as zero. V1 emits a narrower 5-argument `SwapWithFee`
> (`tokenIn`/`totalAmount`/`feeAmount` in the same positions as V2's 7-argument form); the adapter
> now issues a second `getLogs` against V1's address and event shape on mainnet only, and sums it
> into the same totals as V2. Mainnet's `start` now derives from V1's first log, 2026-03-04.
> Mainnet total to date: 37 events (14 from V1, 23 from V2).
>
> Each `start` is set to the day *before* its chain's first log rather than to that day itself.
> `setChainValidStart` admits a chain to an hourly slot only when `start <= endTimestamp - 86400`,
> so with `pullHourly: true` a `start` equal to the day being measured runs only the 23:00–00:00
> slot and the chain reports zero for its own opening day. All three of these chains emitted their
> first log in the morning. The skipped day is empty by construction, so nothing is over-claimed.
>
> It also adds Arbitrum One (42161): its FeeCollector has been emitting `SwapWithFee` since
> 2026-07-17, after this adapter merged, so Arbitrum has been reporting as zero ever since. The
> amounts are small — five events to date, the last on 2026-08-03 — so this is a correctness fix
> rather than a material restatement. The FeeCollector there is
> `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` (5,339 bytes of code on chain 42161) — the same
> string as the Base entry, which is a deployer-nonce collision and not the same deployment; each
> address was verified with `eth_getCode` on its own chain. `start` is derived from the first
> `SwapWithFee` log at that address on 42161: block 484,739,263, 2026-07-17T08:07:53Z. Base's
> `start` is likewise derived from its first `SwapWithFee` log rather than its deploy date. Base's
> reported figures are unchanged from what this adapter returns today — verified against this
> repo's harness on 2026-03-05, 2026-05-27, 2026-06-05 and 2026-07-18.
>
> Finally it corrects `methodology.Volume`. The current text describes the FeeCollector as the
> single contract every TeraSwap swap routes fee-collection through. That is not accurate: routes
> filled by 0x, CoW Swap and Bebop take the identical 0.1% through those venues' own partner-fee
> parameters, emit no `SwapWithFee`, and are therefore not counted by this adapter. The new text
> says so explicitly, names them, and notes that mainnet now aggregates both FeeCollector
> deployments — so the reported figure is understood as a floor rather than a total, with mainnet's
> history continuous rather than starting at the V2 cutover. Fees, Revenue and ProtocolRevenue are
> unchanged.

### Volume methodology, verbatim as the adapter renders it

> Sum of totalAmount (the pre-fee swap notional a user commits, in tokenIn) from every SwapWithFee
> event emitted by the TeraSwapFeeCollector proxy, the contract that collects the 0.1% on-chain
> before the trade is forwarded to the underlying DEX router. On Ethereum mainnet this aggregates
> both FeeCollector deployments — the frozen V1 contract and the live V2 contract that replaced
> it — so mainnet's reported history is continuous back to TeraSwap's first on-chain swap rather
> than starting at the V2 cutover. Not all TeraSwap volume reaches that contract: routes filled by
> 0x, CoW Swap and Bebop collect the identical 0.1% through those venues' own partner-fee
> parameters instead of the FeeCollector, emit no SwapWithFee event, and
> are therefore NOT counted here.
