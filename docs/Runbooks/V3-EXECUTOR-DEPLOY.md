# Runbook — Deploy TeraSwapOrderExecutorV3 (ADR-013 §1–§3)

**Goal:** deploy the audited, non-upgradeable `TeraSwapOrderExecutorV3` (closes threat-model P1a/P1b/P1c —
real on-chain output floor, resolved `routerDataHash`, Permit2-style unordered nonces) and cut DCA signing
over to it, **Base (8453) first** (DCA is live there today). Mainnet is a deferred template (§ below) — deploy
only if/when DCA activates on mainnet.

**Owner-executed** (on-chain + Vercel/keeper env). This runbook is prepared by the Architect/Code Agent; the
owner runs every command manually. Mirrors `BASE-ORDEREXECUTOR-DEPLOY.md` (v2's Base deploy) and
`AWS-KMS-EXECUTOR-SETUP.md` (timelock/KMS discipline) — read both first if you haven't done a TeraSwap
contract deploy before.

**Gate: this runbook may not be executed until ALL of the following are true.** If any is false, STOP:
1. PR #301 (M-01 fix + v3 cancel single/mass) is **merged** to `main`.
2. The **mandatory pre-deploy Auditor pass** (ADR-013 deploy step 2 — covers the #301 delta + this
   runbook/scripts + final repo state) is recorded **0C/0H**. Cite the audit doc / PR review here before
   proceeding: `_______________`.
3. v3 cancel support (single + mass) is confirmed **live in the production frontend build** (not just merged
   to `main` — verify the deployed Vercel build hash includes PR #301).
4. Phase-0 `contracts/order-engine/executor/order-floor.js` + `submission-policy.js` are confirmed **ACTIVE**
   in the running keeper. They are the interim, not a replacement — they stay wired for BOTH v2 and v3 fills
   until v3 is live on **every** DCA chain (today: Base only, so this condition is trivially met once Base
   v3 is live, but do not touch these files as part of cutover — see §7).

---

## 0. Required inputs / decisions (fill BEFORE starting)

| Input | Value | Notes |
|-------|-------|-------|
| `_feeRecipient` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | matches Base FeeCollector + v2 OrderExecutor (verified, `docs/DEPLOYMENTS.md`) |
| `_admin` | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | matches v2's admin — **all v3 admin actions (router/oracle/admin/sweep/executor changes) already run through the CONTRACT'S OWN 48h/7d queue→execute timelock** (`TIMELOCK_ROUTER_CHANGE`/`TIMELOCK_ORACLE_CHANGE`/`TIMELOCK_ADMIN_TRANSFER`/`TIMELOCK_SWEEP`/`TIMELOCK_EXECUTOR_CHANGE`); there is no separate external Timelock contract. "Owner = the 48h timelock" means: this admin address's power is *already* delay-gated by the contract itself, not that it must be a different address than v2's. |
| `_weth` (Base) | `0x4200000000000000000000000000000000000006` | Base canonical WETH |
| `_sequencerUptimeFeed` (Base) | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | Chainlink Base L2 sequencer-uptime feed (`src/lib/chains/registry.ts`). **Mainnet: pass `address(0)`** — no sequencer, per the contract's own doc comment. |
| **Keeper / executor address** | `<current Base keeper signing address>` | Read it, don't assume: whichever address is whitelisted as executor on the LIVE v2 Base contract today (KMS-derived per `AWS-KMS-EXECUTOR-SETUP.md`, not necessarily `0xd7F9…` from the original bootstrap doc — `cast call $OE_V2_BASE "whitelistedExecutors(address)(bool)" <addr>` to confirm before reusing it here). **Must hold Base ETH.** Runtime key must live in KMS/Vault — plaintext refused (CHORE-EXECUTOR-KEY-GUARD; the deploy script below refuses too, see §2). |
| **Router to whitelist (bootstrap)** | see §2 Step 2 — **Base Augustus V6, address RE-VERIFIED on-chain at deploy time** (§2 Step 1) | v3-P1 is signing-flow parity with v2 for DCA; bootstrap with the SAME router set v2 uses on Base today (`docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md` §3) unless the owner wants a narrower initial set. |
| Deployer wallet | `<your keystore account>` | must hold Base ETH for gas; becomes deployer (new nonce → NEW address, not the v2 address) |
| BaseScan API key | `<for --verify>` | source verification |
| **v2 Base OrderExecutor (for the pre-flight snapshot)** | `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` | `docs/DEPLOYMENTS.md` |

---

## 1. Pre-flight

```bash
cd "contracts/order-engine"
forge build                 # compiles clean
forge test                  # expect the full v2+v3 suite green (113+ as of PR #296/#298)
```

- [ ] All 4 gate conditions above are checked off with citations.
- [ ] `docs/security/AUDIT-TOTAL.md` shows 0C/0H for the v3 contract line item.
- [ ] **Outstanding-order snapshot** (so you know what v2 must still drain post-cutover):
  ```bash
  # via Supabase — count active/executing/partially_filled orders on Base, chain_id=8453
  # (run from an environment with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — do NOT paste keys into this doc)
  ```
  Record the count and the oldest `expiry` here: `_______________`. These are the orders v2 must finish
  executing/expiring/being cancelled after cutover (§6 v2 Drain Policy).
- [ ] Confirm the current Base keeper's `.env.executor` `ORDER_EXECUTOR_ADDRESS` == the v2 address above
  (sanity: you're about to add a SECOND executor, not replace a misconfigured one).

## 2. Deploy

The Foundry script is `contracts/order-engine/script/DeployOrderExecutorV3.s.sol` — **every constructor
input comes from an environment variable BY NAME**, never hardcoded, and the script hard-refuses to run if
`ALLOW_PLAINTEXT_KEY`/`ALLOW_PLAINTEXT_KEY_MAINNET` is set (this is a deploy tx, not a keeper run, but the
refusal mirrors the keeper's own key-guard posture — a deploy is exactly the kind of action a plaintext key
should never sign on a production chain). It also asserts `block.chainid` matches the `EXPECTED_CHAIN_ID` env
var before broadcasting, so a misconfigured `--rpc-url` can't silently deploy to the wrong chain.

### Step 1 — RE-VERIFY the router address on-chain (the Sprint-46 lesson: labels lie)
`SPRINT-46-ARBITRUM-CONFIG` and the FeeCollector mislabel (`docs/DEPLOYMENTS.md` — BaseScan shows the Base
FeeCollector as "TeraSwapOrderExecutor") both confirm: **never trust a block-explorer label or a doc
citation for a router address without an on-chain check at deploy time.** Before bootstrapping:
```bash
# Confirm the Base Augustus V6 address is still a live contract with the expected bytecode size/selector.
cast code 0x6A000F20005980200259B80c5102003040001068 --rpc-url https://mainnet.base.org | wc -c   # non-trivial, not "0x"
# Cross-check against the SAME address already whitelisted + actively used on the LIVE v2 Base contract:
cast call 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598 "whitelistedRouters(address)(bool)" 0x6A000F20005980200259B80c5102003040001068 --rpc-url https://mainnet.base.org   # true
```
Record both outputs here (paste the `cast code` byte length and the whitelist bool) before proceeding —
this IS the "record the check" the pre-deploy gate requires: `_______________`.

### Step 2 — Deploy
```bash
export FEE_RECIPIENT=0x107F6eB7C3866c9cEf5860952066e185e9383ABA
export ADMIN=0x9A387f681a7674F10d255f5b2651EBc4c672C73C
export WETH_ADDRESS=0x4200000000000000000000000000000000000006
export SEQUENCER_UPTIME_FEED=0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
export EXPECTED_CHAIN_ID=8453

forge script script/DeployOrderExecutorV3.s.sol:DeployOrderExecutorV3 \
  --rpc-url https://mainnet.base.org \
  --account <your-keystore> \
  --verify --verifier etherscan --etherscan-api-key <BASESCAN_API_KEY> \
  --broadcast
```
Save the deployed address → `export OE_V3_BASE=0x...`. **Confirm it differs from `$OE_V2_BASE`** (a fresh
deployer nonce guarantees this, but check — an address collision here would mean something is badly wrong).

### Step 3 — Bootstrap (one-shot, `onlyAdmin`)
Same router set as v2's Base bootstrap (`BASE-ORDEREXECUTOR-DEPLOY.md` §3) unless the owner narrows it —
record the decision. Bootstrap ALSO whitelists the keeper executor address (from §0) in the same tx:
```bash
cast send $OE_V3_BASE \
  "bootstrap(address[],address[])" \
  "[<router1>,<router2>,...]" \
  "[<keeper executor address from §0>]" \
  --rpc-url https://mainnet.base.org --account <your-keystore>
```

### Step 4 — Set the fair-value oracle config (timelocked — see §4, do NOT skip)

## 3. Verify

- [ ] BaseScan shows **TeraSwapOrderExecutorV3** / *Exact Match* source. If `--verify` in §2 Step 2 failed or
  the explorer shows a wrong/blank name:
  - **Mislabel precedent check** (this bit TeraSwap once already — Base FeeCollector `0xeFC3…` displays as
    "TeraSwapOrderExecutor" on BaseScan despite being a different contract, `docs/DEPLOYMENTS.md`). Confirm
    the NEW v3 contract shows its OWN correct name, not a stale/cached label from an unrelated deploy.
  - If mislabeled: this does not block cutover (it's cosmetic — the bytecode/ABI are what the keeper and
    frontend actually call), but **document the support path**: BaseScan contract-verification support
    ticket / re-submit source via the "Verify & Publish" flow with the exact compiler settings from
    `foundry.toml` (solc 0.8.28, `via_ir = true`, optimizer 200 runs). Record ticket/status here:
    `_______________`.
- [ ] Run the read-only verifier script (§ below) — **must pass before proceeding to §4**:
  ```bash
  cd contracts/order-engine
  forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 \
    --rpc-url https://mainnet.base.org \
    --sig "run(address,address,address,address,uint256)" \
    $OE_V3_BASE $ADMIN 0x6A000F20005980200259B80c5102003040001068 $SEQUENCER_UPTIME_FEED 8453
  ```
  (Router arg = the re-verified Augustus V6 address from §2 Step 1 — the verifier CHECKS the whitelist
  contains exactly this address and nothing else; it never assumes the address is correct.)

## 4. Oracle config (timelocked — DO NOT skip, DO NOT rush)

`queueTokenUsdFeed`/`executeTokenUsdFeed` register the token→USD Chainlink feeds the §1 output floor reads
at execution (ADR-013 §1). This is the **only** admin surface v3 adds over v2, and it is timelocked
(`TIMELOCK_ORACLE_CHANGE = 48h`) specifically because it decides the on-chain floor (closes P6).

1. **Queue** every token pair the initial DCA panel supports (WETH, USDC, and any curated Base token with a
   real Chainlink feed):
   ```bash
   cast send $OE_V3_BASE "queueTokenUsdFeed(address,address,uint8,uint256)" \
     <token> <chainlinkFeed> <tokenDecimals> <maxStalenessSeconds-or-0> \
     --rpc-url https://mainnet.base.org --account <your-keystore>
   ```
   Record each `actionId` (from the `TimelockQueued` event) and the queue timestamp.
2. **⏱️ Explicit 48h-wait step.** Set a calendar reminder for `queue_timestamp + 48h`. Do not proceed to
   Step 3 before then — `executeTokenUsdFeed` reverts `TimelockNotReady` anyway, but the point of this line
   is to stop you from context-switching away and missing the window (grace period is 7 days after
   `readyAt`, per `TIMELOCK_GRACE` — don't let it lapse either).
3. **Execute** after 48h:
   ```bash
   cast send $OE_V3_BASE "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" \
     <actionId> <token> <chainlinkFeed> <tokenDecimals> <maxStalenessSeconds-or-0> \
     --rpc-url https://mainnet.base.org --account <your-keystore>
   ```
4. **Re-run the verifier script** (§3) — it asserts each configured feed answers with a fresh round and the
   expected decimals. It must pass before §5.

## 5. Cutover

1. **Vercel (frontend):** set for the Base environment —
   ```
   NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = $OE_V3_BASE
   ```
   (name only, per `src/lib/order-engine/config.ts::ORDER_EXECUTOR_V3_BY_CHAIN` — do NOT set the mainnet
   variant `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS` unless deploying mainnet too, § below.)
2. **Keeper env (`.env.executor`):** set —
   ```
   ORDER_EXECUTOR_V3_ADDRESS = $OE_V3_BASE
   ```
   Restart the keeper process; confirm the startup log line `Contract (v3): $OE_V3_BASE` (not "not
   configured").
3. **Effect of setting both:** `getOrderExecutorV3(8453)` stops returning `null` → DCAPanel starts deriving
   real `minAmountOut` + signing v3 orders (PR #299) for Base; the keeper's `resolveExecutorRouting` (PR
   #299) starts routing v3-signed orders to `$OE_V3_BASE` instead of skip+flagging them. **v2 stops
   receiving NEW orders the moment v3 signing goes live in the deployed frontend build** (`DCAPanel`'s
   `v3Enabled` flips true) — v2 keeps executing/cancelling every order it already holds (§6).
4. **e2e smoke — one tiny REAL DCA order, full lifecycle, before declaring done:**
   - [ ] **Create**: sign + submit a DCA order for the smallest allowed amount (respects `MIN_ORDER_AMOUNT`
     per chunk). Confirm the Supabase row's `order_data.maxSlippageBps` is present (v3 order) and the
     `chain_id` is 8453.
   - [ ] **First fill**: wait for the keeper to execute chunk 1. Confirm on BaseScan the tx is `executeOrder`
     against `$OE_V3_BASE` (not `$OE_V2_BASE`), and the output clears the signed floor (no
     `InsufficientOutput` revert, obviously — but also sanity-check the fill amount against the fair-value
     the panel showed at signing).
   - [ ] **Single cancel**: cancel that same order (PR #301's v3 single-cancel path) — confirm the on-chain
     tx targets `$OE_V3_BASE::cancelOrder` and the order shows `cancelled` in the UI + Supabase.
   - [ ] **Mass-cancel path check**: create a second tiny DCA order, then use "Cancel all" — confirm (per PR
     #301) it routes through `invalidateUnorderedNonces` for a non-DCA v3 order OR individual `cancelOrder`
     calls for a v3 DCA order (DCA does NOT consume the bitmap — verified against the audited contract in
     PR #301's FEEDBACK). Confirm the order is cancelled either way.
   - [ ] All four steps pass → cutover is live. Any step fails → **rollback** (§ below) immediately.

## 6. Rollback

- **Before any real v3 order exists** (i.e., you're rolling back during/immediately after §5 before the e2e
  smoke's Create step, or the smoke test itself failed at Create): simply **unset**
  `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` in Vercel and `ORDER_EXECUTOR_V3_ADDRESS` in the keeper env,
  redeploy/restart. `getOrderExecutorV3(8453)` returns to `null` → DCAPanel fails closed back to v2-only
  signing (byte-identical to pre-cutover) and the keeper skip+flags any stray v3 order_data it somehow still
  sees. **This is safe and reversible with zero on-chain cleanup** — no v3 order was ever signed.
- **After a real v3 order exists** (any point past a successful Create in the e2e smoke, or real user orders
  have since been created): you CANNOT un-sign an order a user already holds. Rollback instead means:
  1. Unset the same two env vars → **stops NEW v3 signing** (DCAPanel reverts to v2 for all new orders).
  2. The keeper KEEPS executing and cancelling every EXISTING v3 order against `$OE_V3_BASE` — do not touch
     `ORDER_EXECUTOR_V3_ADDRESS` in the keeper env, only the frontend signing switch. Existing v3 orders must
     still be servable (executed, cancelled, or left to expire) or users are stuck holding unexecutable
     signed orders — the entire point of PR #301 was to make sure this manual-drain path exists.
  3. **Incident record**: append (never overwrite) an `INC-YYYY-MM-DD-NNN` file under `Audits/Incidents/`
     documenting the trigger, the exact rollback timestamp, and the outstanding v3 order count at rollback
     time (same snapshot method as §1). This is a CLAUDE.md convention (rule: incidents are append-only,
     one file per incident) — do not skip it even for a clean/uneventful rollback.

## 7. v2 drain policy (post-cutover, ongoing)

- v2 continues executing every order it already holds until each is filled, cancelled, or expires
  (`MAX_EXPIRY_DAYS = 90`, so worst case ~90 days of dual-executor operation).
- **Monitor BOTH executors** in the keeper's health/metrics output (`Contract (v2):`/`Contract (v3):` startup
  lines, `executor-routing.js`'s per-order routing decision is already logged) — a v2 order silently failing
  post-cutover because attention shifted entirely to v3 would be a real regression.
- **Phase-0 keeper floor retirement criteria (do NOT retire early):** `order-floor.js` +
  `submission-policy.js` stay ACTIVE for both executors until v3 is live on **every** chain that runs DCA —
  today that's Base only, so once Base v3 cutover is complete and v2's Base backlog has fully drained, Phase-
  0 retirement becomes eligible **on Base**. If/when mainnet DCA activates (§ below) before a mainnet v3
  deploy, Phase-0 must stay wired for mainnet too. Retiring Phase-0 is a SEPARATE, explicitly gated follow-up
  sprint — do not fold it into this runbook's cutover step.

## 8. Mainnet (deferred template)

Deploy only if/when DCA activates on mainnet (currently Base-only, ADR-009). Deltas from the Base runbook
above:

| | Base (this runbook) | Mainnet (deferred) |
|---|---|---|
| `_sequencerUptimeFeed` | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | `address(0)` — L1 has no sequencer |
| Router to whitelist | Base Augustus V6 `0x6A000F…1068` | mainnet Augustus **V5** `0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57` (ADR-011 — mainnet uses V5, NOT V6; re-verify on-chain at deploy time exactly as §2 Step 1, do not assume the Base address carries over) |
| Submission relay | Base's private sequencer mempool (no extra config) | **Flashbots Protect RPC required** (`FLASHBOTS_RPC_URL` in the keeper env) — mainnet is a public mempool, `submission-policy.js` fail-closes without it (`ALLOW_PUBLIC_MEMPOOL` override exists but is explicitly discouraged, see `order-floor.js`'s header) |
| `_feeRecipient`/`_admin`/`_weth` | Base values (§0) | mainnet values — `0x107F…`/`0x9A38…`/mainnet WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (same recipient/admin as Base per `docs/DEPLOYMENTS.md`, different WETH) |
| Env var names | `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` / keeper's `ORDER_EXECUTOR_V3_ADDRESS` on the mainnet keeper instance | `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS` (no `_BASE` suffix — mainnet is chain 1's slot in `ORDER_EXECUTOR_V3_BY_CHAIN`) |

Everything else (pre-flight gate, deploy script invocation, verifier script, oracle-config timelock
discipline, e2e smoke shape, rollback semantics, v2 drain policy) is identical — copy this runbook's
structure and substitute the table above.

## Safety notes
- `bootstrap` is one-shot; later router changes go through the contract's own **timelocked**
  `queueRouterChange` (not instant) — same pattern as v2.
- `MAX_ORDER_SLIPPAGE_BPS = 500` is a compile-time immutable constant with **no setter** — nothing to
  configure, the verifier script just confirms the deployed bytecode reads 500.
- Fund-sweep is timelocked (`queueSweep`/`executeSweep`). Contract is pausable (`admin`-only, instant — no
  timelock on pause/unpause, matching v2's kill-switch posture).
- v3 cancel/invalidate (single + mass) is the HARD pre-deploy prerequisite this whole runbook exists to
  satisfy (PR #301) — do not execute §2 (Deploy) if #301 is not merged and confirmed live (gate condition 1
  + 3 in the preamble).

## Cross-reference
- `docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md` — the v2 Base deploy this mirrors (router set, bootstrap
  pattern, mislabel precedent).
- `docs/Runbooks/AWS-KMS-EXECUTOR-SETUP.md` — keeper signing-key discipline (same executor-change timelock
  applies to v3, same KMS setup covers both contracts' key).
- `docs/ADR/ADR-013-order-onchain-floor.md` — the design this deploys; deploy-plan status note added there.
