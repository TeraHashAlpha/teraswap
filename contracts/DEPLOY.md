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
