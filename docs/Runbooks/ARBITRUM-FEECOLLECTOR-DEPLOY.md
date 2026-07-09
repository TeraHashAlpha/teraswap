# Runbook — Deploy TeraSwapFeeCollector on Arbitrum One (42161)

**Goal:** deploy a real FeeCollector on Arbitrum so instant swaps can activate there. Today
Arbitrum has **no FeeCollector** (`contracts.feeCollector` is env-driven, unset ⇒ dark — see
`src/lib/chains/registry.ts`). This deploys the same audited contract that is live on mainnet + Base.

**Owner-executed** (on-chain + env flips). Architect/Code Agent prepared everything up to this point
(router re-verification, activation plumbing); this runbook is the manual deploy + go-live sequence.
Adapted from `docs/Runbooks/BASE-ACTIVATION.md` (Phase A/C) + `docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md`
(the Foundry deploy pattern), Foundry-based rather than Remix.

**Fund-flow-adjacent.** Do NOT execute any on-chain step until: **(a)** the joint Sprint 46+47 Auditor
pass has returned **0C/0H** on this diff, and **(b)** `docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md`
(the full address set — supersedes-not-deletes the earlier router-only report) has been accepted. The router whitelist below is an **input to check against the report at deploy time**, not
a value to trust blindly from this file — addresses can be redeployed/rugged between report-writing and
deploy-day; re-run `eth_getCode` on each before bootstrapping (Step 4).

---

## 0. Required inputs / decisions (fill BEFORE starting)

| Input | Value | Notes |
|-------|-------|-------|
| `_feeRecipient` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | same as mainnet + Base (verified on-chain) |
| `_admin` | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | same as mainnet + Base admin (verified) |
| **Router set to whitelist** | see Step 4 | **DECISION (mirrors Base):** direct DEX/aggregator routers only; **exclude CoW VaultRelayer + Bebop JAM** (intent/RFQ — the FeeCollector's `swapTokenWithFee`/`swapETHWithFee` model needs a direct swap call, not a signed-intent or self-building settlement). |
| Deployer wallet | `<your keystore account>` | must hold Arbitrum ETH for gas; will become the deployer (a different nonce than mainnet/Base → a NEW address). |
| Arbiscan API key | `<for --verify>` | for source verification |

## 1. Pre-flight checks

> **[CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] HARD GATE — run this FIRST, before anything else in this
> section.** AUDIT-ARBITRUM-46-47 found 9 `CHAIN_CONFIGS[42161]` addresses with zero on-chain code
> (hand-transcribed hex drift) that had gone undetected through an entire prior sprint. Do not deploy
> against a config that hasn't been re-verified at a fresh block on THIS day:
> ```bash
> node scripts/verify-arbitrum-addresses.mjs
> ```
> Must exit 0 and re-write `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` with a fresh block number. If
> it fails (any address without code, wrong symbol/description, or stale feed data), **stop** — do not
> proceed to deploy on a config the script can't currently verify. This check supersedes the older
> "re-run eth_getCode for every router address" note below (this script does that, plus tokens, feeds,
> and the sequencer, in one reproducible run) — kept for the record but the script is the actual gate.

```bash
cd "contracts"
forge build                 # compiles clean
forge test --match-path 'test/*.t.sol' -vvv   # FeeCollector suite green
```

- Confirm **joint Sprint 46+47 Auditor pass = 0C/0H** on this diff — record the SHA it was run against.
- Confirm `docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md` is accepted (no open FEEDBACK items blocking).
- Re-run `eth_getCode` against `https://arb1.arbitrum.io/rpc` for every router address you're about to
  bootstrap (Step 4) — do not trust the report's addresses as still-valid without a same-day re-check.
  (Superseded by the manifest-verification run above, which covers this automatically.)
- Deployer has Arbitrum ETH for gas; keystore unlocked; Arbiscan API key ready.

## 2. Deploy FeeCollector on Arbitrum (forge create)

> Gets a **NEW address** (deployer nonce on Arbitrum differs from mainnet/Base). Record it as `$FC_ARB`.

```bash
forge create TeraSwapFeeCollector.sol:TeraSwapFeeCollector \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --account <your-keystore> \
  --constructor-args \
    0x107F6eB7C3866c9cEf5860952066e185e9383ABA \
    0x9A387f681a7674F10d255f5b2651EBc4c672C73C \
  --verify --verifier etherscan \
  --etherscan-api-key <ARBISCAN_API_KEY> \
  --broadcast
```

Save the deployed address → `export FC_ARB=0x...`

## 3. Verify source on Arbiscan

```
https://arbiscan.io/address/$FC_ARB#code
```

**BaseScan-mislabel precedent check:** the Base FeeCollector at `0xeFC3…f130` is mislabeled
"TeraSwapOrderExecutor" on BaseScan despite being a genuine FeeCollector — explorer name tags are
**not authoritative**. After Arbiscan verification succeeds, confirm the label independently:

```bash
# FeeCollector has swapETHWithFee/swapTokenWithFee selectors; it must NOT have executeOrder (0x6233f5c2).
cast code $FC_ARB --rpc-url https://arb1.arbitrum.io/rpc | grep -o 6233f5c2   # expect: no match
```

If Arbiscan shows any name other than the source you just deployed, or the selector check above finds
`6233f5c2` (the OrderExecutor's `executeOrder` selector) present, **stop** — you deployed the wrong
contract or verification matched the wrong source file. Do not proceed to Step 4.

## 4. Bootstrap routers (one-shot, onlyAdmin)

`bootstrapRouters(address[] routers)` whitelists in a single tx and can only run **once**
(`bootstrapped` flag). Routers must be deployed contracts (checks `extcodesize`).

**Router set — CHECK each against `docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md` AND a fresh
`eth_getCode` before running this. Do not copy this list blind — it is a snapshot, not a live source:**

```
1inch      0x111111125421cA6dc452d289314280a0f8842A65
0x v2      0x0000000000001fF3684f28c67538d4D072C22734
Velora     0x6A000F20005980200259B80c5102003040001068
Odos       0x19cEeAd7105607Cd444F5ad10dd51356436095a1
KyberSwap  0x6131B5fae19EA4f9D964eAc0408E4408b66337b5
OpenOcean  0x6352a56caadC4F1E25CD6c75970Fa768A3304e64
SushiSwap  0xAC4c6e212A361c968F1725b4d055b47E63F80b75   [CORRECTED in the router verification report]
Uniswap V3 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45   [CORRECTED — was the V1 SwapRouter]
Balancer   0xBA12222222228d8Ba445958a75a0704d566BF2C8
```

> ⚠️ **Excluded on purpose (mirrors Base):** CoW VaultRelayer (`0xC92E…`) + Bebop JAM
> (`0xbeb0…`) — intent/RFQ venues, structurally incompatible with the FeeCollector proxy model
> (`FEE_INCOMPATIBLE_SOURCES` / `getFeeIncompatibleSources(42161)`, already wired in
> `src/lib/chains/activation.ts`). **Curve excluded** — its configured Arbitrum router resolves to
> empty on-chain code per the verification report; do not whitelist an address with no code.

```bash
cast send $FC_ARB \
  "bootstrapRouters(address[])" \
  "[0x111111125421cA6dc452d289314280a0f8842A65,0x0000000000001fF3684f28c67538d4D072C22734,0x6A000F20005980200259B80c5102003040001068,0x19cEeAd7105607Cd444F5ad10dd51356436095a1,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0x6352a56caadC4F1E25CD6c75970Fa768A3304e64,0xAC4c6e212A361c968F1725b4d055b47E63F80b75,0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45,0xBA12222222228d8Ba445958a75a0704d566BF2C8]" \
  --rpc-url https://arb1.arbitrum.io/rpc --account <your-keystore>
```

## 5. Post-deploy verification checklist (read-only — all must pass)

```bash
cast call $FC_ARB "feeRecipient()(address)" --rpc-url https://arb1.arbitrum.io/rpc   # 0x107F…
cast call $FC_ARB "admin()(address)"        --rpc-url https://arb1.arbitrum.io/rpc   # 0x9A38…
cast call $FC_ARB "FEE_BPS()(uint256)"       --rpc-url https://arb1.arbitrum.io/rpc   # 10
cast call $FC_ARB "paused()(bool)"          --rpc-url https://arb1.arbitrum.io/rpc   # false
# every bootstrapped router → true (repeat per address in Step 4's list):
cast call $FC_ARB "whitelistedRouters(address)(bool)" 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 --rpc-url https://arb1.arbitrum.io/rpc
# whitelist-exact: nothing NOT in the list above should be true (spot-check the OLD wrong addresses are NOT whitelisted):
cast call $FC_ARB "whitelistedRouters(address)(bool)" 0xE592427A0AEce92De3Edee1F18E0157C05861564 --rpc-url https://arb1.arbitrum.io/rpc   # expect: false (old V1 SwapRouter, never bootstrapped)
```

If any check fails → **do not proceed**. Investigate before touching the env vars.

---

## 6. PREVIEW GATE — Vercel Preview only (not production)

1. Set in a **Vercel Preview environment** (NOT Production):
   ```
   NEXT_PUBLIC_ARBITRUM_RPC_URL=https://arbitrum-mainnet.g.alchemy.com/v2/<KEY>
   NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR=0x<FC_ARB>
   ```
2. **e2e smoke test, Preview deployment only:**
   - **Quote quorum across the 12 adapters:** open the swap UI on the Preview URL, switch to Arbitrum,
     request a quote for a common pair (WETH→USDC) — confirm at least a quorum (not necessarily all 12 —
     Curve is expected to stay silent, mainnet-only fail-closed) of adapters return prices, not errors.
   - **One small real swap:** execute WETH→USDC for a trivial amount (~$5–10) with a connected wallet
     funded on Arbitrum. Confirm the tx succeeds on Arbiscan.
   - **On-chain fee collection verified:** the contract forwards the fee DIRECTLY to `feeRecipient` on
     every swap (no held balance / sweep step) — confirm `feeRecipient`'s balance of the fee token/ETH
     increased by the expected 0.1% (`FEE_BPS`) of the swapped amount on Arbiscan.
   - **Source-health baselines for 42161:** capture each adapter's response time / success rate for this
     first real activity window — this becomes the baseline the monitoring stack compares future Arbitrum
     health against (same pattern as Base's `source-health-monitor`).
3. **Gate:** all of the above pass on Preview → proceed to prod. Any failure → fix + re-verify on Preview,
   do NOT touch Production env vars.

## 7. Prod flip

1. Set the **same two env vars** in the **Production** Vercel environment.
2. Vercel auto-deploys on the env change (or trigger a redeploy).
3. Repeat the Preview smoke test (Step 6.2) once against Production — small real swap, fee verified.

## 8. Rollback (unset env ⇒ dark again)

If anything looks wrong post-flip:
1. **Immediate:** call `pause()` on `$FC_ARB` (Remix/Etherscan/`cast send $FC_ARB "pause()"`).
2. **Deactivate in the app:** unset `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` in the Production env (falls
   back to `null` per `registry.ts` — `isChainActive(42161)` returns to `false`, "Coming Soon" reappears,
   swaps refuse). Redeploy.
3. **Investigate:** check Arbiscan for the FeeCollector's txs, confirm no funds are stuck (contract has
   `sweep()` for admin recovery, same as mainnet/Base).
4. **Fix + re-audit** before any re-attempt.

No code change is required for rollback — it is purely an env-var unset, exactly the inverse of Step 7.

## 9. Alchemy allowlist + monitoring (mirror the Base manual-actions list)

- **Alchemy app scope:** the `ALCHEMY_API_KEY` (server-only) used for portfolio/discovery reads must have
  **arbitrum-mainnet** enabled in its app scope alongside eth-mainnet/base-mainnet, or Arbitrum discovery
  degrades silently to the multicall fallback (worse UX, not a hard failure). Verify:
  ```bash
  curl -s -X POST https://arb-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
  ```
  must return a `result`, not an auth/network-not-enabled error.
- **First 24h monitoring:** Sentry for new errors scoped to chainId 42161; Arbiscan for FeeCollector txs;
  fee revenue flowing to `feeRecipient`; confirm mainnet + Base swaps are unaffected by the Arbitrum flip.
- **Source-health dashboard:** add 42161 to whatever dashboard/alerting already watches Base's per-source
  health (quorum breaches, response-time regressions) using the Step 6 baseline as the initial reference.

---

## Safety notes

- `bootstrapRouters` is one-shot; later router changes require a new contract or (if the deployed
  FeeCollector version supports it) a timelocked change path — check the deployed source before assuming
  instant router changes are available.
- The deploy is the **same audited bytecode** as the live mainnet/Base FeeCollector — only constructor
  args (fee recipient/admin — identical across chains) and the bootstrapped router set differ.
- Order-engine/DCA on Arbitrum is **out of scope for this runbook and stays fail-closed** regardless of
  this deploy — `ORDER_EXECUTOR_BY_CHAIN` has no `42161` entry, and `isDcaLive()` is pinned to
  `BASE_CHAIN_ID` (8453) only. Conditional orders on Arbitrum are a later, separate sprint (after v3
  proves out on Base).
