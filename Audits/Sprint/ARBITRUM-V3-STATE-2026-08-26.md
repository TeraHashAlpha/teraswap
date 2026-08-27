# ARBITRUM-V3-STATE-2026-08-26 — on-chain state inventory of TeraSwapOrderExecutorV3 on Arbitrum One (42161)

**Kind:** inventory only — no decision, no recommendation. The Architect writes the ADR from this.
**Method:** read-only JSON-RPC (`eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_call`,
`eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_getCode`,
`eth_getBalance`, `eth_getTransactionCount`). **No transaction was sent. No hex was typed by hand** — every
address, hash and block number below was parsed from a repo file or read from chain, and §1 says which.
**Snapshot:** `arb1.arbitrum.io/rpc` block **498,737,426** (2026-08-26 23:43:25 UTC), PublicNode block
498,737,475 (23:43:37 UTC). Contract deployed at block 490,946,028 → the enumeration window is
**7,791,399 blocks** (deploy → snapshot), the contract's whole life.
**Companion:** `Audits/Incidents/INC-2026-08-26-001.md` §11 (the identification this inventory extends).

---

## 0. Summary — the four numbers

| Question | Answer | Settled by |
|---|---|---|
| **How many routers are whitelisted?** | **11**, not 10. The 11th is Bebop `JamSettlement` `0xbeb0…4ea6`, which INC §11.5's probe never tested. | 11 `Bootstrap` events in one tx (§2.2); `bootstrap` calldata decoded (§2.3) |
| **Which reference set do they match?** | **None of the three asked for.** Not the runbook's 2 (both present, 9 surplus), not `config.ts` `BASE_ROUTERS` (1 of 2 present), not `MAINNET_ROUTERS` (1 of 4 present). The set **is `ROUTER_WHITELIST_BY_CHAIN[42161]` from `src/lib/chains/routers.ts` minus its `curve` entry** — 11 of 12, and the missing one has **0 bytes of code** on Arbitrum, so `bootstrap` could not have accepted it (`NotAContract`). The "Base set, copied" hypothesis is **falsified** on three independent points (§3.3). | computed set comparison, lowercased (§3) |
| **Is any executor whitelisted?** | **Yes — exactly one, and the repo does not know it:** `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab`, added through the 48 h `proposeExecutor` → `executeExecutorChange` path on 2026-08-04/06. It is an EOA holding 0.002 ETH that has **never sent a transaction**. The live keeper signer `0x71f5…2E5` is **not** whitelisted here. `bootstrap` itself passed an **empty** executors array. | `ExecutorChangeProposed` + `ExecutorChangeExecuted` + `ExecutorWhitelisted` events (§2.2) — events settle the set; probes only confirm |
| **Is the oracle config set?** | **No, nothing, ever.** Zero `TimelockQueued`, zero `TokenUsdFeedConfigured`, zero `OracleConfigured` in the contract's life. All 5 manifest tokens read `registered=false`; all 5 feeds read `registered=false`. `executeOrder` does **not** revert on this — it silently falls back to the signed minimum (§4 B2). | events (§2.2) + probes (§2.6) |
| **Go-live blockers** | **7** (§4). **3 involve the 48 h timelock** — B2 (fair-value feeds) unconditionally; B1 (routers) and B3 (executor) depending on which way the decision goes. The other 4 are instant admin calls, ops, code, or records. | §4 |

---

## 1. Inputs — where every value came from

| Value | Source | Value |
|---|---|---|
| Contract (Arbitrum V3) | `docs/DEPLOYMENTS.md`, row "OrderExecutor V3 · Arbitrum One (42161)" | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` |
| Deploy tx | `Audits/Incidents/INC-2026-08-26-001.md` §11.5 (full hash); cross-checked equal to the untracked Foundry receipt `contracts/order-engine/broadcast/DeployOrderExecutorV3.s.sol/42161/run-latest.json` | `0x0792a2528f033215994b67afe6607dd3688a817973107ce759b946b87d13cb1a` |
| Deploy block | chain (`eth_getTransactionReceipt` on arb1) = broadcast receipt = INC §11.5 | 490,946,028 |
| Arbitrum RPCs (the two repo-recorded ones) | `scripts/verify-arbitrum-addresses.mjs` `RPCS` (same pair as `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` `rpcs`) | `https://arb1.arbitrum.io/rpc`, `https://arbitrum-one-rpc.publicnode.com` |
| Third RPC (log cross-check) | **not from the repo** — chosen because PublicNode refuses historical reads (§2.1); labelled as such wherever used | `https://arbitrum.drpc.org` |
| Base V3 contract + Base RPC (cross-reference only) | `docs/DEPLOYMENTS.md` row "OrderExecutor V3 · Base (8453)"; `src/lib/chains/registry.ts` Base `rpc.fallbacks` | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0`; `https://mainnet.base.org` |
| Base V3 deploy block | untracked broadcast `…/DeployOrderExecutorV3.s.sol/8453/run-latest.json` | 48,637,097 |
| Reference set 1 — runbook's two | `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md` §2 Step 3, the array on the line after `"bootstrap(address[],address[])"` | Augustus V6.2 `0x6A00…1068`, SwapRouter02-Arbitrum `0x68b3…Fc45` |
| Reference set 1 (audit form) | `Audits/Sprint/AUDIT-ARBITRUM-V3-PREDEPLOY.md` Scope 2 — abbreviated `0x6A00…1068` / `0x68b3…Fc45`; each runbook address checked by prefix+suffix against the audit's abbreviation → both match | same two |
| Reference set 2 — `BASE_ROUTERS` | `src/lib/order-engine/config.ts`, the `const BASE_ROUTERS` block | `0x6A00…1068`, `0x2626…e481` |
| Reference set 3 — `MAINNET_ROUTERS` | same file, the `const MAINNET_ROUTERS` block | `0x1111…2A65`, `0xDef1…5EfF`, `0xDEF171…Ee57`, `0xE592…1564` |
| Extra X1 — Base v2 bootstrap (10) | `docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md` §3 array (line after `"bootstrap(address[],address[])"`) + its executor line | 10 routers; executor `0xd7F9…33Fe` |
| Extra X3/X4 — swap-path router maps | `src/lib/chains/routers.ts` `ROUTER_WHITELIST_BY_CHAIN[8453]` and `[42161]`; `bebop` resolved via `BEBOP_JAM_SETTLEMENT` in `src/lib/constants.ts` | 12 entries each |
| Extra X6/X7 — manifest | `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` `contract.router:*` (9) and `contract.cowVaultRelayer` | 9 + 1 |
| Tokens / feeds probed | manifest `token.*` (5) and `feed.*` (5) | WETH, USDC, USDT, DAI, WBTC and their USD feeds |
| Executor candidates probed | live keeper `0x71f5…2E5` (INC §11.5, citing `Audits/Daily/health-2026-08-07.md`); Base v2 executor `0xd7F9…33Fe` (Base runbook); admin + fee recipient (`DEPLOYMENTS.md` Wallets); the deployer (chain) | see §2.4 |
| Event ABI / topic0 hashes | parsed from `contracts/order-engine/TeraSwapOrderExecutorV3.sol` `event` declarations; `topic0` = viem `toEventSelector`; function selectors = viem `toFunctionSelector` | §2.2 |

---

## 2. Task 1 — enumeration from the contract's own events

### 2.1 RPC agreement

| RPC | `eth_chainId` | Full-life `eth_getLogs` | Deploy receipt / tx | State reads (`eth_call` latest) | Agrees? |
|---|---|---|---|---|---|
| `arb1.arbitrum.io/rpc` (repo) | 42161 | **yes** — one call, 7.79 M-block range, **14 logs** | yes | yes | reference |
| `arbitrum-one-rpc.publicnode.com` (repo) | 42161 | **refused** — `-32602 "Archive requests require a personal token"` (also for the 1-block range at the bootstrap block, and for `eth_getTransactionReceipt` of the deploy tx) | refused | **yes — byte-identical to arb1** on every read: 6 state getters + 5 timelock constants, all 31 `whitelistedRouters` probes, 5 `whitelistedExecutors` + 5 `pendingExecutorChanges` probes, 5 `tokenUsdFeeds`, 5 `oracleConfigs`, code size, balances, nonces | **state: identical; events: cannot say** |
| `arbitrum.drpc.org` (**not** from the repo) | 42161 | **yes** — 780 chunked calls of 10 000 blocks (93 transient retries), blocks 490,946,028 → 498,739,353, **14 logs** | yes — identical to arb1 (receipt, block, `from`, nonce, timestamp; the 3 emitting txs too) | not used — its `eth_call` returned transient `"Temporary internal error"` after 7 retries; state is already agreed by the two repo RPCs | **events: byte-identical to arb1** — all 14, same blocks, log indexes and decoded args |
| `1rpc.io/arb`, `arbitrum-one.public.blastapi.io`, `arb-pokt.nodies.app` (**not** from the repo, spot-check only) | 42161 | **11 logs at block 490,948,988** (1-block range) on each — the bootstrap block agrees across four independent providers; none accepts a wide range on a free tier | — | — | bootstrap block: agree |

**Net:** the two repo RPCs agree on **every piece of current state**. The event history could only be
read from `arb1` among the repo pair; it is corroborated by a third provider over the full range (dRPC)
and by three more at the bootstrap block. PublicNode's refusal is a property of that provider's free tier
(INC §11.5 hit the same wall for the receipt), not a disagreement.

### 2.2 Every event the contract has ever emitted — 14 logs, 3 transactions

`eth_getLogs` with `address` = contract, **no topic filter**, blocks 490,946,028 → 498,737,426. Decoded
against the ABI parsed from the `.sol`. Nothing decoded as unknown.

| # | Block | Tx (admin nonce) | Event | Decoded |
|---|---|---|---|---|
| 1–11 | 490,948,988 | `0xe8439f17…c637f9` (nonce 3) — 2026-08-04 07:55:36 UTC, 12 min after deploy | `Bootstrap(router)` ×11 | the 11 routers in §3.1, in calldata order |
| 12 | 491,085,175 | `0xf77f1840…21ccf` (nonce 4) — 2026-08-04 17:22:42 UTC | `ExecutorChangeProposed(executor, status, executeAfter)` | `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab`, `true`, `executeAfter = 1786036962` (= 2026-08-06 17:22:42 UTC, exactly +48 h) |
| 13 | 491,832,112 | `0xda28d6f5…ce70f` (nonce 5) — 2026-08-06 21:21:33 UTC (3 h 59 min after `executeAfter`) | `ExecutorChangeExecuted(executor, status)` | `0x5f47…39ab`, `true` |
| 14 | 491,832,112 | same tx | `ExecutorWhitelisted(executor, status)` | `0x5f47…39ab`, `true` |

**Events with zero occurrences in the contract's life** (each topic0 computed from the source and absent
from the unfiltered log set): `RouterWhitelisted`, `TimelockQueued`, `TimelockExecuted`,
`TimelockCancelled`, `AdminTransferred`, `ExecutorChangeCancelled`, `Paused`, `Unpaused`,
`OracleConfigured`, `SweepQueued`, `TokenUsdFeedConfigured`, `OrderExecuted`, `OrderCancelled`,
`UnorderedNonceInvalidation`.

What that settles, without probing:
- **Router whitelist = exactly the 11 bootstrapped** — no `RouterWhitelisted` ever, so no timelocked
  add/remove has happened.
- **Executor whitelist = exactly `{0x5f47…39ab}`** — `bootstrap` emitted no `ExecutorWhitelisted`
  (§2.3 confirms the empty array), and the only other emitter of that event is
  `executeExecutorChange`, which fired once, with `status=true`. The mapping cannot be enumerated
  from a public RPC, but its **only two writers both emit**, so the event set *is* the set.
- **Oracle: never queued, never executed** — `TimelockQueued` is emitted by every timelocked queue
  (`queueRouterChange`, `queueAdminChange`, `queueSweep`, `queueTokenUsdFeed`) and never fired;
  `setOracleConfig` (instant) emits `OracleConfigured` and never fired.
- **Admin never transferred, never paused, no sweep queued, no order executed or cancelled on-chain.**
- **`timelockActions` has never held an entry** — nothing pending, nothing expired, no `actionId` to
  re-extract.

### 2.3 The three admin transactions, calldata decoded

| Tx | Selector (computed) | Function | Decoded arguments |
|---|---|---|---|
| `0xe8439f17518f0e0cde4a7fb8090a1094160adbe790b82e6a90b55fb971c637f9` | `0x3d2f1479` | `bootstrap(address[] routers, address[] executors)` | `routers` = the 11 in §3.1 (calldata order = event order); **`executors` = `[]`** (input length 484 B = 4 + 2×32 + (32 + 11×32) + (32 + 0×32)) |
| `0xf77f1840b3ede0a640d8a2004d6a01f0226b3344de384eb0305172f9ca921ccf` | `0xbe3122e2` | `proposeExecutor(address, bool)` | `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab`, `true` |
| `0xda28d6f5328c2dde254eca762c27420a0360aaf43eac78953c33cdb6650ce70f` | `0x90be1be0` | `executeExecutorChange(address)` | `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab` |

All three `from` = admin `0x9A387f681a7674F10d255f5b2651EBc4c672C73C`, `to` = the contract. Deploy was
nonce 2 (2026-08-04 07:43:15 UTC). The admin's Arbitrum nonce is now **7** (`eth_getTransactionCount`,
both RPCs): nonces 2–5 are the four txs above; 0–1 predate this contract (presumably the Arbitrum
FeeCollector deploy + bootstrap of 2026-07-20 per `DEPLOYMENTS.md` — **not verified here**); **nonce 6 is
one further admin transaction that did not touch this contract** (it emitted nothing here). It is
unidentified; a plain ETH transfer emits no event, and the executor's balance (§2.4) is consistent with
one — that is an inference, not a reading.

### 2.4 Executor — what events settle, what probing adds

Events settle the set (§2.2). Probes (`whitelistedExecutors(addr)`, both RPCs identical) only confirm it:

| Address | Source | `whitelistedExecutors` | `pendingExecutorChanges` |
|---|---|---|---|
| `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab` | chain (event) | **true** | none |
| `0x71f5AC191587AE132D966a719569b2468e0Aa2E5` — live keeper signer | INC §11.5 / health-2026-08-07 | false | none |
| `0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe` — Base v2 bootstrap executor | Base runbook §3 | false | none |
| `0x9A38…C73C` admin, `0x107F…3ABA` fee recipient | `DEPLOYMENTS.md` | false, false | none |

About `0x5f47…39ab` (both RPCs): **`eth_getCode` = 0 bytes (EOA); balance = 2 000 000 000 000 000 wei =
0.002 ETH; `eth_getTransactionCount` = 0 — it has never sent a transaction on Arbitrum.** A
case-insensitive search of the whole working tree (tracked + untracked, excluding `node_modules`) finds
**no occurrence** of this address — not in any runbook, KMS setup doc, health file, keeper env example,
deployment record or incident. On Base V3 it is **not** whitelisted (probe false); Base V3's only
executor is `0x71f5…2E5` (its bootstrap event, §3.2 X2). The runbook §0 called for "a NEW KMS
key/address for this chain, not reused across chains" — `0x5f47…` is *consistent* with that, but nothing
in the repo says so, and the repo's own DEPLOYMENTS row says "no repo-known executor is whitelisted",
which is literally true and materially incomplete.

### 2.5 Current state (both RPCs identical)

| Getter | Value | Matches |
|---|---|---|
| `admin()` | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | runbook §0 `_admin`; broadcast constructor arg #2 |
| `feeRecipient()` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | runbook §0; broadcast arg #1 |
| `WETH()` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | manifest `token.WETH`; broadcast arg #3 |
| `sequencerUptimeFeed()` | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | manifest `sequencer.sequencerUptimeFeed`; broadcast arg #4 |
| `paused()` | **false** | — |
| `bootstrapped()` | **true** (spent) | — |
| `TIMELOCK_ROUTER_CHANGE / _EXECUTOR_CHANGE / _ORACLE_CHANGE` | 172 800 s (48 h) each | source constants |
| `TIMELOCK_ADMIN_TRANSFER`, `TIMELOCK_GRACE` | 604 800 s (7 d) each | source constants |
| code size / ETH balance | 18 247 B / 0 wei | INC §11.3 byte-proof (18,247 B) |

### 2.6 Oracle config — probes confirming the (empty) event record

`tokenUsdFeeds(token)` for the 5 manifest tokens (WETH `0x82aF…`, USDC `0xaf88…`, USDT `0xFd08…`,
DAI `0xDA10…`, WBTC `0x2f2a…`): **feed = `0x0000…0000`, decimals 0/0, staleness 0, `registered=false`** —
all five, both RPCs. `oracleConfigs(feed)` for the 5 manifest feeds (ETH/USD `0x639F…`, USDC/USD
`0x5083…`, DAI/USD `0xc5C8…`, USDT/USD `0x3f3f…`, WBTC/USD `0xd0C7…`): **`registered=false`** — all five,
both RPCs. Consistent with zero `TokenUsdFeedConfigured` / `OracleConfigured` events (§2.2). Contrast
Base V3 (§3.2 X2), where the same feed wiring was queued (3 `TimelockQueued`, `readyAt` = 2026-07-16 21:23 UTC ⇒ queued 2026-07-14) and executed after the 48 h (3 `TokenUsdFeedConfigured`: WETH, USDC, DAI).

### 2.7 Router probes beyond the event set (discriminating negatives)

All 11 event routers read `whitelistedRouters = true` on both RPCs. **20 other addresses read `false`**
on both, proving the reads discriminate: Base SwapRouter02 `0x2626…e481`; mainnet 0x `0xDef1…`, Augustus V5
`0xDEF171…`, Uniswap V3 SwapRouter `0xE592…`; Base Curve `0x4f37…`; `routers.ts[42161].curve`
`0xf0d4…e854` (**0 bytes of code on Arbitrum**, both RPCs); the 5 manifest tokens, 5 feeds, sequencer
feed, Permit2, UniV3 factory and QuoterV2.

---

## 3. Task 2 — the router-set comparison

### 3.1 The enumerated set (11), in calldata/event order

| # | Address (lowercased, as compared) | What it is (label from the repo file that carries it) | In runbook's 2? |
|---|---|---|---|
| 1 | `0x111111125421ca6dc452d289314280a0f8842a65` | 1inch AggregationRouterV6 — `routers.ts[42161]['1inch']`, manifest `router:1inch` | no |
| 2 | `0x0000000000001ff3684f28c67538d4d072c22734` | 0x v2 AllowanceHolder — `routers.ts[42161]['0x']`, manifest `router:0x` | no |
| 3 | `0x6a000f20005980200259b80c5102003040001068` | Velora Augustus V6.2 — `routers.ts[42161].velora`, manifest `router:velora` | **yes** |
| 4 | `0x19ceead7105607cd444f5ad10dd51356436095a1` | Odos Router V2 — `routers.ts[42161].odos`, manifest `router:odos` (vendor shut down 2026-07-30, source permanently disabled per `CLAUDE.md`) | no |
| 5 | `0x6131b5fae19ea4f9d964eac0408e4408b66337b5` | KyberSwap MetaAggregationRouterV2 — `routers.ts[42161].kyberswap`, manifest | no |
| 6 | `0xc92e8bdf79f0507f65a392b0ab4667716bfe0110` | CoW **VaultRelayer** — `routers.ts[42161].cowswap`, manifest `cowVaultRelayer` (an approval spender, not a swap `tx.to`) | no |
| 7 | `0x6352a56caadc4f1e25cd6c75970fa768a3304e64` | OpenOcean Exchange — `routers.ts[42161].openocean`, manifest | no |
| 8 | `0xac4c6e212a361c968f1725b4d055b47e63f80b75` | SushiSwap RedSnwapper — `routers.ts[42161].sushiswap`, manifest | no |
| 9 | `0xba12222222228d8ba445958a75a0704d566bf2c8` | Balancer V2 Vault — `routers.ts[42161].balancer`, manifest (source globally disabled, W7-L-02) | no |
| 10 | `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45` | Uniswap SwapRouter02 (**Arbitrum** deployment) — `routers.ts[42161].uniswapv3`, manifest `router:uniswapv3` | **yes** |
| 11 | `0xbeb0b0623f66be8ce162ebdfa2ec543a522f4ea6` | Bebop **JamSettlement** — `routers.ts[42161].bebop` via `constants.ts` `BEBOP_JAM_SETTLEMENT` (**not** in the manifest; **not** probed by INC §11.5) | no |

### 3.2 Computed comparisons (sets lowercased; `A` = enumerated 11, `B` = reference)

| Ref | Reference set | \|B\| | Equal? | A ∩ B | Only in A (surplus on-chain) | Only in B (missing on-chain) |
|---|---|---|---|---|---|---|
| **1** | runbook §2/§3 + AUDIT-ARBITRUM-V3-PREDEPLOY — **EXACTLY 2** | 2 | **no** | 2 (`0x6a00…`, `0x68b3…`) | 9: #1 #2 #4 #5 #6 #7 #8 #9 #11 | 0 |
| **2** | `config.ts` `BASE_ROUTERS` | 2 | **no** | 1 (`0x6a00…`) | 10 | 1: Base SwapRouter02 `0x2626…e481` |
| **3** | `config.ts` `MAINNET_ROUTERS` | 4 | **no** | 1 (`0x1111…`) | 10 | 3: `0xdef1…5eff`, `0xdef171…ee57`, `0xe592…1564` |
| X1 | Base **v2** OrderExecutor bootstrap (`BASE-ORDEREXECUTOR-DEPLOY.md` §3) — the only 10-router "Base set" in the repo | 10 | **no** | 8 | 3: CoW relayer `0xc92e…`, Arb SwapRouter02 `0x68b3…`, Bebop `0xbeb0…` | 2: Base SwapRouter02 `0x2626…`, Base Curve `0x4f37…` |
| X2 | Base **V3** `0x686b…60a0` — its own on-chain `Bootstrap` events (`mainnet.base.org`, 187 chunked calls over blocks 48,637,097 → 50,499,428; single RPC, labelled) | 2 | **no** | 1 | 10 | 1: `0x2626…e481` |
| X3 | `routers.ts` `ROUTER_WHITELIST_BY_CHAIN[8453]` (incl. bebop) | 12 | **no** | 10 | 1: `0x68b3…` | 2: `0x2626…`, `0x4f37…` |
| **X4** | **`routers.ts` `ROUTER_WHITELIST_BY_CHAIN[42161]` (incl. bebop)** | 12 | **no — but A ⊂ B, \|B∖A\| = 1** | **11** | **0** | **1: `curve` `0xf0d4…e854` — 0 bytes of code on Arbitrum** |
| X6 | manifest `contract.router:*` | 9 | no | 9 | 2: `0xc92e…`, `0xbeb0…` | 0 |
| X7 | manifest 9 + `cowVaultRelayer` — INC §11.5's "ten" | 10 | no | 10 | **1: Bebop `0xbeb0…`** | 0 |

### 3.3 Verdict on the hypothesis ("the ten are the Base set, copied")

**Falsified**, on three independent, computed points:

1. **The count is 11, not 10.** INC §11.5 counted ten because it probed candidates (manifest routers +
   CoW relayer); Bebop `JamSettlement` was never a candidate. Events found it.
2. **The set carries a chain-specific address that no Base set has.** Uniswap SwapRouter02 is deployed
   per chain: Base `0x2626…e481`, Arbitrum `0x68b3…fc45`. The on-chain set has `0x68b3…` and **not**
   `0x2626…`. A copy of *any* Base list — the v2 bootstrap (X1), the V3 bootstrap (X2), `BASE_ROUTERS`
   (2) or `routers.ts[8453]` (X3) — would have carried `0x2626…`, and `0x2626…` reads `false` on-chain.
   (The runbook and audit both flagged exactly this pair as the "do not reuse the Base constant" trap; it
   was *not* fallen into.)
3. **The Base-only member is absent and the non-Base members are present.** Base Curve `0x4f37…` (in
   both Base lists) is `false` on-chain; CoW relayer and Bebop (in neither Base bootstrap) are `true`.

Why the hypothesis was plausible: **8 of the 11 addresses are cross-chain deterministic** (1inch, 0x
AllowanceHolder, Augustus V6.2, Odos V2, Kyber, CoW relayer, OpenOcean, Sushi RedSnwapper, Balancer Vault
are the same bytes on Base and Arbitrum), so a probe of Base addresses lights up on Arbitrum. Only the
two per-chain entries (SwapRouter02, Curve) discriminate — and both discriminate *against* Base.

**What the set actually is:** `ROUTER_WHITELIST_BY_CHAIN[42161]` from `src/lib/chains/routers.ts` — the
**swap-path** router validation map written in SPRINT-46/47 for `/api/swap` (which addresses a swap's
`tx.to` may be, which spenders a user may approve) — with its `curve` entry dropped. That entry could
not have been included: `bootstrap` reverts `NotAContract` on `extcodesize == 0`, and `0xf0d4…e854` has
no code on Arbitrum (both RPCs; `routers.ts` itself annotates it "NO CODE on Arbitrum … flagged, not
guessed"). So the bootstrap list is best described as "the 12-entry Arbitrum swap-path map, minus the one
entry the contract would have rejected". It is **not** the order-engine router map (`config.ts`, which has
**no** 42161 entry at all — §4 B6), and it is not the audited two.

---

## 4. Task 3 — what stands between this contract and being safe to use

Listed, not solved. "Timelock" = the contract's own 48 h queue → wait → execute (7 d grace), one
`actionId` per change, re-extracted from the queue receipt at execute time (runbook §4, DAI-saga rule).

| # | Blocker | Evidence | Fix path(s) | 48 h timelock? |
|---|---|---|---|---|
| **B1** | **9 routers beyond the audited two are live.** The runbook's stranding rationale (a router `/api/swap` cannot serve for Arbitrum, or the keeper cannot build calldata for, strands any order that commits to it — PR #225's `SwapFailed` root cause) was written to justify exactly two and now applies to nine, two of which are not swap routers at all (CoW VaultRelayer is an approval spender; Bebop JamSettlement is an RFQ settlement) and two of which are dead/disabled sources (Odos, Balancer). | §2.2, §3.2 row 1 | **Prune:** one `queueRouterChange(r,false)` → 48 h → `executeRouterChange(id,r,false)` **per router** (up to 9 queue + 9 execute txs, batched over one 48 h wait). **Ratify:** no on-chain action; an audit/ADR that answers the stranding rationale, plus `config.ts`/keeper support for whatever is kept. | **Yes if pruned; no if ratified** |
| **B2** | **Fair-value oracle floor is unconfigured for every token.** `_readFeedUsd` returns `ok=false` for an unregistered token, `_fairValueOut` returns `hasFeed=false`, and `executeOrder` then enforces **only the signed `minAmountOut`** — it does not revert. The on-chain floor that is V3's reason to exist over v2 (ADR-013 §1) is silently absent; runbook §4 says "DO NOT skip". | §2.2 (0 `TimelockQueued`), §2.6, `TeraSwapOrderExecutorV3.sol` `_readFeedUsd`/`_fairValueOut`/floor block | `queueTokenUsdFeed(token, feed, tokenDecimals, maxStaleness)` ×5 → 48 h → `executeTokenUsdFeed(actionId, …)` ×5, then the verifier `checkOracleFeed` per token (runbook §4 steps 1–4). | **Yes — unconditionally** |
| **B3** | **The only whitelisted executor is unknown to the repo, unfunded for sustained operation, and has never transacted; the live keeper's signer is not whitelisted.** No process can execute here today: the running keeper signs as `0x71f5…` (false here); `0x5f47…` has no known key custody record, 0.002 ETH, 0 txs. | §2.2 events 12–14, §2.4 | **(a)** Operate the Arbitrum keeper with the `0x5f47…` key — off-chain (KMS/Vault provisioning per `AWS-KMS-EXECUTOR-SETUP.md`, funding, documentation) — no contract change. **(b)** Whitelist `0x71f5…` (or any other): `proposeExecutor(x,true)` → 48 h → `executeExecutorChange(x)`; removing `0x5f47…` is the same path with `false`. | **No for (a); yes for (b)** |
| **B4** | **Trigger-feed bounds unregistered for all 5 feeds** (`oracleConfigs`). Affects Limit/SL/TP only: `_checkPriceCondition` still evaluates with the global 300 s staleness and **no** min/max price bounds; DCA (`priceFeed = 0`) is unaffected. Base V3 has the same gap by design (ADR-019 accepts instant `setOracleConfig`). | §2.6 | `setOracleConfig(feed, maxStaleness, minPrice, maxPrice)` ×5 — instant admin call. | **No** |
| **B5** | **No Arbitrum keeper instance runs** (INC §1, §11.5). The keeper code on `origin/main` is one-instance-per-chain and does know 42161 (`CHAIN_ID`, `ORDER_EXECUTOR_V3_ADDRESS`, DefiLlama slug `arbitrum`, `sequencer-private` submission policy, `ETH_USD_FEED_BY_CHAIN[42161]`), so runbook gate #3's *code* half is met; the *process* half (a provisioned, KMS-backed, funded, monitored 42161 instance with Phase-0 floor active — gate #4) is not. | `contracts/order-engine/executor/executor.js` header + `CHAIN_ID`; INC | Ops: provision + run + monitor (pm2/health stack), with B3 resolved first. | **No** |
| **B6** | **The order-engine router map has no 42161 entry.** `config.ts` `ROUTERS_BY_CHAIN` = `{1, 8453}`; `getWhitelistedRouters(42161)` falls back to `MAINNET_ROUTERS`, so on Arbitrum the app would offer/commit mainnet routers: the default `'1inch'` `0x1111…` happens to be whitelisted (cross-chain address), but `getCanonicalRouteRouter(42161)` → mainnet `uniswapV3` `0xE592…1564`, which is **not** whitelisted here (§2.7) — `isWhitelistedRouter` checks the *mainnet* map, so a pinned canonical route would sign fine and revert `RouterNotWhitelisted` on-chain. `route-source.ts` has no entry for `0x68b3…` (audit I-3, cosmetic). The DCA chain-eligibility fix (`ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS`, branch `fix/dca-chain-eligibility-in-code` @ `7f418b8`) is **not in `origin/main`** — the app-side containment today is the Vercel env re-scope only (INC §2). | `src/lib/order-engine/config.ts` lines `ROUTERS_BY_CHAIN`…`getCanonicalRouteRouter`; `git merge-base --is-ancestor 7f418b8 origin/main` → not ancestor | Code + review: an Arbitrum entry in `config.ts` that is the *intersection* of the on-chain set (whatever B1 leaves) and what `/api/swap` serves; merge the eligibility gate. | **No** |
| **B7** | **The record is wrong or silent.** `docs/DEPLOYMENTS.md` row says "10 routers" (it is 11) and "no repo-known executor is whitelisted" (true, incomplete — one *unknown* executor is); INC §11.5 says "ten"; `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md` still opens "PREPARATION ONLY … No contract is deployed" with gate #1's blank empty; `docs/security/DEPLOYED-SOURCES.md` has no row for either V3 (grep for `V3`/`42161`/`Arbitrum`: none); the Foundry broadcast receipts for **both** 8453 and 42161 are untracked and un-ignored; `0x5f47…` is recorded nowhere. | §1, §2.4, INC §11.6 | Documentation commits (this file is the first). | **No** |

**Count: 7 blockers. Timelock-bound: B2 (always), B1 and B3 (path-dependent).** Everything else is an
instant admin call (B4), ops (B5), code (B6) or records (B7).

Observations that are **not** blockers but belong in the inventory:
- `paused() = false` on a contract nobody can execute against. `pause()`/`unpause()` are instant
  (no timelock), and no `Paused` event has ever fired.
- The admin is an EOA (`eth_getCode` = 0) — standing W1-L-02 (audit I-2), not new here.
- The contract holds 0 ETH and has never received an order (0 `OrderExecuted`/`OrderCancelled`),
  consistent with INC §4's "zero orders" from the database.
- Odos (`0x19ce…`) is whitelisted although the vendor shut down 2026-07-30 and the source is
  permanently disabled; Balancer (`0xba12…`) is whitelisted although globally disabled (W7-L-02).
  Both are members of the surplus in B1, not separate items.

---

## 5. Corrections this inventory makes to earlier repo statements

| Where | Says | Reading |
|---|---|---|
| `docs/DEPLOYMENTS.md` 42161 V3 row; INC §11.5 | "10 routers whitelisted (9 manifest routers + CoW vault relayer)" | **11** — plus Bebop `JamSettlement` `0xbeb0…4ea6` |
| `docs/DEPLOYMENTS.md` same row; INC §11.5 | "no repo-known executor is whitelisted" / "No known executor is whitelisted" | literally true; **one executor unknown to the repo IS whitelisted** (`0x5f47…39ab`, via the 48 h path, 2026-08-04 → 08-06) |
| INC §11.5 | "`bootstrap(routers, executors)` … was executed" (implying executors were set there) | `bootstrap` set **11 routers and zero executors**; the executor came later through `proposeExecutor`/`executeExecutorChange` |
| INC §11.5 caveat | "the set cannot be enumerated from a public RPC" | the *mapping* cannot, but both of its writers emit events, and the full-life unfiltered log is 14 entries — **the set is enumerable and is `{0x5f47…}`** |
| INC §11.5 | "PublicNode refuses archive reads at that depth without a token" | confirmed and extended: it also refuses `eth_getLogs` at that depth even for a 1-block range; it does serve every `latest` state read, identically to arb1 |

None of those files is edited here (one new document only); they are listed for the follow-up that
INC §11.7 already opened.

---

## 6. Reproducibility

The enumeration ran as a throw-away Node script (viem from the repo's `node_modules`, raw JSON-RPC via
`fetch`) in the session scratchpad; it is deliberately **not** committed (this change is one document).
What it did, so the reading can be repeated:

1. Parse the inputs in §1 from the named files (regex on the exact lines cited); never a literal.
2. Parse every `event` declaration from `TeraSwapOrderExecutorV3.sol`, build the ABI, compute `topic0`
   per event; compute the three function selectors from their signatures.
3. Per RPC: `eth_chainId` must be 42161; `eth_blockNumber` = snapshot; `eth_getTransactionReceipt` +
   `eth_getTransactionByHash` + `eth_getBlockByNumber` for the deploy tx; **`eth_getLogs { address }`
   with no topic filter** from the deploy block to the snapshot (single call on arb1; 10 000-block
   chunks with retry on dRPC and on `mainnet.base.org`); decode every log; fetch each emitting tx and
   decode its calldata.
4. `eth_call` at `latest` for the getters in §2.5, `whitelistedRouters` for the union of every set in
   §3.2 plus the manifest's non-router addresses, `whitelistedExecutors` + `pendingExecutorChanges` for
   the candidates in §2.4, `tokenUsdFeeds` ×5, `oracleConfigs` ×5, `timelockActions` for every
   `TimelockQueued.actionId` seen (none).
5. Serialise each RPC's result and compare the serialisations byte-for-byte (§2.1).
6. Same log scan on Base V3 from its broadcast deploy block, to get X2 and the Base executor/feeds.

Nothing was written to chain, to `.env`, or to any existing repo file.
