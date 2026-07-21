# Runbook — Deploy TeraSwapOrderExecutorV3 on Arbitrum One (42161)

> **Status: PREPARATION ONLY (SPRINT-48-ARBITRUM-DCA-PREP).** This runbook is written so the owner
> CAN later run the deploy — nothing in it has been executed. No contract is deployed, no env var is
> set, the keeper has not been touched. Adapted from `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` (the Base
> deploy this mirrors) — read that runbook's §1/§4/§5/§6/§7 first if you haven't done a TeraSwap v3
> deploy before; only the deltas specific to Arbitrum are elaborated fully here.

**BLOCKER — do not start §2 (Deploy) until this box is checked:**
> Cutover (§5 below) requires a **multi-chain-aware keeper** — the current keeper
> (`contracts/order-engine/executor/executor.js`) is single-chain (Base-only `ORDER_EXECUTOR_V3_ADDRESS`,
> single RPC, single `resolveExecutorRouting` target). SPRINT-48-ARBITRUM-DCA-PREP explicitly does
> **NOT** touch the keeper — that work is sequenced as a **separate, later sprint** (post the P1b
> keeper-architecture decision, ADR-014) specifically to avoid conflicting with this sprint's edits to
> `src/lib/order-engine/config.ts`. Deploying this contract before that keeper sprint merges leaves
> Arbitrum with a live, biddable OrderExecutorV3 and **no process able to execute fills against it** —
> orders would sit `active` forever with no keeper routing to them. Do not deploy until the keeper
> multi-chain sprint is merged, even if every other gate below is green.

**Gate: this runbook may not be executed until ALL of the following are true.** If any is false, STOP:
1. **Fresh-block manifest re-verification pass** — `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` was
   generated 2026-07-15; every address this runbook cites must be re-verified on-chain (two independent
   RPCs, non-empty bytecode, symbol/decimals where applicable — same method the manifest itself used)
   at a **fresh block**, not assumed still correct from the manifest's generation time. Record the new
   verification block + timestamp here: `_______________`.
2. **Mandatory pre-deploy Auditor pass**, 0C/0H, covering this runbook + whatever deploy/verifier script
   deltas exist at deploy time (mirrors `AUDIT-V3-PREDEPLOY` for Base). Cite the audit doc: `_______________`.
3. **The keeper multi-chain sprint is merged** (see BLOCKER box above) and confirmed live in the running
   keeper process (startup log shows per-chain routing, not a single hardcoded chain).
4. Phase-0 `order-floor.js` + `submission-policy.js` remain ACTIVE in the (now multi-chain) keeper for
   Arbitrum exactly as they are for Base — same rationale as the Base runbook's gate condition 4.

---

## 0. Required inputs / decisions (fill BEFORE starting)

**Every address below marked (manifest) comes verbatim from
`docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` (two-RPC verified, 2026-07-15) — re-verify per gate
condition 1 above before use, never hand-type a substitute.** `_feeRecipient`/`_admin` are NOT
chain-derived — they are TeraSwap's existing owner-controlled admin/multisig addresses, reused
across chains exactly as they are for mainnet + Base (`docs/DEPLOYMENTS.md`); confirm they are still
correct before use, they are not something a manifest RPC read can validate.

| Input | Value | Source |
|-------|-------|--------|
| `_feeRecipient` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | Same as Base/mainnet (`docs/DEPLOYMENTS.md`) — **owner must reconfirm**, not manifest-verifiable |
| `_admin` | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | Same as Base/mainnet — all v3 admin actions are already delay-gated by the contract's own 48h/7d timelock (see Base runbook §0 note); **owner must reconfirm** |
| `_weth` (Arbitrum) | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | manifest: `token.WETH` |
| `_sequencerUptimeFeed` (Arbitrum) | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | manifest: `sequencer.sequencerUptimeFeed` |
| **Keeper / executor address** | `<KMS-derived Arbitrum keeper signing address>` | Provisioned per `AWS-KMS-EXECUTOR-SETUP.md` — a NEW KMS key/address for this chain, not reused across chains. **Must hold Arbitrum ETH.** Runtime key must live in KMS/Vault — plaintext refused (same guard as the Base deploy script, §2 below) |
| **Routers to whitelist (bootstrap)** | **EXACTLY 2** — see §2 Step 1 rationale | manifest: `contract.router:velora` + `contract.router:uniswapv3` |
| Deployer wallet | `<your keystore account>` | must hold Arbitrum ETH for gas; new nonce ⇒ NEW address (not the Base or mainnet executor address) |
| Arbiscan API key | `<for --verify>` | source verification |
| `EXPECTED_CHAIN_ID` | `42161` | Arbitrum One |

---

## 1. Pre-flight

Identical to the Base runbook §1 — `forge build` / `forge test` clean, gate conditions checked off,
`docs/security/AUDIT-TOTAL.md` shows 0C/0H for the v3 contract line item, outstanding-order snapshot
recorded (trivially empty here — no Arbitrum orders can exist yet, nothing is deployed).

---

## 2. Deploy

Same script as Base — `contracts/order-engine/script/DeployOrderExecutorV3.s.sol` — **already fully
chain-parameterized** (every constructor input is read from an environment variable BY NAME:
`FEE_RECIPIENT`, `ADMIN`, `WETH_ADDRESS`, `SEQUENCER_UPTIME_FEED`, `EXPECTED_CHAIN_ID`; no Base-specific
literal exists in the script to remove). Same for `VerifyOrderExecutorV3.s.sol` — every expected value is
a caller-supplied argument, nothing hardcoded. Neither script needed a single line changed for Arbitrum.

### Step 1 — RE-VERIFY BOTH router addresses on-chain (the Sprint-46 "labels lie" lesson, applies here too)

**[M-C rationale]** The whitelist is deliberately narrower than the manifest's full 8-router discovery
set (1inch, 0x, velora, odos, kyberswap, openocean, sushiswap, balancer, uniswapv3 — see the manifest's
`contract.router:*` entries). Bootstrap EXACTLY the 2 that are BOTH (a) actually served by `/api/swap`
for Arbitrum quotes AND (b) buildable by the (future, post-keeper-sprint) keeper — bootstrapping a
router neither the frontend nor the keeper can build calldata for would silently strand any order that
committed to it (the exact SwapFailed root cause PR #225 fixed on Base — do not repeat it here):

- **Augustus V6.2** (ParaSwap/Velora) — `0x6A000F20005980200259B80c5102003040001068` (manifest:
  `contract.router:velora`). Same address as Base's Augustus V6 entry — ParaSwap deploys this
  entry point at the same address across chains (CREATE2); confirm this is still the case at deploy
  time, do not assume it from this doc.
- **Uniswap SwapRouter02 (Arbitrum)** — `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` (manifest:
  `contract.router:uniswapv3`). **This is a DIFFERENT address from Base's SwapRouter02**
  (`0x2626664c2603336E57B271c5C0b26F421741e481`) — per-chain Uniswap deployment, do not reuse the Base
  constant.

```bash
# Confirm each address is still a live contract with non-trivial bytecode, on BOTH manifest RPCs.
cast code 0x6A000F20005980200259B80c5102003040001068 --rpc-url https://arb1.arbitrum.io/rpc | wc -c
cast code 0x6A000F20005980200259B80c5102003040001068 --rpc-url https://arbitrum-one-rpc.publicnode.com | wc -c
cast code 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 --rpc-url https://arb1.arbitrum.io/rpc | wc -c
cast code 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 --rpc-url https://arbitrum-one-rpc.publicnode.com | wc -c
```
Record all four byte lengths here (this IS the fresh-block re-verification the gate requires):
`_______________`.

**FEEDBACK note:** `src/lib/order-engine/route-source.ts::ROUTER_TO_SOURCE` is keyed by router address
(chain-agnostic — addresses are globally unique) and already maps Augustus V6.2's address to `'velora'`,
so no change is needed for that router. It has **no entry yet** for Arbitrum's SwapRouter02
(`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`) — a future sprint (frontend-only, not gated by this
runbook) must add it before an Arbitrum fill routed through that router would show the correct
"Uniswap V3" badge instead of falling back to "Aggregated". Out of scope here (not in this sprint's
files-affected list).

### Step 2 — Deploy
```bash
export FEE_RECIPIENT=0x107F6eB7C3866c9cEf5860952066e185e9383ABA
export ADMIN=0x9A387f681a7674F10d255f5b2651EBc4c672C73C
export WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
export SEQUENCER_UPTIME_FEED=0xFdB631F5EE196F0ed6FAa767959853A9F217697D
export EXPECTED_CHAIN_ID=42161

forge script script/DeployOrderExecutorV3.s.sol:DeployOrderExecutorV3 \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --account <your-keystore> \
  --verify --verifier etherscan --etherscan-api-key <ARBISCAN_API_KEY> \
  --broadcast
```
Save the deployed address → `export OE_V3_ARBITRUM=0x...`.

### Step 3 — Bootstrap (one-shot, `onlyAdmin`)
```bash
cast send $OE_V3_ARBITRUM \
  "bootstrap(address[],address[])" \
  "[0x6A000F20005980200259B80c5102003040001068,0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45]" \
  "[<KMS keeper executor address from §0>]" \
  --rpc-url https://arb1.arbitrum.io/rpc --account <your-keystore>
```
Confirms bootstrap whitelists the **KMS-provisioned** keeper executor address in the same tx — never a
plaintext-key address, same posture as the Base bootstrap.

### Step 4 — Set the fair-value oracle config (timelocked — §4, do NOT skip)

---

## 3. Verify

Same procedure as the Base runbook §3 (Arbiscan shows the exact contract name; run the read-only
verifier script; cross-check the on-chain `Bootstrap`/`RouterWhitelisted` event log is EXACTLY the 2
intended routers).

```bash
forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --sig "run(address,address,address,address,address[],address[],address,uint256)" \
  $OE_V3_ARBITRUM $ADMIN $FEE_RECIPIENT $WETH_ADDRESS \
  "[0x6A000F20005980200259B80c5102003040001068,0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45]" \
  "[0x111111125421cA6dc452d289314280a0f8842A65,0x0000000000001fF3684f28c67538d4D072C22734,0x19cEeAd7105607Cd444F5ad10dd51356436095a1,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0x6352a56caadC4F1E25CD6c75970Fa768A3304e64,0xAC4c6e212A361c968F1725b4d055b47E63F80b75,0xBA12222222228d8Ba445958a75a0704d566BF2C8]" \
  $SEQUENCER_UPTIME_FEED 42161
```
`deniedRouters` here is the manifest's OTHER discovered Arbitrum router candidates (1inch, 0x, odos,
kyberswap, openocean, sushiswap, balancer) — a candidate list, not exhaustive; run the event-scan step
(Base runbook §3) for the actually-exhaustive proof.

**Real-domain-smoke lesson (carried forward from the Base runbook's mislabel precedent):** never trust a
block-explorer contract name/label as proof of correctness — the Base FeeCollector displaying as
"TeraSwapOrderExecutor" on BaseScan despite being a different contract is the standing counter-example.
Confirm the deployed bytecode/ABI (not the explorer label) is what the verifier script and keeper
actually call against.

---

## 4. Oracle config (timelocked — DO NOT skip, DO NOT rush)

**The 5 feed-covered launch tokens** (every token in the manifest with an `ok: true` Chainlink feed
entry — WETH, USDC, USDT, DAI, WBTC; any other token the DCA panel might later support on Arbitrum has
no feed yet and must not be queued until one is verified):

| Token | Address (manifest `token.*`) | Feed (manifest `feed.*/USD`) |
|-------|-------------------------------|-------------------------------|
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` |
| USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` |
| DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB` |
| WBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57` |

**The DAI-saga lesson (do not repeat it here):** an `actionId` for a queued timelock change must be
**re-extracted from the on-chain `TimelockQueued` event receipt at the moment you execute it**, never
copy-pasted from a table (this doc, a spreadsheet, a prior PR) written down at queue time. A
transcribed/stale actionId silently reverts (or, worse, executes against the wrong queued change if IDs
were reused/misattributed across entries) — the receipt is the only source of truth, every time.

1. **Queue** each of the 5 tokens above:
   ```bash
   cast send $OE_V3_ARBITRUM "queueTokenUsdFeed(address,address,uint8,uint256)" \
     <token> <chainlinkFeed> <tokenDecimals> <maxStalenessSeconds-or-0> \
     --rpc-url https://arb1.arbitrum.io/rpc --account <your-keystore>
   ```
   Extract each `actionId` from that call's OWN transaction receipt's `TimelockQueued` event — do not
   reuse an actionId recorded anywhere else. Record queue timestamps here: `_______________`.
2. **⏱️ Explicit 48h-wait step** (`TIMELOCK_ORACLE_CHANGE = 48h`, 7-day grace per `TIMELOCK_GRACE` — same
   as Base). Set a calendar reminder for `queue_timestamp + 48h` for each of the 5 tokens.
3. **Execute** after 48h, re-extracting the actionId from the queue receipt at this moment (not from step
   1's notes):
   ```bash
   cast send $OE_V3_ARBITRUM "executeTokenUsdFeed(bytes32,address,address,uint8,uint256)" \
     <actionId-from-receipt> <token> <chainlinkFeed> <tokenDecimals> <maxStalenessSeconds-or-0> \
     --rpc-url https://arb1.arbitrum.io/rpc --account <your-keystore>
   ```
4. **Verifier oracle checkpoint**, per token, must pass before §5:
   ```bash
   forge script script/VerifyOrderExecutorV3.s.sol:VerifyOrderExecutorV3 \
     --rpc-url https://arb1.arbitrum.io/rpc \
     --sig "checkOracleFeed(address,address,uint256)" \
     $OE_V3_ARBITRUM <token> <maxStalenessSeconds-you-queued-or-300-if-you-passed-0>
   ```

---

## 5. Cutover (BLOCKED — see the box at the top of this document)

Do not perform any of the following until the keeper multi-chain sprint has merged:

1. **Keeper env:** the (then multi-chain) keeper's per-chain config gets an Arbitrum entry pointing at
   `$OE_V3_ARBITRUM` — exact variable name/shape is defined by that sprint, not this one.
2. **Vercel (frontend):** set `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = $OE_V3_ARBITRUM` for the
   production environment (the env var this sprint's `config.ts` entry already reads — SPRINT-48 wired
   the slot, this is the only step that ever fills it).
3. **Order matters — keeper FIRST, frontend SECOND**, identical rationale to the Base runbook §5: setting
   the frontend env before the keeper can route Arbitrum v3 orders opens a window where a signed order
   has nowhere to execute.
4. **e2e smoke** — identical shape to the Base runbook §5 (create → first fill → single cancel →
   mass-cancel path check), run against Arbitrum before declaring cutover live.

---

## 6. Rollback

**Rollback = unset the frontend env only.** Unset `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM` in
Vercel. `getOrderExecutorV3(42161)` returns to `null` → `isDcaLive(42161)` fails closed (DCA_CHAINS still
lists 42161, but the v3-wired AND term blocks it) → byte-identical to the pre-cutover dark state this
sprint ships. **Never unset the keeper's per-chain Arbitrum executor config as part of rollback** — same
invariant as the Base runbook §6: the keeper must keep routing to `$OE_V3_ARBITRUM` for as long as any
real v3 order can still exist there. If a real order was ever signed before rollback, an
`INC-YYYY-MM-DD-NNN` incident record is required (Base runbook §6 step 4) — identical process, no
Arbitrum-specific deltas.

---

## 7. Pre-deploy hard gates (restated, all required)

- [ ] Fresh-block manifest re-verification pass (gate condition 1).
- [ ] Auditor pre-deploy pass, 0C/0H (gate condition 2).
- [ ] Keeper multi-chain sprint merged (BLOCKER box + gate condition 3).
- [ ] Phase-0 keeper floor (`order-floor.js`/`submission-policy.js`) confirmed active for Arbitrum in the
      merged multi-chain keeper (gate condition 4).

## Cross-reference
- `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` — the Base deploy this mirrors; read its §1/§4–§7 for detail
  not repeated here.
- `docs/Runbooks/AWS-KMS-EXECUTOR-SETUP.md` — keeper signing-key discipline; provision a NEW Arbitrum
  KMS key, do not reuse the Base signing key across chains.
- `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` — the source of every 42161 address in this document.
- `docs/Prompts/SPRINT-48-ARBITRUM-DCA-PREP.md` — the sprint packet this runbook was written under.
