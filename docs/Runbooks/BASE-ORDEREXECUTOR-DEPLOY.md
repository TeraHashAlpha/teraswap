# Runbook — Deploy TeraSwapOrderExecutor on Base (8453)

**Goal:** deploy a real OrderExecutor on Base so conditional orders (DCA first) can launch there. Today
Base has only the **FeeCollector** at `0xeFC3…f130`; there is **no OrderExecutor on Base** (verified
2026-06-13, see `docs/DEPLOYMENTS.md`). This deploys the same audited contract that is live on mainnet.

**Owner-executed** (on-chain). Architect prepared this; Code Agent does the post-deploy wire-up (Step 8).
Same Foundry + keystore setup you used for the Augustus governance.

> **v3 successor:** this contract (v2) is superseded by the audited, non-upgradeable
> `TeraSwapOrderExecutorV3` (ADR-013 §1–§3 — real on-chain output floor, resolved `routerDataHash`, Permit2
> nonce bitmap). Deploying v3 does **not** replace v2 in place — it's a new address running alongside v2
> until v2's outstanding orders drain. See `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` for the v3 deploy runbook
> (mirrors this document's structure + router/bootstrap pattern).

---

## 0. Required inputs / decisions (fill BEFORE starting)

| Input | Value | Notes |
|-------|-------|-------|
| `_feeRecipient` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | matches Base FeeCollector + mainnet (verified on-chain) |
| `_admin` | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | matches Base FeeCollector admin (verified) |
| `_weth` (Base) | `0x4200000000000000000000000000000000000006` | Base canonical WETH |
| **Keeper / executor address** | `0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe` | Dedicated self-hosted executor wallet (encrypted keystore, distinct from admin/recipient). Whitelisted via `bootstrap`. **Must hold Base ETH (pays gas).** Runtime key must live in KMS/Vault (plaintext refused on Base — see CHORE-EXECUTOR-KEY-GUARD). |
| **Router set to whitelist** | see Step 5 | **DECISION:** recommend the DIRECT DEX/aggregator routers only; **exclude CoW relayer + Bebop** (intent/RFQ — not keeper-executable for market orders). |
| Deployer wallet | `<your keystore account>` | must hold Base ETH for gas; will become the deployer (a different nonce → a NEW address, NOT 0xeFC3). |
| BaseScan API key | `<for --verify>` | for source verification |

---

## 1. Pre-deploy checks
```bash
cd "contracts/order-engine"
forge build                 # compiles clean
forge test                  # expect 19/19 passing
```
- Confirm audit status **0C/0H** — `contracts/order-engine/audit-report-v2.md` ("3 Critical: None; 2 High:
  None confirmed"). Known **Medium** items M-01 (fee rounding) + M-02 (DCA truncation) are accepted/backlog
  (SC-02 DCA dust) — acceptable per rule #3 (bar is 0C/0H). Same bytecode is already live on mainnet.
- Deployer has Base ETH for gas; keystore unlocked; BaseScan API key ready.

## 2. Deploy (forge create)
> The Base deploy gets a **NEW address** (deployer nonce on Base differs). Record it — call it `$OE_BASE`.
```bash
forge create TeraSwapOrderExecutor.sol:TeraSwapOrderExecutor \
  --rpc-url https://mainnet.base.org \
  --account <your-keystore> \
  --constructor-args \
    0x107F6eB7C3866c9cEf5860952066e185e9383ABA \
    0x9A387f681a7674F10d255f5b2651EBc4c672C73C \
    0x4200000000000000000000000000000000000006 \
  --verify --verifier etherscan \
  --etherscan-api-key <BASESCAN_API_KEY> \
  --broadcast
```
Save the deployed address → `export OE_BASE=0x...`

## 3. Bootstrap routers + executor (one-shot, onlyAdmin)
`bootstrap(address[] routers, address[] executors)` whitelists in a single tx and can only run **once**
(`bootstrapped` flag). Routers must be deployed contracts (it checks `extcodesize`).

Recommended Base router set (direct DEX/aggregators — confirm before running):
```
1inch      0x111111125421cA6dc452d289314280a0f8842A65
0x v2      0x0000000000001fF3684f28c67538d4D072C22734
Velora     0x6A000F20005980200259B80c5102003040001068
Odos       0x19cEeAd7105607Cd444F5ad10dd51356436095a1
KyberSwap  0x6131B5fae19EA4f9D964eAc0408E4408b66337b5
OpenOcean  0x6352a56caadC4F1E25CD6c75970Fa768A3304e64
SushiSwap  0xAC4c6e212A361c968F1725b4d055b47E63F80b75
Balancer   0xBA12222222228d8Ba445958a75a0704d566BF2C8
Uniswap V3 0x2626664c2603336E57B271c5C0b26F421741e481
Curve      0x4f37A9d177470499A2dD084621020b023fcffc1F
```
> ⚠️ **Excluded on purpose:** CoW VaultRelayer (`0xC92E…`) + Bebop (`0xbeb0…`) — intent/RFQ venues that
> need off-chain solver/signature flows, not keeper-submitted market execution. Add later only if the
> keeper supports them. (Routers can be added afterwards via the timelocked `queueRouterChange`.)
```bash
cast send $OE_BASE \
  "bootstrap(address[],address[])" \
  "[0x111111125421cA6dc452d289314280a0f8842A65,0x0000000000001fF3684f28c67538d4D072C22734,0x6A000F20005980200259B80c5102003040001068,0x19cEeAd7105607Cd444F5ad10dd51356436095a1,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0x6352a56caadC4F1E25CD6c75970Fa768A3304e64,0xAC4c6e212A361c968F1725b4d055b47E63F80b75,0xBA12222222228d8Ba445958a75a0704d566BF2C8,0x2626664c2603336E57B271c5C0b26F421741e481,0x4f37A9d177470499A2dD084621020b023fcffc1F]" \
  "[0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe]" \
  --rpc-url https://mainnet.base.org --account <your-keystore>
```

## 4. Verify source on BaseScan
If `--verify` in Step 2 succeeded, confirm BaseScan shows **TeraSwapOrderExecutor** / *Exact Match*. (This
time the label will be correct — unlike the FeeCollector at 0xeFC3 which is mislabeled "OrderExecutor".)

## 5. Post-deploy verification (cast — all must pass)
```bash
cast call $OE_BASE "feeRecipient()(address)"  --rpc-url https://mainnet.base.org   # 0x107F…
cast call $OE_BASE "admin()(address)"         --rpc-url https://mainnet.base.org   # 0x9A38…
cast call $OE_BASE "WETH()(address)"          --rpc-url https://mainnet.base.org   # 0x4200…0006
cast call $OE_BASE "bootstrapped()(bool)"     --rpc-url https://mainnet.base.org   # true
# each router → true:
cast call $OE_BASE "whitelistedRouters(address)(bool)" 0x2626664c2603336E57B271c5C0b26F421741e481 --rpc-url https://mainnet.base.org
# keeper → true:
cast call $OE_BASE "whitelistedExecutors(address)(bool)" 0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe --rpc-url https://mainnet.base.org
# sanity: it IS the executor, not a FeeCollector — executeOrder selector present, swap selectors absent:
cast code $OE_BASE --rpc-url https://mainnet.base.org | grep -o 6233f5c2   # executeOrder → present
```

## 6. Wire-up (Code Agent — give it `$OE_BASE`)
> Goal: set `ORDER_EXECUTOR_BY_CHAIN[8453] = $OE_BASE` in `src/lib/order-engine/config.ts` (replacing the
> `null`), keep mainnet unchanged, add/adjust the test that currently pins Base→null to the new address,
> confirm `getOrderExecutor(8453)` now returns it and `getOrderExecutorDomain(8453)` no longer throws.
> Branch `chore/base-order-executor-wire`, signed commit, CI + test-contracts green, FEEDBACK. Do NOT
> un-gate the DCA tab in this commit (that's the go-live step).

## 7. NOT YET — go-live (separate, gated)
After wire-up, conditional orders on Base still need, before un-gating the DCA tab:
- Keeper infra running on Base (cron → `canExecute` → `executeOrder`), funded, monitored.
- Oracle/sequencer gates confirmed on the Base execution path.
- Execution monitoring + alerts + kill-switch cover Base order execution.
- End-to-end test with a tiny real DCA order on Base.
- Staged/beta rollout.

## Safety notes
- `bootstrap` is one-shot; later router changes go through **timelocked** `queueRouterChange` (not instant).
- Fund-sweep is timelocked (`queueSweep`/`executeSweep`). Contract is pausable (admin).
- The deploy is the **same audited bytecode** as the live mainnet OrderExecutor — only constructor config
  (Base WETH) + the bootstrapped Base router/keeper set differ.
