# TeraSwapFeeCollector Deployment Guide

## Contract: `TeraSwapFeeCollector.sol`
Collects 0.1% (10 bps) fee on every swap routed through it.

## Deploy via Remix (easiest)

1. Go to https://remix.ethereum.org
2. Create file `TeraSwapFeeCollector.sol`, paste the contract code
3. Install OpenZeppelin: In Remix, use the import remapping or paste OZ files
4. Compile with Solidity 0.8.20+
5. Deploy tab → Environment: "Injected Provider" (MetaMask)
6. Constructor arg: `_feeRecipient` = `0x107F6eB7C3866c9cEf5860952066e185e9383ABA`
7. Click Deploy → Confirm in MetaMask
8. Copy the deployed contract address

## After Deployment

Add to `.env.local`:
```
NEXT_PUBLIC_FEE_COLLECTOR=0x<deployed_address>
```

Then redeploy to Vercel:
```bash
git add .env.local
git push origin main
```

## How It Works

- **ETH swaps**: User sends ETH to FeeCollector → takes 0.1% → forwards rest to DEX router
- **ERC-20 swaps**: User approves FeeCollector → pulls tokens → takes 0.1% → approves router → executes swap
- **Fee-native sources** (1inch, KyberSwap, 0x): bypass FeeCollector, use API fee params directly
- **All other sources**: routed through FeeCollector automatically

## Estimated Gas Cost
- Deploy: ~500,000 gas (~$5-15 depending on gas price)
- ETH swap via FeeCollector: +~30,000 gas overhead
- ERC-20 swap via FeeCollector: +~60,000 gas overhead

---

## Base Deployment (Phase 2)

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
