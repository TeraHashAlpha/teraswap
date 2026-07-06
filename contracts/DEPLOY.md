# TeraSwapFeeCollector Deployment Guide

> **Source of truth first:** before ANY deploy, cross-check
> [`docs/security/DEPLOYED-SOURCES.md`](../docs/security/DEPLOYED-SOURCES.md) — the canonical
> address → source → compiler → code-hash map — and [`docs/DEPLOYMENTS.md`](../docs/DEPLOYMENTS.md)
> (the ops record: roles, wallets, env). Deploys require an audit pass, 0C/0H (CLAUDE.md rule #3).

## Contract: `contracts/TeraSwapFeeCollector.sol` — the ONLY deployable FeeCollector source

Collects 0.1% (10 bps, `FEE_BPS = 10`) on every swap routed through it. This is the deployed V2:
admin + `onlyAdmin`, router whitelist behind a 48h timelock (`queueRouterChange` /
`executeRouterChange`, one-shot `bootstrapRouters`), `pause()`, a per-swap `minimumOutput` floor
(H-04, `InsufficientOutput`), and a `receive()` that rejects ETH outside a swap (`ETHNotAccepted`).

> ⛔ Do **NOT** deploy `TeraSwapFeeCollector_flat.sol` — that flatten is the OLD, WEAK V1 (1-arg constructor; no admin/whitelist/timelock/minimumOutput; open `receive()`), kept only as the byte-proven source of the **frozen** mainnet V1 (`0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`). It carries its own banner, and CI (`deployed-sources-guard`) fails if this guide or any code points at it as a deploy target again.

## Compiler settings (the byte-proven recipe)

Per `contracts/foundry.toml` — identical to the byte-proven Base deploy in DEPLOYED-SOURCES.md:

- solc **0.8.28**
- **via-IR: required** (the source does not compile without it)
- optimizer **on**, runs **200**
- EVM version **cancun**

## Deploy via Foundry (recommended)

```sh
cd contracts && forge build   # sanity-check: compiles with the pinned settings above
forge create TeraSwapFeeCollector.sol:TeraSwapFeeCollector \
  --rpc-url <RPC_URL> \
  --account <deployer> \
  --constructor-args <_feeRecipient> <_admin> \
  --verify --etherscan-api-key <KEY>
```

Constructor — **two** args, both required and non-zero (`ZeroAddress()` otherwise); canonical
wallets live in `docs/DEPLOYMENTS.md`:

- `_feeRecipient` = `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` (receives the 0.1% fee)
- `_admin` = `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` (contract admin: whitelist/timelock/pause)

Remix also works, but you MUST set solc 0.8.28 + **enable via-IR** + optimizer 200 in the compiler
settings and use the repo's pinned OpenZeppelin submodule — a drifting OZ revision or compiler
settings produce non-reproducible bytecode (that is exactly the mainnet-V2 byte-exactness
follow-up recorded in DEPLOYED-SOURCES.md).

## After deployment (in order)

1. `bootstrapRouters([...])` from the admin wallet with the chain's router whitelist
   (`src/lib/chains/routers.ts`) — **one-shot** (`AlreadyBootstrapped` after the first call);
   every later change goes through the 48h timelock.
2. Verify the source on the explorer, then check on-chain: `FEE_BPS() == 10`, `feeRecipient()`,
   `admin()`, and `whitelistedRouters(router) == true` for each router.
3. Record the deploy in `docs/DEPLOYMENTS.md` **and** add the address → source → compiler →
   code-hash row to `docs/security/DEPLOYED-SOURCES.md` (then run
   `node scripts/verify-deployed-sources.mjs`).
4. Set the address env var (`NEXT_PUBLIC_FEE_COLLECTOR` / `NEXT_PUBLIC_BASE_FEE_COLLECTOR`) in the
   Vercel environment (`vercel env`) — **never commit `.env.local`** — and, for a new chain,
   update `src/lib/chains/registry.ts` (`contracts.feeCollector`).

## How It Works

- **ETH swaps**: User sends ETH to FeeCollector → takes 0.1% → forwards rest to DEX router
- **ERC-20 swaps**: User approves FeeCollector → pulls tokens → takes 0.1% → approves router → executes swap
- **Fee-native sources** (1inch, KyberSwap, 0x): bypass FeeCollector, use API fee params directly
- **All other sources**: routed through FeeCollector automatically

## Estimated Gas Cost
- Deploy: ~1.2–1.4M gas (V2 runtime is ~5.4 kB; the old "~500k" figure was the V1 flat)
- ETH swap via FeeCollector: +~30,000 gas overhead
- ERC-20 swap via FeeCollector: +~60,000 gas overhead

---

## Base Deployment (Phase 2)

> ✅ **Completed 2026-06** — the Base FeeCollector is live at
> `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` (bootstrapped; byte-proven in
> DEPLOYED-SOURCES.md; see `docs/DEPLOYMENTS.md`). Kept below as the reference
> checklist for the next chain deployment.

> Code preparation done in Sprint 44. The steps below are the manual deployment
> by TeraHash. Base stays "Coming Soon" in the UI until step 8 sets the address.

### Prerequisites
- Base ETH for gas (~0.001 ETH on Base — L2 fees are tiny)
- Admin wallet funded with Base ETH
- Basescan API key for contract verification

### Steps
1. Deploy `TeraSwapFeeCollector` on **Base Sepolia** (testnet) first.
2. Bootstrap routers with the Base whitelist (below).
3. Verify the contract on testnet Basescan.
4. Test the end-to-end swap flow on testnet.
5. Deploy `TeraSwapFeeCollector` on **Base mainnet** (8453).
6. Bootstrap routers (same whitelist).
7. Verify on Basescan.
8. Update `src/lib/chains/registry.ts` → `CHAIN_CONFIGS[8453].contracts.feeCollector`
   with the deployed address (this flips `isChainActive(8453)` to true).
9. Set `NEXT_PUBLIC_BASE_RPC_URL` and `NEXT_PUBLIC_BASE_FEE_COLLECTOR` in the
   environment.

### Router Whitelist (Base) — from src/lib/chains/routers.ts (Basescan-verified)
| Source | Base router | Notes |
|--------|-------------|-------|
| 1inch | `0x111111125421cA6dc452d289314280a0f8842A65` | AggregationRouterV6 (same as mainnet) |
| 0x | `0x0000000000001fF3684f28c67538d4D072C22734` | v2 AllowanceHolder (confirm allowanceTarget per-quote) |
| Velora | `0x6A000F20005980200259B80c5102003040001068` | Augustus V6.2 (same as mainnet) |
| Odos | `0x19cEeAd7105607Cd444F5ad10dd51356436095a1` | Odos Router V2 (Base) |
| KyberSwap | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | MetaAggregationRouterV2 (same) |
| CoW | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | VaultRelayer (same) |
| OpenOcean | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | Exchange (same) |
| SushiSwap | `0xAC4c6e212A361c968F1725b4d055b47E63F80b75` | RedSnwapper (Sushi v7) |
| Balancer | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | Vault V2 (same) |
| Uniswap V3 | `0x2626664c2603336E57B271c5C0b26F421741e481` | SwapRouter02 (Base) |
| Curve | `0x4f37A9d177470499A2dD084621020b023fcffc1F` | CurveRouterNG v1.1 (Base) |

Plus Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (same on all chains).

### Post-Deployment Verification
- `whitelistedRouters(routerAddress)` returns `true` for each router above
- `feeRecipient()` matches the expected address
- `admin()` matches the expected admin wallet
- `FEE_BPS()` returns `10` (0.1%)

### ⚠️ Pre-activation code wiring (MUST complete before step 8)

Setting `contracts.feeCollector` for Base flips `isChainActive(8453)` to true and
enables Base swaps. Before doing that, the following are still MAINNET-PINNED and
must be made per-chain, or Base swaps will route to the wrong (mainnet) contracts:

1. The **FeeCollector address** used to build swap calldata in `useSwap.ts`,
   `useSplitSwap.ts`, and `buildSimulationTx` (`swap-simulation.ts`) — currently
   the `FEE_COLLECTOR_ADDRESS` constant. Resolve via
   `getChainConfig(chainId).contracts.feeCollector`.
2. **`fetchApproveSpender`** (`api.ts`) — returns hardcoded MAINNET per-source
   spender addresses. Resolve via `ROUTER_WHITELIST_BY_CHAIN[chainId]` (routers.ts).
3. The **simulation RPC client** (`simulateSwapTx`) — always `getPrivateClient()`
   (mainnet). Use a per-chain client for the active chain.

`usesFeeCollector` / `isFeeCollectorActive` / `validateRouterAddress` /
`isTrustedSpender` are ALREADY chain-aware (Sprint 44). Items 1–3 are the
remaining wiring tracked for the Base-activation sprint.
