# feat/dca-feed-registration-phase1 — FEEDBACK (no PR, NO tx, NO signing)
Inventory CSV (outside repo): /Users/tiagocruz/TeraSwap-Workspace/queue/dca-feed-inventory-2026-10-11.csv (45 rows).

## Checklist
- [x] C1 contract facts + heartbeat check
- [ ] C2 config + chainlink-feeds.ts + pin test
- [ ] C3 scripts plan.ts / verify.ts + dry-run
- [ ] C4 runbook

## 1. Contract facts (`contracts/order-engine/TeraSwapOrderExecutorV3.sol`; goal said `contracts/src/…` — wrong path)
- **No `setTokenUsdFeed` function.** `queueTokenUsdFeed(address token,address feed,uint8 tokenDecimals,uint256 maxStaleness)` (L962) then
  `executeTokenUsdFeed(bytes32 actionId,address token,address feed,uint8 tokenDecimals,uint256 maxStaleness)` (L986); both `msg.sender == admin`. "setTokenUsdFeed" is only the actionHash string.
- Per-feed `maxStaleness` IS a parameter (stored, UNCAPPED, never validated); 0 = global `MAX_STALENESS = 300` (L133) -> would fail every feed. Fill-time: `block.timestamp - updatedAt > staleness` => no-feed (L1057).
- Delay `TIMELOCK_ORACLE_CHANGE = 48 hours` (L138), grace 7 days (L139). `actionId = keccak256(abi.encode(actionHash, block.timestamp))` => NOT derivable offline; execute needs it from the `TimelockQueued` event.
- Feed decimals read on-chain at execute: `feed.decimals()` must be 8 or 18 (cached as feedDecimals); `tokenDecimals` 1..18 is caller-supplied, not read. Execute also requires answer > 0 and feed age < 86400 s at that moment.
- Admin = `0x9A387f681a7674F10d255f5b2651EBc4c672C73C`, a plain EOA (`docs/DEPLOYMENTS.md`; runbook `docs/runbooks/ARBITRUM-V3-FEED-REGISTRATION.md` §: `eth_getCode`=0). NO external Timelock/Safe: the 48h delay is inside the executor. So the "timelock schedule/execute payloads" are queue + execute calldata from the admin EOA.

## Owner decision (2026-10-11): maxStaleness rule
Arbitrum: Option C `2*(heartbeat+13)+60`. Base: `heartbeat+3600` (matches Base USDC 90000). Phase 1 = low tier only.

## Heartbeat check (directory heartbeat <= maxStaleness the contract will enforce; and age at execute < 86400)
| chain | symbol | heartbeat s | maxStaleness s | CSV age s | result |
|---|---|---|---|---|---|
| Base | USDT | 86400 | 90000 | 38702 | PASS |
| Base | cbBTC | 1200 | 4800 | 159 | PASS |
| Base | EURC | 86400 | 90000 | 32748 | PASS |
| Base | COMP | 86400 | 90000 | 8109 | PASS |
| Base | VIRTUAL | 86400 | 90000 | 2968 | PASS |
| Base | USDC | 86400 | 90000 | 38773 | PASS |
| Arbitrum | USDT | 255 | 596 | 80 | PASS |
| Arbitrum | DAI | 86400 | 172886 | 9404 | PASS |
| Arbitrum | WBTC | 86400 | 172886 | 1241 | PASS |
| Arbitrum | LINK | 1755 | 3596 | 497 | PASS |
| Arbitrum | ARB | 86400 | 172886 | 90 | PASS |
| Arbitrum | AAVE | 86400 | 172886 | 3041 | PASS |
| Arbitrum | COMP | 3600 | 7286 | 961 | PASS |
| Arbitrum | CRV | 3600 | 7286 | 1361 | PASS |
| Arbitrum | LDO | 86400 | 172886 | 6857 | PASS |
| Arbitrum | MAGIC | 86400 | 172886 | 422 | PASS |
| Arbitrum | PENDLE | 86400 | 172886 | 2045 | PASS |
| Arbitrum | SUSHI | 86400 | 172886 | 2707 | PASS |
| Arbitrum | UNI | 86400 | 172886 | 1177 | PASS |

FAILS: none
