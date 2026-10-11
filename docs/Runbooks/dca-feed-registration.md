# Runbook — DCA fair-value feed registration, phase 1 (Chainlink "low" tier)

**Scope:** register the phase-1 token → USD feeds in each chain's `TeraSwapOrderExecutorV3.tokenUsdFeeds`, so a
DCA between two registered tokens classifies as `onchain-feed` (the contract enforces `max(oracleFloor, scaledMin)`).
Base first (register USDT, cbBTC, EURC, COMP, VIRTUAL; **replace** USDC's SVR feed with the plain proxy), then Arbitrum
(USDT, DAI, WBTC, LINK, ARB, AAVE, COMP, CRV, LDO, MAGIC, PENDLE, SUSHI, UNI). Phase 2 (medium tier) and MOG are
`enabled: false` in the config and are NOT in scope. **ONE CHAIN AT A TIME.**

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
