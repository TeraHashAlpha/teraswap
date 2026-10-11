# feat/dca-feed-registration-phase1 — FEEDBACK (no PR, NO tx, NO signing)
CSV (outside repo): /Users/tiagocruz/TeraSwap-Workspace/queue/dca-feed-inventory-2026-10-11.csv. Commits 9aa09e2, 8da5673, 608616a, 26867a5 + this file.

**1. Contract facts** (`contracts/order-engine/TeraSwapOrderExecutorV3.sol`; goal's `contracts/src/` path was wrong). No `setTokenUsdFeed` function: `queueTokenUsdFeed(token,feed,tokenDecimals,maxStaleness)` L962 ->
48h (`TIMELOCK_ORACLE_CHANGE`=172800 s read on-chain) -> `executeTokenUsdFeed(actionId,…)` L986, 7d grace, both `msg.sender==admin`. Admin `0x9A38…C73C` = plain EOA (DEPLOYMENTS + runbook); NO external timelock.
Per-feed `maxStaleness` is a parameter (uncapped, never validated; 0 => global 300 s). `actionId=keccak(actionHash,queueTimestamp)` => known only from the `TimelockQueued` event. Feed decimals read on-chain (8|18); execute needs answer>0 and age<86400 s.
Owner rule: Arbitrum `2*(hb+13)+60`, Base `hb+3600`. **Heartbeat check, ALL PASS** (hb <= maxStaleness; CSV age < 86400): Base 86400->90000 (USDT EURC COMP VIRTUAL, USDC replace); Base 1200->4800 (cbBTC);
Arb 255->596 (USDT); 1755->3596 (LINK); 3600->7286 (COMP CRV); 86400->172886 (DAI WBTC ARB AAVE LDO MAGIC PENDLE SUSHI UNI).
**2. Config** `src/config/dca-feed-registrations.json` (built by `scripts/dca-feeds/build-config.mjs` from the CSV + token `decimals()`): Base 15 rows = phase1 enabled 6 (5 register + USDC replace), phase0 control 1 (WETH), phase2 disabled 8 (incl. MOG 18-dec feed);
Arbitrum 17 = phase1 enabled 13, phase2 disabled 4 (GMX GRT WOO YFI).
**3. plan.ts dry-run** (mainnet state 2026-10-11): Base: USDC replace `0x4581…`->`0x7e86…`; COMP EURC USDT VIRTUAL cbBTC register (all `plan`, live ok). Arbitrum: 13 register (all `plan`, live ok), none unchanged. Queue calldata + execute template + actionHash emitted per row; nothing sent.
verify.ts pre-execution: Base WETH PASS, all targets FAIL "not registered" (expected). Both exit codes as designed.
**4. Controls** positive: Base WETH registered feed == config, live ok, left unchanged (PASS). Negative: computed dead address `0xc382…F6E8` FAILs the live check ("no contract code") as required. Any sentinel failure => exit 2, no output.
**5. Pin tests** `chainlink-feeds.test.ts`: "every ENABLED row is present in CHAINLINK_FEEDS_BY_CHAIN, heartbeat and expectation, all equal to the config (lowercase compare)" (+ phase-2 absent, maxStaleness>=heartbeat).
**6. Verify** vitest 285 files/4312 tests (main 84da8a3: 285/4309); eslint 94w/0e (delta 0); tsc clean; 15 files +1077/-11 (plus this file). Runbook: `docs/runbooks/dca-feed-registration.md`.

## Owner decisions / process
- maxStaleness per-chain convention confirmed (asked, answered 3x). Widen `CHAINLINK_FEEDS_BY_CHAIN` + update pins: approved. Scope extension approved: I read/edited 6 tests outside the list (chainlink.test.ts, price-feed.test.ts, DCAPanel v3 / oracle-fail-closed / chain-availability / minchunk-uncheckable) only to re-point Base USDC (derived from config) and re-pin the signable sets (generated from resolver output).
- Process (owner ACCEPTED 2026-10-11): I also read outside the list - a `tsconfig.json` grep, `node_modules/.bin` and the Node version (to choose how to run the .ts scripts) - and recorded the wrong contract path (`contracts/src/` -> `contracts/order-engine/`) without asking. `docs/runbooks/ARBITRUM-V3-FEED-REGISTRATION.md` is the located admin runbook (in scope).
## Auditor notes
Side effect: swap validation + limit/SL signable set now cover the new tokens (Base 4->9, Arbitrum 6->16); Base USDC validates against the plain proxy. 17/18 feeds have 86400 s heartbeat: `execute` can revert near heartbeat (retry). No Arbitrum control row (owner list had none). Scripts need Node >=22.18 (`node --no-warnings`).
