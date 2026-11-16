# Runbook — DCA fair-value feed registration, phase 1 (Chainlink "low" tier)

**Scope:** register the phase-1 token → USD feeds in each chain's `TeraSwapOrderExecutorV3.tokenUsdFeeds`, so a
DCA between two registered tokens classifies as `onchain-feed` (the contract enforces `max(oracleFloor, scaledMin)`).
Base first (register USDT, cbBTC, EURC, COMP, VIRTUAL; **replace** USDC's SVR feed with the plain proxy), then Arbitrum
(USDT, DAI, WBTC, LINK, ARB, AAVE, COMP, CRV, LDO, MAGIC, PENDLE, SUSHI, UNI). Phase 2 (medium tier) and MOG are
`enabled: false` in the config and are NOT in scope. **ONE CHAIN AT A TIME.**
Since 2026-11-13 phase-2 rows are switched on in monthly batches: start at **§9 Monthly batch**, which leads back into §1–§6.

**Who/what:** the admin is a plain EOA (`admin()` == the `Contract admin` row of `docs/DEPLOYMENTS.md`). There is **no external
Timelock/Safe**: the 48 h delay is inside the executor (`TIMELOCK_ORACLE_CHANGE`). Registration is two admin calls:
`queueTokenUsdFeed(token, feed, tokenDecimals, maxStaleness)` → wait 48 h → `executeTokenUsdFeed(actionId, token, feed, tokenDecimals, maxStaleness)`
within the 7-day grace. (There is no `setTokenUsdFeed` function; that string is only the action-hash tag.)

> No script in this repo holds, reads or accepts a private key, and none sends a transaction. `plan.ts` / `verify.ts` use only
> `eth_call` / `eth_getCode` / `eth_chainId` on public RPCs. The `cast send` lines below are for the **owner**, after Auditor sign-off
> (this sets the on-chain output floor of every DCA fill; `docs/security/AUDIT-TOTAL.md` rule applies).

## 0. Inputs (all derived, never typed)
`src/config/dca-feed-registrations.json` ← `scripts/dca-feeds/build-config.mjs <inventory.csv>` (Chainlink directory export + each token's `decimals()`).
`maxStaleness` per chain, as already registered: **Arbitrum `2×(heartbeat+13)+60`**, **Base `heartbeat+3600`**.
Executor/admin are parsed from `docs/DEPLOYMENTS.md`; the scripts refuse to run on any sentinel failure (42-char + EIP-55 on every address,
RPC chainId, executor has code, on-chain `admin()` == DEPLOYMENTS admin, a computed dead address MUST fail the feed check, and every
phase-0 control row, e.g. Base WETH, must read back registered/equal/live).

## 1. Plan (read-only)
```
node --no-warnings scripts/dca-feeds/plan.ts --chain base > plan-base.json    # diff table on stderr, calldata JSON on stdout
```
Review the table: `current → target`; `unchanged (skipped)` rows emit nothing; any `BLOCKED` row (live-check failure: description not `… / USD`,
decimals mismatch, answer ≤ 0, age > 2× heartbeat, or age ≥ 86400 s) exits 1 and gets **no calldata**. Re-run `plan.ts` right before queueing.

## 2. Queue (owner wallet, admin EOA) — one tx per token
For each item in `plan-base.json`, send `queue.data` to `queue.to` from the admin. Example (Foundry):
```
cast send <queue.to> <queue.data> --from <admin> --ledger      # or your usual hardware-wallet flow
```
Record each tx's block timestamp `T` and the `TimelockQueued(actionId, actionHash, readyAt)` event: it carries the `actionId`.
Cross-check: `actionHash` in the event == `actionHash` in the plan JSON, and `actionId == keccak256(abi.encode(actionHash, T))`.
Base USDC is a **replace**: the old SVR registration stays active until the execute lands.

## 3. Wait the delay
`readyAt = T + 172800 s` (48 h). Execute only inside `[readyAt, readyAt + 604800 s]`; after that the action expires and must be re-queued.
Do not change `maxStaleness` or any parameter in between: the execute must reproduce the queued parameters exactly (hash mismatch reverts).

## 4. Execute (owner wallet)
Take `execute.dataTemplate` from the plan JSON and replace the first 32-byte argument (the zero placeholder) with the real `actionId`
(or re-encode: `cast calldata "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" <actionId> <token> <feed> <tokenDecimals> <maxStaleness>`).
Known revert: execute requires the feed's `updatedAt` to be < 86400 s old *at that moment*. 17 of the 18 phase-1 feeds have an 86400 s heartbeat
(Base USDC was 72 909 s old in the 2026-10-11 dry-run), so a feed close to its heartbeat can revert `Feed seems dead`; wait for the next Chainlink round and retry inside the grace window.

## 5. Verify (read-only)
```
node --no-warnings scripts/dca-feeds/verify.ts --chain base
```
Prints `PASS`/`FAIL` per token (on-chain `tokenUsdFeeds` == config on two RPCs, token `decimals()`, live feed). Exit 1 on any FAIL.

## 6. Product check
On the chain just finished, open the DCA panel with a phase-1 pair (e.g. Base WETH → USDT): the pair must classify `onchain-feed` (no consent
dialog, no tier badge on the resulting order). A pair with an unregistered leg still shows the consent dialog. Arbitrum DCA is additionally gated by
`ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` / the keeper whitelist (`docs/DEPLOYMENTS.md`); registering feeds does not open it.
Only then start the next chain (Arbitrum), repeating §1–§6.

## 7. Side effect to know about
`src/lib/chains/chainlink-feeds.ts` mirrors every enabled config row, so the swap-side Chainlink validation and the limit/SL signable price-feed set now cover
these tokens too, and Base USDC validates against the plain proxy instead of the SVR proxy. That is intentional (owner decision 2026-10-11) and pinned in tests.

## 8. Rollback
Before execute: `cancelTimelockAction(actionId)` (admin). After execute: queue a new registration with the previous feed (another 48 h).

## 9. Monthly batch (owner decision 2026-11-13)
One named list of symbols, one chain, one PR per month. Batch 1 is `2026-11` on Base: MORPHO, AAVE, LINK, USDS, AERO, cbETH, ZRO, YFI.

**0. Choose the symbols from the weekly candidates PR.** `.github/workflows/dca-feed-candidates.yml` runs every Monday 06:30 UTC (or by hand:
Actions, "DCA feed candidates", Run workflow), one job per chain. It runs `scripts/dca-feeds/candidates.ts`, which uses the same directory, catalog and
live checks as `batch.ts` (plus `tokenUsdFeeds()` on both RPCs), and when it finds feeds that are not in the config yet it opens ONE PR per chain, titled
`DCA feed candidates: CHAIN, DATE`, whose body is the table. The PR only appends rows with `enabled: false`, `action: "none"`, `phase: 2`; an
existing row is never modified. No new rows means no PR (the run summary still shows the table). The job never merges, enables or registers
anything and holds no wallet key; a failed directory fetch fails the job, so a red run is the signal and there is no empty PR. The same list on
demand: `node --no-warnings scripts/dca-feeds/candidates.ts --chain base` (table on stderr, JSON report on stdout; add `--write-config` to append the rows).

Before you pick a symbol, check what the table cannot prove:
1. **The token.** The directory carries no token address, so a feed is joined to a catalog token on the exact symbol, and only when exactly one verified
   token has it; anything else prints `needs manual match` and is never a candidate. A lookalike can still carry a real symbol: open the token address
   in the explorer and confirm it is the asset the feed prices, on this chain (bridged or native, e.g. Base WBTC).
2. **The volume.** `24h volume` is the catalog's asset-wide CoinGecko figure, not liquidity on this chain. A tiny figure (Base SHIB, PEPE) means a thin token:
   look at a DEX pool on this chain before choosing it.
3. **The verdict and its reasons.** Only `CANDIDATE` rows can be chosen; every other row names why (already registered on-chain, already enabled,
   category not low/medium, the two RPCs disagree, a stablecoin outside 0.98 to 1.02, a config row that differs from the directory, ...).
4. **Heartbeat.** Short heartbeats are fine (they set `maxStaleness` by the §0 rule), but a feed that updates every few minutes is a different risk
   profile from one that updates daily: pick knowingly.

Merge the candidates PR first (disabled rows change nothing at runtime), then run **a.** with the symbols you chose: it turns an existing row on,
re-checks everything live, and fills `maxStaleness`, `action: "register"` and `batch`.

**a. Build the batch** (read-only: one HTTPS GET of Chainlink's feed directory, then `eth_call` on two RPCs; no key, no transaction):
```
node --no-warnings scripts/dca-feeds/batch.ts --chain base --batch 2026-12 --symbols SYM1,SYM2 > "$TMPDIR/dca-batch.json" \
  && mv "$TMPDIR/dca-batch.json" src/config/dca-feed-registrations.json    # never redirect straight onto the config
```
It creates a missing row from the directory joined to our token catalog (always the plain proxy, never an SVR or secondary one; no address is
typed) and sets `enabled`, `action: "register"`, `maxStaleness` (§0 rule), `tier` (the directory category) and `batch`. It refuses the WHOLE
batch (exit 1, nothing on stdout) when any symbol is not low/medium, is already enabled, fails a live check on either RPC (description, feed
decimals, answer > 0, age ≤ 2× heartbeat and < 86400 s, both RPCs equal, token `decimals()`), or is a stablecoin outside 0.98 to 1.02.
A token with no `SYMBOL / USD` feed cannot be built (Base wstETH has only `WSTETH / ETH`); do not build a composite.

**b. Same PR, copied from the config and never typed:** the keeper mirror `contracts/order-engine/executor/price-sources.js` (its drift guard
fails until it equals the enabled rows), the batch pin in `src/lib/chains/chainlink-feeds.test.ts`, and `BASE_SIGNABLE` in
`src/lib/order-engine/price-feed.test.ts`. A token with a preferred-direct feed (Base cbETH) is registered like any row but stays out of the
swap-side terminal map. Run `scripts/agent-verify.sh --codeql --keeper`.

**c. Draft PR + Auditor (0C/0H) before merge.** The §7 mirror takes effect at DEPLOY, before the execute: from then an unreadable or stale
feed hard-blocks swaps and DCA creation for that token, and the token becomes a Limit/TP trigger feed. The keeper reads its new entries only
after it is redeployed (owner terminal).

**d. Then §1–§6 for that chain.** `plan.ts` must show exactly the batch as `register` with status `plan`, zero `BLOCKED`, and every earlier
row `unchanged (skipped)`; its last stderr line is the summary. `verify.ts` covers the batch rows after the execute.
