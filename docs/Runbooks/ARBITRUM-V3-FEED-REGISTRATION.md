# Runbook — Register the WETH + USDC fair-value feeds on the Arbitrum OrderExecutorV3 (`tokenUsdFeeds`)

**Scope:** populate the `tokenUsdFeeds` registry of the **Arbitrum One (42161)** `TeraSwapOrderExecutorV3` for
**WETH** and **USDC** via the contract's own 48h-timelocked `queueTokenUsdFeed → executeTokenUsdFeed` path.
Nothing else: no keeper change, no env change, no other token, no other chain.

**Audience:** the owner holding the V3 **admin** key. This decides the **on-chain output floor** of every
Arbitrum DCA fill (ADR-013 §1) → **Auditor sign-off required before §6** (CLAUDE.md #2/#3).

**Why:** `tokenUsdFeeds[WETH]` and `tokenUsdFeeds[USDC]` are both zero on the Arbitrum V3 executor
(re-measured 2026-09-11, §4). The #484 no-feed guard (`readExecutorFeedCoverage`) reads that registry and
fails closed, so no Arbitrum pair can pass through that guard until both legs are registered — this is a
necessary condition for the on-chain oracle floor, but **not** what currently gates the DCA product surface
(§10, §12): `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS = [8453]` (`config.ts:117-121`) blocks Arbitrum DCA in the
UI independently of this registry, and registering these feeds does not change that. The 48h timelock is
the longest pole, and a wrong parameter costs another 48h — so every value below is derived and verified,
never copied from Base.

> ⚠️ **This runbook does NOT broadcast anything and was produced without touching any key.** Every
> `cast send` below is for the **owner** to run from the admin EOA after Auditor sign-off. Everything in
> §3–§5 is read-only (`eth_call` / `eth_getCode` on public RPCs, or a local `anvil` fork).

---

## 0. Constants (verified on-chain 2026-09-11, two independent RPCs — see Appendix A)

| Item | Value | Evidence |
|---|---|---|
| **Chain** | Arbitrum One, chainId **42161** | `cast chain-id` → `42161` on both RPCs |
| **OrderExecutorV3 (target)** | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | `docs/DEPLOYMENTS.md` row "OrderExecutor V3 … Arbitrum One (42161)"; 18,247 B of code; `admin()`, `sequencerUptimeFeed()`, `WETH()`, `ORDER_TYPEHASH()` all answer (§4). ⚠️ **Same address is the mainnet FeeCollector V2 and an abandoned Base OE v2 — every command below carries an Arbitrum `--rpc-url`; §4 proves the chain before anything else.** |
| **Admin (required signer)** | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | `admin()` on the V3 returns it; `docs/DEPLOYMENTS.md` "Contract admin". **`eth_getCode` = 0 bytes → a plain EOA. There is NO external Timelock / Safe / multisig contract in front of it** — the 48h delay lives *inside* the V3 (`TIMELOCK_ORACLE_CHANGE`), so `cast send --account <admin-keystore>` is the whole signing path. |
| **WETH (token)** | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `src/lib/chains/arbitrum-catalog.generated.ts` key `WETH`; on-chain `decimals()=18`, `symbol()="WETH"`, 2,092 B; equals the V3's own `WETH()` |
| **USDC (token, native)** | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | catalog key `USDC`; on-chain `decimals()=6`, `symbol()="USDC"`, 1,852 B |
| **DAI (NEGATIVE CONTROL — never queued here)** | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | catalog key `DAI`; must read `registered=false` before **and after** this runbook (§10) |
| **ETH / USD feed (for WETH)** | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | `src/lib/chains/chainlink-feeds.ts` `42161` block, key = WETH; verified §2.2 |
| **USDC / USD feed (for USDC)** | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | same file, key = USDC; verified §2.2 |
| **L2 sequencer uptime feed** | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | V3 `sequencerUptimeFeed()`; `description()="L2 Sequencer Uptime Status Feed"`, `answer=0` (up), `startedAt=1779307607` (≈113 d before the read → well past the 3600 s grace) |
| `TIMELOCK_ORACLE_CHANGE` | `48 hours` = **172800 s** | source `:138`; on-chain `TIMELOCK_ORACLE_CHANGE()` → `172800` |
| `TIMELOCK_GRACE` | `7 days` = **604800 s** | source `:139`; on-chain `TIMELOCK_GRACE()` → `604800` |
| `MAX_STALENESS` (global, used when `maxStaleness == 0`) | **300 s** | source `:132`; on-chain `MAX_STALENESS()` → `300` — **must NOT be relied on here, see §2.4** |
| `SEQUENCER_GRACE_PERIOD` | 3600 s | source `:148`; on-chain → `3600` |
| `paused()` / `bootstrapped()` | `false` / `true` | §4 |

**`maxStaleness` — OPTION C, adopted by the owner over this runbook's original proposal** (Option A,
`2633` / `383`, superseded by the Auditor's measurement — §2.4 keeps the full comparison for the audit
trail): `maxStaleness = 2 × (heartbeat + 13 s) + 60 s`, so this registration survives one fully missed OCR
round instead of only clearing the observed maximum gap. Derivation and trade-offs in §2.4.

**Precomputed, ABI-verified `actionHash = keccak256(abi.encode("setTokenUsdFeed", token, feed, tokenDecimals, maxStaleness))`**
(re-derive in §4; recomputed for Option C via `cast abi-encode ... | cast keccak` against the runbook's own
values, nothing copied):

| Registration | `actionHash` |
|---|---|
| WETH → ETH/USD, `tokenDecimals=18`, `maxStaleness=3596` | `0x21a777eaf762bc6c5a0ebfa965acd6c8dc9137ba3159eaf32810034a04e8967c` |
| USDC → USDC/USD, `tokenDecimals=6`, `maxStaleness=596` | `0xbf199f5c374ee648ce2295c3b4a2a8c88c1004776ce3d9f3ab343fc15ca4ea42` |

**Custom-error selectors** (what a revert's `data` means):

| error | selector | error | selector |
|---|---|---|---|
| `NotAdmin()` | `0x7bfa4b9f` | `TimelockNotQueued()` | `0xdfc44acf` |
| `ZeroAddress()` | `0xd92e233d` | `TimelockNotReady()` | `0x7378c19d` |
| `TimelockAlreadyQueued()` | `0x5b4f4d75` | `TimelockExpired()` | `0x7a6fcaa6` |
| | | `TimelockHashMismatch()` | `0x522dbb19` |

**Event topic0 (for log parsing):**

| event | topic0 |
|---|---|
| `TimelockQueued(bytes32,bytes32,uint256)` | `0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0` |
| `TimelockExecuted(bytes32,string,bytes)` | `0x26a53932c486d0db34238c489e557a02dcf8da4741e77a7b15ea8c25e48ec21d` |
| `TimelockCancelled(bytes32)` | `0xa32a56a4fb497457a2ff2c7acd600aac5dd868b3c2fd537c030e2bbfaecd47e1` |
| `TokenUsdFeedConfigured(address,address,uint8,uint8,uint256)` | `0x91dc6839f4d9e3cc1fd75939365d83dd3f043e433865289cce282a75f1404f86` |

---

## 1. The contract, exactly (`contracts/order-engine/TeraSwapOrderExecutorV3.sol`, quoted)

### 1.1 Constants and storage

```solidity
132:    uint256 public constant MAX_STALENESS = 300;      // [H-03] 5 min staleness for the trigger feed
138:    uint256 public constant TIMELOCK_ORACLE_CHANGE  = 48 hours; // [ADR-013/P6] Oracle-config change delay
139:    uint256 public constant TIMELOCK_GRACE = 7 days;            // [Audit M-03] Timelock expiry window
```

```solidity
111:    struct TimelockAction {
112:        bytes32 actionHash;      // keccak256 of the action data
113:        uint256 readyAt;         // Timestamp when action can be executed
114:        bool exists;             // Whether action is queued
115:    }
…
194:    mapping(bytes32 => TimelockAction) public timelockActions;
```

```solidity
222:    struct TokenUsdFeed {
223:        address feed;         // Chainlink token/USD AggregatorV3
224:        uint8 feedDecimals;   // feed.decimals() cached at config time (8 or 18)
225:        uint8 tokenDecimals;  // ERC-20 decimals of the token (6/8/18)
226:        uint256 maxStaleness; // seconds (0 = global MAX_STALENESS)
227:        bool registered;      // whether this token has a fair-value feed
228:    }
229:    mapping(address => TokenUsdFeed) public tokenUsdFeeds;
```

### 1.2 `queueTokenUsdFeed` — signature, parameter order, preconditions (lines 962–983)

```solidity
962:    function queueTokenUsdFeed(
963:        address token,
964:        address feed,
965:        uint8 tokenDecimals,
966:        uint256 maxStaleness
967:    ) external {
968:        if (msg.sender != admin) revert NotAdmin();
969:        if (token == address(0) || feed == address(0)) revert ZeroAddress();
970:
971:        bytes32 actionHash = keccak256(abi.encode("setTokenUsdFeed", token, feed, tokenDecimals, maxStaleness));
972:        bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));
973:
974:        if (timelockActions[actionId].exists) revert TimelockAlreadyQueued();
975:
976:        timelockActions[actionId] = TimelockAction({
977:            actionHash: actionHash,
978:            readyAt: block.timestamp + TIMELOCK_ORACLE_CHANGE,
979:            exists: true
980:        });
981:
982:        emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_ORACLE_CHANGE);
983:    }
```

Reverts, in order: `NotAdmin` (968) · `ZeroAddress` if `token` **or** `feed` is zero (969) · `TimelockAlreadyQueued`
(974) — **only** if the identical action was already queued at the **same `block.timestamp`** (the
`actionId` mixes it in, 972; on Arbitrum several ~250 ms blocks share one timestamp second). Nothing else is
validated at queue time: `tokenDecimals` and `maxStaleness` are
**not** range-checked here, and the feed is **not** called. ⚠️ Consequence: the same parameters queued in two
different blocks produce two **different** live `actionId`s — a botched second attempt does not replace the
first, it sits beside it for 9 days unless cancelled (§11).

### 1.3 `executeTokenUsdFeed` — signature, preconditions, execution-time validation (lines 986–1023)

```solidity
986:    function executeTokenUsdFeed(
987:        bytes32 actionId,
988:        address token,
989:        address feed,
990:        uint8 tokenDecimals,
991:        uint256 maxStaleness
992:    ) external {
993:        if (msg.sender != admin) revert NotAdmin();
994:
995:        TimelockAction storage action = timelockActions[actionId];
996:        if (!action.exists) revert TimelockNotQueued();
997:        if (block.timestamp < action.readyAt) revert TimelockNotReady();
998:        if (block.timestamp > action.readyAt + TIMELOCK_GRACE) revert TimelockExpired();
999:
1000:        bytes32 expectedHash = keccak256(abi.encode("setTokenUsdFeed", token, feed, tokenDecimals, maxStaleness));
1001:        if (action.actionHash != expectedHash) revert TimelockHashMismatch();
1002:
1003:        delete timelockActions[actionId];
1004:
1005:        // Validate the feed at execution time (mirrors setOracleConfig sanity checks).
1006:        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
1007:        require(feedDecimals == 8 || feedDecimals == 18, "Unexpected feed decimals");
1008:        require(tokenDecimals >= 1 && tokenDecimals <= 18, "Unexpected token decimals");
1009:        (, int256 testPrice, , uint256 testUpdatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
1010:        require(testPrice > 0, "Feed returns invalid price");
1011:        require(block.timestamp - testUpdatedAt < 86400, "Feed seems dead (>24h stale)");
1012:
1013:        tokenUsdFeeds[token] = TokenUsdFeed({
1014:            feed: feed,
1015:            feedDecimals: feedDecimals,
1016:            tokenDecimals: tokenDecimals,
1017:            maxStaleness: maxStaleness,
1018:            registered: true
1019:        });
1020:
1021:        emit TimelockExecuted(actionId, "setTokenUsdFeed", abi.encode(token, feed, tokenDecimals, maxStaleness));
1022:        emit TokenUsdFeedConfigured(token, feed, feedDecimals, tokenDecimals, maxStaleness);
1023:    }
```

Execute window: **`readyAt ≤ block.timestamp ≤ readyAt + 604800`** (997–998, both bounds inclusive). The
four params must re-hash to the queued `actionHash` (1000–1001) — a single wrong digit is
`TimelockHashMismatch`. The entry is **deleted before** the feed checks (1003), so if 1006–1011 revert the
whole tx reverts and the entry survives (revert undoes the delete) — you can retry within the window.
`tokenDecimals` is only range-checked 1..18 (1008) — **the contract never reads the token's `decimals()`**, so
§4's on-chain read is the only guard against a wrong value. `maxStaleness` is **never** validated.
`feedDecimals` is read from the feed and cached (1006/1015). There is **no** unregister function — the only
write to `tokenUsdFeeds` is line 1013 — an executed entry can only be **overwritten** by another 48h
registration; the instant emergency lever is `pause()` (903–907).

### 1.4 Storage and read-back

Queued: `timelockActions(actionId) → (bytes32 actionHash, uint256 readyAt, bool exists)` (194).
Executed: `tokenUsdFeeds(token) → (address feed, uint8 feedDecimals, uint8 tokenDecimals, uint256 maxStaleness, bool registered)` (229).
`actionId` is **not** precomputable — it mixes in the queue block's timestamp (972). Read it from the
`TimelockQueued` event (`topics[1]`) of the queue tx, then cross-check by recomputing
`keccak256(abi.encode(actionHash, queueBlockTimestamp))` (§6). This is the DAI-saga lesson of
`ARBITRUM-V3-EXECUTOR-DEPLOY.md` §4: re-extract from the receipt at execute time, never from notes.

### 1.5 Cancel — yes, it exists (lines 758–763)

```solidity
758:    function cancelTimelockAction(bytes32 actionId) external {
759:        if (msg.sender != admin) revert NotAdmin();
760:        if (!timelockActions[actionId].exists) revert TimelockNotQueued();
761:        delete timelockActions[actionId];
762:        emit TimelockCancelled(actionId);
763:    }
```

Admin-only, instant, no delay, works at any time before execute (including inside the 7 d grace). It only
removes a **queued** entry — it cannot undo an executed registration (§1.3).

### 1.6 What `maxStaleness` actually does at fill time (lines 1046–1061)

```solidity
1046:    function _readFeedUsd(address token) internal view returns (uint256 price, uint8 feedDec, bool ok) {
1047:        TokenUsdFeed memory cfg = tokenUsdFeeds[token];
1048:        if (!cfg.registered) return (0, 0, false);
…
1056:        if (answer <= 0) return (0, 0, false);
1057:        uint256 staleness = cfg.maxStaleness > 0 ? cfg.maxStaleness : MAX_STALENESS;
1058:        if (block.timestamp - updatedAt > staleness) return (0, 0, false);
1059:        if (answeredInRound < roundId) return (0, 0, false);
1060:        return (uint256(answer), cfg.feedDecimals, true);
1061:    }
```

A round older than `maxStaleness` does **not** revert — it returns `ok=false` ⇒ `hasFeed=false` ⇒ the fill
runs on the **scaled signed absolute min only** (`:536-541`, "NO-FEED semantics … never fill blind"). So a
too-**tight** value silently drops the oracle floor on routine late rounds; a too-**loose** value keeps trusting
a frozen feed for longer. This is the trade-off §2.4 sets. The sequencer gate (`_sequencerUp`, 1031–1040) is
independent of this value.

---

## 2. Parameters — derived, never copied

### 2.1 Base registry (what is live on 8453) vs. proposed Arbitrum (42161) — side by side

| | **Base — WETH** | **Base — USDC** | **Arbitrum — WETH (proposed)** | **Arbitrum — USDC (proposed)** |
|---|---|---|---|---|
| Executor | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` | same | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | same |
| `token` | `0x4200000000000000000000000000000000000006` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `feed` | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (ETH/USD) | `0x458138Fc0D67027E9A6778ef40a6ffC318c69061` (USDC/USD) | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` (ETH/USD) | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` (USDC/USD) |
| `feedDecimals` (cached) | 8 | 8 | 8 (read on-chain, §2.2) | 8 (read on-chain, §2.2) |
| `tokenDecimals` | 18 | 6 | **18** (on-chain `decimals()`) | **6** (on-chain `decimals()`) |
| Chainlink published heartbeat | 1200 s (`chainlink-feeds.ts:138`) | 86400 s (`:139`) | **1755 s** (fetched 2026-09-11, §2.3) | **255 s** (fetched 2026-09-11, §2.3) |
| `maxStaleness` registered / proposed | **3600** (= 3.0 × heartbeat) | **90000** (= heartbeat + 3600, 1.04 ×) | **3596** (Option C = 2×(heartbeat+13 s)+60 s, §2.4) | **596** (same rule) |
| Source | `docs/feedback/fix-dca-no-feed-fail-closed.md:27` (on-chain read 2026-09-09), pinned in `src/lib/order-engine/executor-feed-registry.test.ts:10-12` | `…:28` / `…:11` | this runbook §2.3–2.4 | this runbook §2.3–2.4 |

**What differs and why it matters:** the two chains' feeds have different heartbeats, so the Base numbers are
not transferable. Base's USDC/USD is a 24 h-heartbeat feed; Arbitrum's is a **255 s** feed — copying Base's
`90000` would let a frozen Arbitrum USDC feed be trusted as the fair-value floor for **25 h** (353 × its
heartbeat). Base's WETH `3600` happens to land within 4 s of Arbitrum's Option C value (3596) purely by
arithmetic coincidence (Base's is 3 × its own 1200 s heartbeat; Arbitrum's is derived from measured
transmission latency on a 1755 s heartbeat, §2.4) — the two numbers must never be treated as the same
derivation. The Arbitrum values below follow the staleness rule the Auditor measured and the owner adopted
for these exact feeds (§2.4).

### 2.2 Feed verification — on-chain, two RPCs, 2026-09-11 (Appendix A for the raw output)

All four checks the goal requires, per feed, identical on `arb1.arbitrum.io/rpc` and
`arbitrum-one-rpc.publicnode.com`:

| Check | ETH / USD `0x639F…ba612` | USDC / USD `0x5083…4aD3` |
|---|---|---|
| `eth_getCode` | **9,571 B** | **9,571 B** |
| `decimals()` | **8** | **8** |
| `description()` | **`"ETH / USD"`** | **`"USDC / USD"`** |
| `latestRoundData()` (block-pinned, 504036692 @ `1789126505` = 2026-09-11T11:35:05Z) | roundId `36893488147419218033`, answer `245411113784` ($2,454.11), updatedAt `1789126340`, **age 165 s**, `answeredInRound == roundId` ✅, `answer > 0` ✅ | roundId `55340232221128661771`, answer `99985837` ($0.99985837), updatedAt `1789126482`, **age 23 s**, `answeredInRound == roundId` ✅, `answer > 0` ✅ |
| `version()` / `aggregator()` | 6 / `0xD827123D014578C965F6c9d87A641ec05FaA5501` (phase 2, matches Chainlink JSON `contractAddress`) | 6 / `0xb10cb22245D54f58C66eE65353FaB5D94ca21A1C` (**phase 3** — matches Chainlink JSON `contractAddress`; the repo's 2026-08-26 read saw the phase-2 aggregator `0x085a38e3…`, i.e. Chainlink rotated the aggregator behind the **unchanged proxy**; phase-3 round 1 `updatedAt=1787242551` = 2026-08-20T16:15:51Z) |
| Execute-time checks (1006–1011) at read time | decimals 8 ∈ {8,18} ✅ · price > 0 ✅ · age 165 s < 86400 ✅ | decimals 8 ✅ · price > 0 ✅ · age 23 s < 86400 ✅ |

Token decimals, read on-chain (not assumed): `WETH.decimals()` = **18** (`symbol()="WETH"`),
`USDC.decimals()` = **6** (`symbol()="USDC"`) — both equal the catalog values, which is what §4 re-asserts
before queueing because the contract itself never checks (§1.3).

### 2.3 Chainlink's PUBLISHED heartbeat for these feeds ON ARBITRUM (fetched, not assumed)

Source: Chainlink's reference-data directory for Arbitrum One —
`https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json` (the JSON that
docs.chain.link renders), fetched **2026-09-11** (HTTP 200, 3,123,280 bytes), filtered by `proxyAddress`:

| field | `eth-usd` | `usdc-usd` |
|---|---|---|
| `proxyAddress` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` |
| `contractAddress` (aggregator) | `0xD827123D014578C965F6c9d87A641ec05FaA5501` | `0xb10cb22245D54f58C66eE65353FaB5D94ca21A1C` |
| **`heartbeat`** | **1755** | **255** |
| `threshold` (deviation %) | 0.05 | 0.1 |
| `decimals` | 8 | 8 |
| `feedCategory` / `feedType` | low / Crypto | low / Crypto |
| `clicProductName` | `ETH/USD-RefPrice-DF-Arbitrum-001` | `USDC/USD-RefPrice-DF-Arbitrum-001` |
| `docs.shutdownDate` | null | null |

Siblings deliberately **not** used (same `name`, different products): `eth-usd-svr` `0xAfF2…b0DC` and
`eth-usd-shared-svr` `0xe4D0…5E3f` (86400 s), `eth-usd-cre-backup` `0x5e3F…be61` (86400 s / 0.5 %),
`usdc-usd-svr` `0x0D0F…B571`, `usdc-usd-shared-svr` `0x7C7d…A595`, `usdc-usd-cre-backup` `0x8A35…803d`.
These match the values already pinned in `chainlink-feeds.ts:154-155` and
`docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md:68-70` — independently re-fetched here rather than inherited.

**Empirical cross-check (Appendix B, re-measured for the Auditor's Option C review):** ETH/USD over ≥5 days,
USDC/USD over ≥14 days, via `getRoundData` on the aggregator directly (not the proxy — plain, unphased
round IDs), fetched in batches of `eth_call` against `arb1.arbitrum.io/rpc`:

| | ETH / USD | USDC / USD |
|---|---|---|
| Sample window | 2026-09-05T06:27:07Z → 2026-09-11T13:53:24Z (**6.31 d**) | 2026-08-27T20:30:26Z → 2026-09-11T13:49:46Z (**14.72 d**) |
| Rounds sampled (aggregator round IDs) | **3,546** (114400–114945) | **4,701** (2253–6953) |
| Inter-round gap min / median / p90 / p99 / **max** | 16 / 90 / 330 / 930 / **1771 s** | 30 / 270 / 271 / 330 / **331 s** |
| Gaps > published heartbeat | **2 of 3545** (max = 1.009 × 1755) | **4,682 of 4,700** — nearly every gap is a few seconds **over** 255 s because `updatedAt` includes on-chain transmission latency (`startedAt → updatedAt`: min 12 s / median 13 s / max 253 s); max gap = 1.30 × heartbeat |
| Gaps > 1.5 × heartbeat | 0 | 0 |
| Gaps > 300 s (global `MAX_STALENESS`) | n/a (heartbeat itself is 1755 s) | **85 of 4,700** |
| Integrity failures in sample | 0 | 0 |

The USDC row is still the important one: the feed's **effective** `updatedAt` cadence is ~270 s, not 255 s,
and over 14.7 days 85 rounds (1.8 %) landed past the global `MAX_STALENESS` (300 s) — the global fallback
would have turned those routine rounds into NO-FEED fills. The observed maxima (1771 s ETH / 331 s USDC)
are what Option C (§2.4) is measured against, not the theoretical heartbeat.

### 2.4 `maxStaleness` derivation — OPTION C (Auditor-recommended, owner-adopted)

This runbook originally proposed **Option A** (`maxStaleness = round(heartbeat × 1.5)`, the staleness policy
already codified for the raw quote gate and UI hook, `getFeedStalenessSec`, `chainlink-feeds.ts:181-193`).
The Auditor's review of the parameter table (0C/0H/2M/3L) measured the feeds' actual round cadence (§2.3,
Appendix B) and recommended **Option C** instead: `maxStaleness = 2 × (heartbeat + 13 s) + 60 s`. The owner
adopted that recommendation. **Option A (2633 / 383) is superseded by the Auditor's measurement** and is
kept below only for the audit trail — it is not queued by this runbook.

The `+13 s` is the median on-chain transmission latency observed in both feeds' samples (§2.3, `startedAt →
updatedAt`); the `× 2` is what actually buys survival of one fully missed OCR round (Option A does not: its
margin over the observed max gap was positive but smaller than one heartbeat, so a single missed round would
still exceed it); the `+60 s` is block-time/RPC slack on top.

| Token | Published heartbeat (§2.3) | 2×(heartbeat+13 s) | +60 s | **`maxStaleness` (Option C)** | Slack over observed max gap (§2.3) | Frozen-feed detection |
|---|---|---|---|---|---|---|
| WETH | 1755 s | 3536 | 3596 | **3596** | 3596 − 1771 = **1825 s** (≈30.4 min) | ≤ 59.9 min |
| USDC | 255 s | 536 | 596 | **596** | 596 − 331 = **265 s** (≈4.4 min) | ≤ 9.9 min |

Properties, stated for the Auditor:
- Clears every round observed in the ≥5 d / ≥14 d samples (max gap 1771 s ETH / 331 s USDC, §2.3) with
  margin, and every heartbeat-driven round with margin.
- **Survives one fully missed round** (≈ 2 × cadence: ~3510 s ETH / ~510 s USDC) by design — that is the
  point of the `× 2` term, and the property Option A lacked.
- `0` (global 300 s) is **rejected** for both: ETH/USD would be NO-FEED whenever the price is calm for
  > 5 min; USDC/USD would be NO-FEED on 85 of the 4,700 sampled rounds (§2.3).

Alternatives, so the choice is visible:

| Option | ETH/USD | USDC/USD | Survives 1 missed round? | Frozen-feed exposure |
|---|---|---|---|---|
| A — heartbeat × 1.5 (**superseded by the Auditor's measurement**) | 2633 | 383 | no | 44 min / 6.4 min |
| B — heartbeat × 2 | 3510 | 510 | no — equals exactly 2 × the raw heartbeat, with no latency margin, so a missed round plus the observed ~13 s/round transmission latency can still exceed it | 58 min / 8.5 min |
| **C — 2 × (heartbeat + 13 s) + 60 s — ADOPTED** | **3596** | **596** | yes | 60 min / 10 min |
| Base precedent (NOT a derivation) | 3600 | 90000 | — | 60 min / **25 h** |

⚠️ The ETH Option C value (3596) lands within 4 s of Base's registered `3600` — arithmetic coincidence only
(Base's is 3 × its own 1200 s heartbeat); it is recorded above as derived from Arbitrum's 1755 s heartbeat
plus measured latency, never copied from Base (§2.1).

> **Auditor-confirmed, owner-adopted:** Option C (`3596` / `596`) is the on-chain policy for §6–§9 of this
> runbook — the owner accepted that "a single missed round is survived without degrading to the signed-min
> floor" is preferred over "the tighter Option A margin with a smaller frozen-feed exposure window." If this
> decision is ever revisited, **only** the two `maxStaleness` numbers change; every `actionHash` in §0 must
> then be recomputed (§4 shows how) — the rest of this runbook is unchanged.

---

## 3. Extract every address (never typed) — run this first, in a checkout at `origin/main`

```bash
export RPC_URL=https://arb1.arbitrum.io/rpc
export RPC_URL2=https://arbitrum-one-rpc.publicnode.com
CAT=src/lib/chains/arbitrum-catalog.generated.ts
FEEDS=src/lib/chains/chainlink-feeds.ts
DEP=docs/DEPLOYMENTS.md
tok()    { grep -E "key: '$1'" "$CAT" | grep -oE "0x[0-9a-fA-F]{40}" | head -1; }
tokdec() { grep -E "key: '$1'" "$CAT" | grep -oE "decimals: [0-9]+" | grep -oE "[0-9]+"; }
feed_for() { awk '/^  42161: \{/{f=1;next} f&&/^  \}/{f=0} f' "$FEEDS" \
             | grep -i "'$(echo "$1" | tr '[:upper:]' '[:lower:]')'" | grep -oE "0x[0-9a-fA-F]{40}" | sed -n '2p'; }
export WETH=$(tok WETH) USDC=$(tok USDC) DAI=$(tok DAI)
export WETH_DEC_CAT=$(tokdec WETH) USDC_DEC_CAT=$(tokdec USDC)
export FEED_WETH=$(feed_for "$WETH") FEED_USDC=$(feed_for "$USDC")
export V3=$(grep -E '^\| \*\*OrderExecutor V3\*\*.*Arbitrum One \(42161\)' "$DEP" | grep -oE '`0x[0-9a-fA-F]{40}`' | head -1 | tr -d '`')
export ADMIN=$(grep -E '^\| Contract admin' "$DEP" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
# proposed values — Option C, Auditor-recommended, owner-adopted (§2.4 — change ONLY on a new Auditor decision)
export ST_WETH=3596 ST_USDC=596
for v in WETH USDC DAI FEED_WETH FEED_USDC V3 ADMIN; do eval val=\$$v; printf "%-10s %s len=%s\n" "$v" "$val" "${#val}"; done
```

**Expected (compare, do not type):** every `len=42`, and the seven values equal the §0 table. Abort on any
difference. (macOS bash 3.2 compatible; `tr` for lowercase.)

---

## 4. Pre-flight reads (read-only, both RPCs) — abort on any mismatch

```bash
for R in "$RPC_URL" "$RPC_URL2"; do
  echo "== $R"
  cast chain-id --rpc-url "$R"                                              # => 42161
  cast call $V3 "ORDER_TYPEHASH()(bytes32)" --rpc-url "$R"                  # answers (V3-only) — on the wrong chain this address is a FeeCollector and this REVERTS
  cast call $V3 "admin()(address)" --rpc-url "$R"                           # => $ADMIN
  cast call $V3 "WETH()(address)" --rpc-url "$R"                            # => $WETH
  cast call $V3 "paused()(bool)" --rpc-url "$R"                             # => false
  cast call $V3 "TIMELOCK_ORACLE_CHANGE()(uint256)" --rpc-url "$R"          # => 172800  (cast appends a "[1.728e5]" display hint)
  cast call $V3 "TIMELOCK_GRACE()(uint256)" --rpc-url "$R"                  # => 604800
  echo "admin code bytes: $(( ($(cast code $ADMIN --rpc-url "$R" | wc -c) - 3) / 2 ))"   # => 0  (plain EOA, no contract in front)
  for T in $WETH $USDC $DAI; do cast call $V3 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" $T --rpc-url "$R" | tr '\n' ' '; echo; done
  # => all three: 0x0000000000000000000000000000000000000000 0 0 0 false   (registry empty — the bug)
  echo "WETH decimals: $(cast call $WETH 'decimals()(uint8)' --rpc-url "$R")  (catalog $WETH_DEC_CAT)"   # => 18
  echo "USDC decimals: $(cast call $USDC 'decimals()(uint8)' --rpc-url "$R")  (catalog $USDC_DEC_CAT)"   # => 6
  for FEED in $FEED_WETH $FEED_USDC; do
    echo "feed $FEED code=$(( ($(cast code $FEED --rpc-url "$R" | wc -c) - 3) / 2 )) B dec=$(cast call $FEED 'decimals()(uint8)' --rpc-url "$R") desc=$(cast call $FEED 'description()(string)' --rpc-url "$R")"
    cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$R" --json
  done
  SEQ=$(cast call $V3 "sequencerUptimeFeed()(address)" --rpc-url "$R")
  cast call $SEQ "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$R" --json    # 2nd element (answer) must be 0 = sequencer up
done
```

Expected feed lines: `9571 B`, `dec=8`, `desc="ETH / USD"` / `desc="USDC / USD"`; in each `latestRoundData`
JSON, `answer > 0`, element 5 (`answeredInRound`) ≥ element 1 (`roundId`) — compare as big integers, bash
`[ -ge ]` overflows on uint80 — and `now − updatedAt` **≤ the proposed `maxStaleness`: 3596 s (ETH) / 596 s
(USDC)** (a fresh round; the execute-time bound is 86400 s). A tighter bound tied to the raw heartbeat
(e.g. the earlier draft's 1768 s / 268 s) is the wrong check here — 268 s sits *below* USDC/USD's own
observed cadence (§2.3), so a routine round could fail this pre-flight gate even though the on-chain
registration you are about to queue (`maxStaleness = 596`) would accept it. The gate that matters is whether
the round is fresh enough for the value you are registering. Both RPCs must return the same `roundId`.

Re-derive the two `actionHash`es (must equal the §0 table):

```bash
cast abi-encode "x(string,address,address,uint8,uint256)" setTokenUsdFeed $WETH $FEED_WETH 18 $ST_WETH | cast keccak
# => 0x21a777eaf762bc6c5a0ebfa965acd6c8dc9137ba3159eaf32810034a04e8967c
cast abi-encode "x(string,address,address,uint8,uint256)" setTokenUsdFeed $USDC $FEED_USDC 6 $ST_USDC | cast keccak
# => 0xbf199f5c374ee648ce2295c3b4a2a8c88c1004776ce3d9f3ab343fc15ca4ea42
```

Finally confirm the keystore you will sign with **is** the admin (this prompts for the keystore password, reads
nothing else): `cast wallet address --account teraswap-admin` → must print `$ADMIN`.

---

## 5. Dry-run (no broadcast)

### 5a. `eth_call` simulation with the admin as `msg.sender` — run 2026-09-11, outputs recorded

```bash
cast call --from $ADMIN $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $WETH $FEED_WETH 18 $ST_WETH --rpc-url "$RPC_URL"
cast call --from $ADMIN $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $USDC $FEED_USDC 6  $ST_USDC --rpc-url "$RPC_URL"
```

**Expected output for each: `0x` and exit code 0** (the function returns nothing; a revert would print the
selector). Observed 2026-09-11 against the live Arbitrum state: `0x` / exit 0 for both.

Negative controls — these **must** revert, proving the simulation discriminates (observed 2026-09-11):

```bash
cast call --from 0x000000000000000000000000000000000000dEaD $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $WETH $FEED_WETH 18 $ST_WETH --rpc-url "$RPC_URL"
#   => execution reverted, data: "0x7bfa4b9f"   NotAdmin()
cast call --from $ADMIN $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $WETH 0x0000000000000000000000000000000000000000 18 $ST_WETH --rpc-url "$RPC_URL"
#   => execution reverted, data: "0xd92e233d"   ZeroAddress()
cast call --from $ADMIN $V3 "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" 0x1111111111111111111111111111111111111111111111111111111111111111 $WETH $FEED_WETH 18 $ST_WETH --rpc-url "$RPC_URL"
#   => execution reverted, data: "0xdfc44acf"   TimelockNotQueued()
```

> The `actionId` a `cast call` would produce is meaningless (nothing is persisted; the timestamp differs from
> the real send). 5a only proves the call **will not revert**.

### 5b. Full fork simulation (optional; what this runbook was validated with — Appendix C)

```bash
anvil --fork-url "$RPC_URL" --port 8547 --host 127.0.0.1          # terminal 1 — local fork, nothing leaves the machine
export F=http://127.0.0.1:8547                                     # terminal 2
cast rpc anvil_impersonateAccount $ADMIN --rpc-url $F
cast rpc anvil_setBalance $ADMIN 0x8AC7230489E80000 --rpc-url $F                  # fork-only gas (10 ETH of fake balance)
QTX=$(cast send $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $WETH $FEED_WETH 18 $ST_WETH --from $ADMIN --unlocked --rpc-url $F --json | jq -r .transactionHash)
AID=$(cast receipt $QTX --rpc-url $F --json | jq -r '.logs[] | select(.topics[0]=="0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0") | .topics[1]')
cast call $V3 "timelockActions(bytes32)(bytes32,uint256,bool)" $AID --rpc-url $F        # (actionHash §0, ts+172800, true)
cast rpc evm_increaseTime 172801 --rpc-url $F; cast rpc evm_mine --rpc-url $F
cast send $V3 "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" $AID $WETH $FEED_WETH 18 $ST_WETH --from $ADMIN --unlocked --rpc-url $F
```

⚠️ **Known fork artefact:** after warping 48 h the forked feed's `updatedAt` is frozen at fork time, so the
execute above reverts `"Feed seems dead (>24h stale)"` (line 1011) — that is the guard working on stale fork
data, not a production problem (the live feeds update every ≤ ~30 min / ~4.5 min). Appendix C shows the
execute path proven instead by shortening `readyAt` in fork storage (`timelockActions` is slot 9,
`readyAt` at `keccak256(abi.encode(actionId, 9)) + 1`) — a simulation-only shortcut that must never be
mistaken for a real procedure.

---

## 6. QUEUE (broadcast — owner, admin key, after Auditor sign-off)

Two transactions, one per token. Queue them back-to-back so their 48 h windows align.

```bash
cast send $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $WETH $FEED_WETH 18 $ST_WETH \
  --rpc-url "$RPC_URL" --account teraswap-admin
cast send $V3 "queueTokenUsdFeed(address,address,uint8,uint256)" $USDC $FEED_USDC 6 $ST_USDC \
  --rpc-url "$RPC_URL" --account teraswap-admin
```

Capture both tx hashes, then extract each `actionId` from **its own** receipt's `TimelockQueued` event:

```bash
export QTX_WETH=<queue-tx-hash-weth> QTX_USDC=<queue-tx-hash-usdc>
T0=0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0
for N in WETH USDC; do eval Q=\$QTX_$N
  R=$(cast receipt $Q --rpc-url "$RPC_URL" --json)
  echo "$N status=$(echo "$R" | jq -r .status) to=$(echo "$R" | jq -r .to)"                       # status 0x1, to == $V3 (case-insensitive)
  AID=$(echo "$R" | jq -r ".logs[] | select(.topics[0]==\"$T0\") | .topics[1]")
  AH=$(echo "$R" | jq -r ".logs[] | select(.topics[0]==\"$T0\") | .data" | cut -c1-66)             # actionHash = first word of data
  QBLK=$(echo "$R" | jq -r .blockNumber); QTS=$(cast block $QBLK --field timestamp --rpc-url "$RPC_URL")
  echo "$N actionId=$AID actionHash=$AH queueBlock=$((QBLK)) queueTs=$QTS"
  echo "$N recomputed actionId=$(cast keccak $(cast abi-encode 'x(bytes32,uint256)' $AH $QTS))"    # must equal actionId
  eval export AID_$N=$AID QTS_$N=$QTS QBLK_$N=$((QBLK))
done
```

**Deterministic cross-checks (all must hold):** `actionHash` equals the §0 value for that token; the
recomputed `actionId` equals the event's; `status=0x1`; `to` is `$V3`. If a queue tx reverted or a hash
differs, do **not** proceed — cancel anything that did land (§11) and re-run §4.

---

## 7. Verify the queue landed (read-only)

```bash
for N in WETH USDC; do eval A=\$AID_$N; eval T=\$QTS_$N
  cast call $V3 "timelockActions(bytes32)(bytes32,uint256,bool)" $A --rpc-url "$RPC_URL" | tr '\n' ' '; echo "  (expect readyAt = $((T + 172800)))"
done
cast logs --from-block $QBLK_WETH --address $V3 $T0 --rpc-url "$RPC_URL"                # exactly TWO TimelockQueued events from this session
```

Expect per token: `actionHash` == §0 value · `readyAt` == `queueTs + 172800` · `exists` == `true`. Repeat
on `$RPC_URL2`. If `cast logs` shows a **third** `TimelockQueued` you did not intend (a retried send),
cancel it now (§11) — it would otherwise stay executable for 9 days.

---

## 8. Wait — earliest and latest valid execute timestamps, from the queue block

```bash
for N in WETH USDC; do eval T=\$QTS_$N
  E=$((T + 172800)); L=$((T + 172800 + 604800))
  echo "$N  earliest execute: $E ($(date -u -r $E +%Y-%m-%dT%H:%M:%SZ))   latest execute: $L ($(date -u -r $L +%Y-%m-%dT%H:%M:%SZ))"
done
```

(`date -u -r` is macOS; on Linux use `date -u -d @$E`.) Execute is valid when the **execute block's**
timestamp is in **[earliest, latest]** inclusive (lines 997–998). Set two calendar reminders: `earliest`
and `latest − 24h`. After `latest` the entries `TimelockExpired` and the whole 48 h restarts.

---

## 9. EXECUTE (broadcast — owner, admin key, after `earliest`, before `latest`)

Re-extract the `actionId`s from the queue receipts **at this moment** (re-run the §6 extraction block —
never from notes), then, using **exactly** the four parameters queued:

```bash
cast send $V3 "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" $AID_WETH $WETH $FEED_WETH 18 $ST_WETH \
  --rpc-url "$RPC_URL" --account teraswap-admin
cast send $V3 "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" $AID_USDC $USDC $FEED_USDC 6 $ST_USDC \
  --rpc-url "$RPC_URL" --account teraswap-admin
```

Each receipt must carry **both** `TimelockExecuted` (`0x26a539…`) and `TokenUsdFeedConfigured` (`0x91dc68…`):

```bash
cast receipt <execute-tx-hash> --rpc-url "$RPC_URL" --json | jq -c '[.status, [.logs[].topics[0]]]'
# => ["0x1",["0x26a53932…ec21d","0x91dc6839…04f86"]]
```

If it reverts: `0x7378c19d` → too early (§8) · `0x7a6fcaa6` → window missed, re-queue · `0x522dbb19` → a
parameter differs from what was queued (re-check §6 hashes) · `0xdfc44acf` → wrong/cancelled/consumed
`actionId` · `"Feed seems dead (>24h stale)"` / `"Feed returns invalid price"` → the feed itself is broken —
**stop and escalate**, do not "fix" by re-queueing.

---

## 10. Verify the registry — positive reads AND the negative control (both RPCs)

```bash
for R in "$RPC_URL" "$RPC_URL2"; do echo "== $R"
  cast call $V3 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" $WETH --rpc-url "$R" | tr '\n' ' '; echo
  #  => $FEED_WETH 8 18 3596 true
  cast call $V3 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" $USDC --rpc-url "$R" | tr '\n' ' '; echo
  #  => $FEED_USDC 8 6 596 true
  cast call $V3 "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" $DAI  --rpc-url "$R" | tr '\n' ' '; echo
  #  => 0x0000000000000000000000000000000000000000 0 0 0 false      <-- NEGATIVE CONTROL: must be UNCHANGED
  cast call $V3 "timelockActions(bytes32)(bytes32,uint256,bool)" $AID_WETH --rpc-url "$R" | tr '\n' ' '; echo   # => 0x00…00 0 false (consumed)
done
cast logs --from-block <execute-block> --address $V3 0x91dc6839f4d9e3cc1fd75939365d83dd3f043e433865289cce282a75f1404f86 --rpc-url "$RPC_URL"   # exactly 2 TokenUsdFeedConfigured
```

Then the verifier's oracle checkpoint, per token, as the Base and Arbitrum deploy runbooks prescribe:

```bash
cd contracts/order-engine
forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 --rpc-url "$RPC_URL" \
  --sig "checkOracleFeed(address,address,uint256)" $V3 $WETH $ST_WETH
forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 --rpc-url "$RPC_URL" \
  --sig "checkOracleFeed(address,address,uint256)" $V3 $USDC $ST_USDC
```

Both must print `[OK] token registered` and pass the live `decimals()` + freshness asserts.

**This is the sole acceptance criterion for this runbook** — the on-chain `tokenUsdFeeds` read (above) plus
the `checkOracleFeed` script pass. There is **no** product-visible check to run alongside it:
`ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS = [8453]` (`config.ts:117-121`) means `getOrderExecutorV3(42161)` resolves
`null`, so the Arbitrum DCA panel renders "DCA is not available on Arbitrum One yet." (`DCAPanel.tsx:1119`)
and never reaches the feed-coverage read this runbook populates — even immediately after a perfect execute.
Do **not** use the DCA panel as a check for this runbook; it will show the unavailable message regardless of
whether §9 succeeded, and that is expected (§12). **Follow-up (separate PR, not this runbook):** record the
two execute tx hashes and the registered tuples in `docs/DEPLOYMENTS.md` and clear its "oracle floor is
unconfigured" warning for 42161.

---

## 11. Cancel / rollback

**Cancel a queued-but-not-executed action** — instant, no delay, any time before execute (proven on the fork,
Appendix C: non-admin → `NotAdmin`; admin → `TimelockCancelled`, entry zeroed, registry untouched):

```bash
cast send $V3 "cancelTimelockAction(bytes32)" $AID_WETH --rpc-url "$RPC_URL" --account teraswap-admin
cast call $V3 "timelockActions(bytes32)(bytes32,uint256,bool)" $AID_WETH --rpc-url "$RPC_URL"   # => 0x00…00 0 false
```

**After execute there is no unregister** (§1.3). To change a registered entry, queue a **replacement**
registration for the same `token` with the corrected `feed`/`tokenDecimals`/`maxStaleness` — same §6→§9 flow,
same 48 h — and `executeTokenUsdFeed` overwrites the struct (line 1013). The only **instant** lever is
`pause()` (903–907), which halts every Arbitrum fill, not just this pair — an incident, not a rollback.

---

## 12. Gates & notes

- **Auditor sign-off obtained before §6** (CLAUDE.md #2/#3): the Auditor reviewed the §2.4 comparison and the
  owner adopted **Option C** (`3596` / `596`) over this runbook's original Option A proposal; everything else
  in this runbook was already measured, not chosen.
- **Product surface note:** registering these feeds does **not** make Arbitrum DCA appear in the UI. The DCA
  panel stays on its "DCA is not available on Arbitrum One yet." message (`DCAPanel.tsx:1119`) until `42161`
  is added to `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` (`config.ts:117-121`) in its **own, separately audited PR**
  — do not read that message after this runbook's §9 as a failed registration; verify with §10 instead.
- **Zero transactions, zero keys** were involved in producing this runbook: public-RPC `eth_call`/`eth_getCode`,
  one HTTPS fetch of Chainlink's published JSON, and a local `anvil` fork with an impersonated admin.
- This runbook changes **no source, config, keeper or host**. The keeper-side prerequisites for Arbitrum fills
  (`ARBITRUM-V3-EXECUTOR-DEPLOY.md` BLOCKER box; `INC-2026-08-26-001` §11) are untouched and unaffected — a
  registered feed lets orders be *created*; it does not make them *fill*.
- Only WETH and USDC are in scope. USDT/DAI/WBTC have verified feeds (`chainlink-feeds.ts:86-91`) but need
  their own heartbeat-derived `maxStaleness` (DAI/WBTC publish at 86400 s) and their own Auditor pass — DAI
  is this runbook's negative control precisely because it is **not** being registered.
- Native ETH as a DCA *output* is signed as the chain's wrapped native since #488/#490, so the WETH entry
  covers ETH-out orders; the `0xEeee…EEeE` sentinel is intentionally never registered.
- Fresh-block rule (`ARBITRUM-V3-EXECUTOR-DEPLOY.md` gate 1): §4 must be re-run on the day of §6 and again on
  the day of §9 — the readings in this document are evidence for the Auditor, not a substitute.
- **Out of scope:** `oracleConfigs(ETH/USD)` is unregistered on 42161, so Limit/SL-TP trigger checks on
  Arbitrum would run on the global `MAX_STALENESS` (300 s) rather than a feed-specific value — a separate
  decision, not addressed by this runbook.

---

## Appendix A — on-chain verification transcript (2026-09-11, read-only)

```
RPC=https://arb1.arbitrum.io/rpc            chainId 42161  block 504034261  ts 1789125896 (2026-09-11T11:24:56Z)
RPC=https://arbitrum-one-rpc.publicnode.com chainId 42161  block 504034390  ts 1789125929 (2026-09-11T11:25:29Z)
code sizes (identical on both):  V3 18247 B · ADMIN 0 B · FEED_WETH 9571 B · FEED_USDC 9571 B · WETH 2092 B · USDC 1852 B · DAI 4926 B
V3: admin()=0x9A387f681a7674F10d255f5b2651EBc4c672C73C  sequencerUptimeFeed()=0xFdB631F5EE196F0ed6FAa767959853A9F217697D
    WETH()=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1  paused()=false  bootstrapped()=true
    TIMELOCK_ORACLE_CHANGE()=172800  TIMELOCK_GRACE()=604800  MAX_STALENESS()=300  SEQUENCER_GRACE_PERIOD()=3600
    ORDER_TYPEHASH()=0xfc939b7409c57e9f4898a3d99474d4ac4900eadc353ab145624aa7cc7204cbc0
tokenUsdFeeds: WETH → (0x0, 0, 0, 0, false)   USDC → (0x0, 0, 0, 0, false)   DAI → (0x0, 0, 0, 0, false)
tokens: WETH decimals=18 symbol="WETH"   USDC decimals=6 symbol="USDC"   DAI decimals=18 symbol="DAI"
FEED_WETH 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612: decimals()=8 description()="ETH / USD" version()=6 aggregator()=0xD827123D014578C965F6c9d87A641ec05FaA5501
FEED_USDC 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3: decimals()=8 description()="USDC / USD" version()=6 aggregator()=0xb10cb22245D54f58C66eE65353FaB5D94ca21A1C
sequencer 0xFdB6…697D: description()="L2 Sequencer Uptime Status Feed" answer=0 (up) startedAt=1779307607

block-pinned latestRoundData (both RPCs returned identical rounds):
  block 504036692 ts 1789126505 (2026-09-11T11:35:05Z)
  ETH/USD  roundId=36893488147419218033 answer=245411113784 startedAt=1789126328 updatedAt=1789126340 answeredInRound=36893488147419218033 age=165s  answeredInRound>=roundId=True answer>0=True phase=2
  USDC/USD roundId=55340232221128661771 answer=99985837     startedAt=1789126469 updatedAt=1789126482 answeredInRound=55340232221128661771 age=23s   answeredInRound>=roundId=True answer>0=True phase=3
```

## Appendix B — feed cadence samples (`getRoundData` on the aggregator directly, batched `eth_call`,
re-measured 2026-09-11 for the Auditor's Option C review — ETH/USD ≥5 d, USDC/USD ≥14 d)

```
ETH/USD  aggregator=0xD827123D014578C965F6c9d87A641ec05FaA5501 (phase 2)  latest sampled aggregatorRoundId=114945
  sampled rounds=3546 (agg ids 111400..114945) window=545177s (151.4h = 6.31d) 2026-09-05T06:27:07Z → 2026-09-11T13:53:24Z
  gap stats (s): min=16 median=90 p90=330 p99=930 max=1771   published heartbeat=1755s  max/heartbeat=1.009
  gaps > heartbeat: 2/3545   gaps > 1.5x heartbeat: 0   gaps > 2x: 0   integrity failures: 0
  transmission latency (updatedAt-startedAt, s): min=12 median=12 max=72
USDC/USD aggregator=0xb10cb22245D54f58C66eE65353FaB5D94ca21A1C (phase 3)  latest sampled aggregatorRoundId=6953
  sampled rounds=4701 (agg ids 2253..6953) window=1271960s (353.3h = 14.72d) 2026-08-27T20:30:26Z → 2026-09-11T13:49:46Z
  gap stats (s): min=30 median=270 p90=271 p99=330 max=331     published heartbeat=255s   max/heartbeat=1.298
  gaps > heartbeat: 4682/4700   gaps > 1.5x heartbeat: 0   gaps > 2x: 0   gaps > 300s (global MAX_STALENESS): 85/4700   integrity failures: 0
  transmission latency (updatedAt-startedAt, s): min=12 median=13 max=253
```

## Appendix C — local anvil fork transcript (impersonated admin; nothing broadcast; re-run for Option C, 2026-09-11)

```
fork chainId=42161 block=504072023  (fork 1, port 8547)
registry BEFORE: WETH=[0x0,0,0,0,false] USDC=[0x0,0,0,0,false]
QUEUE (ST_WETH=3596, ST_USDC=596)
  WETH queue block=504072024 ts=1789135375  actionId(event)=0x16348ea654c54b3002f1e3c88e707ae4c90e9eca4efc350d260d242657e75c9c
       actionHash(event)=0x21a777eaf762bc6c5a0ebfa965acd6c8dc9137ba3159eaf32810034a04e8967c  matches precomputed (§0): YES
       timelockActions(actionId)=[0x21a777…8967c, 1789308175, true]   readyAt − ts = 172800
  USDC queue block=504072025 ts=1789135376  actionId(event)=0x9a1ca1d31810371ba6c3a66cbc66153d3547ca43690c2e46dfcba2e2209eb114
       actionHash(event)=0xbf199f5c374ee648ce2295c3b4a2a8c88c1004776ce3d9f3ab343fc15ca4ea42  matches precomputed (§0): YES
execute BEFORE readyAt                      → reverted 0x7378c19d (TimelockNotReady)
evm_increaseTime 172801 → fork ts 1789308176
execute with WRONG params (staleness+1=3597) → reverted 0x522dbb19 (TimelockHashMismatch)
execute with RIGHT params, feed frozen 48h  → reverted "Feed seems dead (>24h stale)"   (line 1011 — fork artefact, §5b)

fork chainId=42161 block=504072023  (fork 2, port 8548 — readyAt shortened in storage; simulation-only;
timelockActions confirmed at slot 9 — base = keccak256(abi.encode(actionId, 9)), word0 == actionHash)
re-queued at fork-2 timestamp 1789135446: WETH actionId=0xc145f046253d2d2b7b98834b43549fd1c7d4e073f79f41f3f58d02a7385855c1
                                           USDC actionId=0x5cb575a997c5851257e1d6ec79bf8bc0b57a7207c63f064f6832324d156620e6
  storage at base+1 (readyAt) set to 1789135446 (= now) for both actionIds — no time warp needed, so the feed is not stale
  WETH execute status=0x1 topics0=[TimelockExecuted 0x26a53932…, TokenUsdFeedConfigured 0x91dc6839…]
  USDC execute status=0x1 topics0=[TimelockExecuted 0x26a53932…, TokenUsdFeedConfigured 0x91dc6839…]
  registry AFTER: WETH=[0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612, 8, 18, 3596, true]
                  USDC=[0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3, 8, 6, 596, true]
                  DAI (NEGATIVE CONTROL)=[0x0000000000000000000000000000000000000000, 0, 0, 0, false]
  re-execute WETH actionId → reverted 0xdfc44acf (TimelockNotQueued)
CANCEL (fork 2, fresh WETH queue, distinct actionId=0x40dd1aea0bfca516a41c7883a028bcd8556c1323cca9a3aebc179d52ec7e6be4)
  cancel from 0x…dEaD → reverted 0x7bfa4b9f (NotAdmin)
  cancel from admin → status=0x1 topics0=[TimelockCancelled 0xa32a56a4…];  entry after=[0x00…00, 0, false]
  registry WETH unchanged after cancel: [0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612, 8, 18, 3596, true]
```
