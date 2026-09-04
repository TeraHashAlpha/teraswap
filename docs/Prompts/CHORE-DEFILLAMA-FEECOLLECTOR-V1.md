# CHORE-DEFILLAMA-FEECOLLECTOR-V1 — mainnet counts BOTH FeeCollector deployments, every `start` is derived

> **Source:** measured 2026-09-03 by the Architect, after PR #475 merged (Arbitrum + methodology
> chore). Off-chain reporting integration only — **no Auditor** (no fund flow, no gate, no
> contract, no keeper). SSH-signed, noreply committer. Branch
> `chore/defillama-feecollector-v1` off `origin/main` @ `4ef8823` in a dedicated worktree. Push and
> stop — the owner opens the PR, and the owner opens the follow-up PR against
> `DefiLlama/dimension-adapters`.
>
> **Written after the fact**, per `_PROMPT-TEMPLATE.md` §6 ("commit the spec in its implementation
> PR"): the implementing session was dispatched from a `/goal` paste with no spec file on disk.

## Why

The mirror (`integrations/defillama/teraswap-adapter.ts`) now counts three chains, but only the
7-arg `SwapWithFee`. Mainnet's FROZEN FeeCollector V1
(`docs/DEPLOYMENTS.md`, "FeeCollector V1 (frozen)" row, `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`)
emitted the 5-arg variant — topic0
`0xe41d09ea59537dbbeb0d52b509aff6db0348253cb4f871b7d2c163002576c042` — 14 times between 2026-03-04
and 2026-04-24. That is TeraSwap's entire pre-V2 mainnet history and it was counted nowhere.

Also measured: mainnet V2's first log is 2026-05-26 (config said 2026-05-08) and Base's is
2026-06-04 (config said 2026-05-30) — both early, harmless, but neither was derived.

RPC note: publicnode/drpc/llamarpc all refuse unbounded `eth_getLogs` on chains 1 and 8453.
`https://gateway.tenderly.co/public/mainnet` accepts `fromBlock: 0x0` for mainnet; Base needed a
binary-searched deploy block (`eth_getCode` presence) plus 10k-block chunked `eth_getLogs` via
`mainnet.base.org` (unbounded and Tenderly's Base gateway both reject wide ranges).

## Requirements

1. **Mainnet counts both deployments.** On chain 1, `fetch` issues two `getLogs` reads — one per
   event shape (V2's 7-arg, V1's 5-arg) — and sums both into the same `dailyVolume`/`dailyFees`.
   `tokenIn`/`totalAmount`/`feeAmount` sit in the same roles in both shapes, confirmed against
   `contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol` (V1's real source) rather than assumed.
   Shape: `chainConfig`'s per-chain entry gained an optional `legacyFeeCollector` field, set only
   for `ethereum` — the smallest change that keeps the upstream `Record<string, {feeCollector,
   start}>` shape intact.
2. **Every `start` is derived**, none inherited: mainnet from V1's first log, Base and Arbitrum
   from their own. Arbitrum's was already derived in PR #475; this chore re-verified it unchanged.
3. **Double-counting is proven, not asserted**: V1 and V2 addresses differ, and their event topic0s
   differ (computed via `keccak256`/`toEventSelector`, not RPC) — a mutation pointing
   `legacyFeeCollector` at V2's address fails a dedicated test. Live-chain zero-cross-log checks
   (zero 5-arg logs at V2/Base/Arbitrum, zero 7-arg logs at V1) were run once during
   implementation and are recorded in FEEDBACK; the committed test suite asserts the structural
   guarantee (different addresses, different topic0s) rather than making a live RPC call per test
   run.
4. **`methodology.Volume`** gained one sentence: mainnet aggregates both FeeCollector deployments
   so its history is continuous. The excluded-sources sentence from PR #475 is untouched.

## Do NOT

No change to `FEE_BPS`, `FEE_RECIPIENT`, adapters (`src/lib/adapters/**`), contracts, keeper, or
order engine. No new dependency. No deletions — supersede, never remove. `tsconfig.json` ends
byte-identical to `origin/main`. No PR, no Auditor, no CI polling, no `ssh-add`, no `.env*` reads,
no server access.

## Files touched

- `integrations/defillama/teraswap-adapter.ts` (mainnet `legacyFeeCollector` + `SWAP_WITH_FEE_EVENT_V1`,
  derived `start` for all three chains, `methodology.Volume` sentence)
- `__tests__/defillama-teraswap-adapter.test.ts` (mainnet aggregation tests, derived-start tests,
  structural double-counting guards)
- `integrations/defillama/PR-NOTE.md` (defect 3 write-up, upstream PR paragraph, verbatim methodology)
- `docs/Prompts/CHORE-DEFILLAMA-FEECOLLECTOR-V1.md` (this file)

`docs/DEPLOYMENTS.md` was read but not edited — this chore's task list only asked for the derived
starts to be reported, not appended to that doc (contrast PR #475, which did append a line for
Arbitrum).

## Acceptance (see FEEDBACK for the actual numbers)

1. Mainnet total = V1 logs + V2 logs, with the per-contract split.
2. Four `eth_getCode` byte counts (V1, V2, Base, Arbitrum), all non-empty.
3. Both double-counting assertions pass; a mutation pointing V1 at V2's address fails a test.
4. Three derived `start`s, each with its evidence (block, tx, timestamp).
5. Suite green modulo one pre-existing, branch-independent flake (see FEEDBACK); lint/typecheck at
   or below the ceiling measured on `origin/main`; `tsconfig.json` byte-identical to `origin/main`.
