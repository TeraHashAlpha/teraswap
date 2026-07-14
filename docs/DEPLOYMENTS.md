# TeraSwap — Deployments (source of truth)

**Verified on-chain 2026-06-13** (bytecode + function-selector probing via public RPCs). This file is the
canonical record; if code/docs/env disagree, this (re-verified on-chain) wins.

## Contracts

| Role | Chain | Address | Verified facts |
|------|-------|---------|----------------|
| **FeeCollector V2** (instant swaps) | Ethereum Mainnet (1) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | 5,419 B · has `swapETHWithFee`/`swapTokenWithFee` (minimumOutput/H-04) · feeRecipient `0x107F…`, FEE_BPS 10, admin `0x9A38…` |
| **FeeCollector** (instant swaps) | Base (8453) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | 5,339 B · has `swapETHWithFee`/`swapTokenWithFee` · **NO** `executeOrder` · feeRecipient `0x107F…`, FEE_BPS 10, admin `0x9A38…` · ⚠️ BaseScan mislabels it "TeraSwapOrderExecutor" |
| **FeeCollector V1** (frozen) | Ethereum Mainnet (1) | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` | deployed, no minimumOutput — **deprecated, do not route here** |
| **OrderExecutor** (conditional orders) | Ethereum Mainnet (1) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | 13,244 B · has `executeOrder` (0x6233f5c2) · **NO** swap fns |
| **OrderExecutor** (conditional orders) | Base (8453) | `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` | deployed+verified 2026-06-14, **bootstrapped** (10 direct routers + executor `0xd7F9…`); admin 0x9A38, feeRecipient 0x107F, WETH 0x4200. ⚠️ an earlier deploy landed on `0x47f2…7459` (collided w/ mainnet FeeCollector addr) — **abandoned, unbootstrapped, do not use**. |
| **OrderExecutor** (testnet) | Sepolia (11155111) | `0xeFC31ADb…f130` + `0xa298e6ed9CF510b708a1F16c9729Bd69c6ee00f2` | testnet only — `0xa298…` exists ONLY on Sepolia |
| **OrderExecutorV3** (conditional orders, ADR-013) | Base (8453) | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` | deployed+verified 2026-07-13 (BaseScan Exact Match, TeraSwapOrderExecutorV3, solc 0.8.28). Bootstrapped (one-shot): routers = Augustus V6 `0x6A000F20005980200259B80c5102003040001068` + Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`; executor = KMS keeper `0x71f5AC191587AE132D966a719569b2468e0Aa2E5`. admin `0x9A38…C73C` (48h timelock), feeRecipient `0x107F…3ABA`, WETH `0x4200…0006`, sequencerUptimeFeed `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`, MAX_ORDER_SLIPPAGE_BPS=500. ⚠️ CUTOVER PENDING — oracle feeds queued (timelock matures ~2026-07-16); frontend/keeper env NOT yet pointed at v3. v2 Base OrderExecutor `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` still authoritative until cutover. |

### ⚠️ Key gotcha — same address, different contract per chain
`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` is the **OrderExecutor on mainnet** but a **FeeCollector on Base**
(different bytecode). Do not assume one address = one contract across chains.

## Wallets

| Role | Address | Notes |
|------|---------|-------|
| Fee recipient | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | receives 0.1% fee (on-chain `feeRecipient`) |
| Contract admin | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | on-chain `admin` of mainnet FeeCollector V2 + OrderExecutor |

## Canonical production env (Vercel)

```
NEXT_PUBLIC_FEE_COLLECTOR        = 0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459   # mainnet V2 (minimumOutput) — NOT V1 0x4dAE…
NEXT_PUBLIC_BASE_FEE_COLLECTOR   = 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130   # Base FeeCollector (enables Base instant swaps)
NEXT_PUBLIC_FEE_RECIPIENT        = 0x107F6eB7C3866c9cEf5860952066e185e9383ABA
NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS = 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130   # mainnet OrderExecutor — NOT Sepolia 0xa298…
NEXT_PUBLIC_ADMIN_WALLET         = <wallet used to access /admin>               # FE admin-panel gating only
```

(Vercel currently matches the swap-critical values — confirmed by owner. Repo `.env.production`/`.env.local`
are STALE: they point `NEXT_PUBLIC_FEE_COLLECTOR` at V1 and `NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS` at the Sepolia
address — align them to avoid future confusion, low priority since Vercel is authoritative.)

**OrderExecutorV3 (Base) env — not yet set.** Frontend var `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` and
keeper var `ORDER_EXECUTOR_V3_ADDRESS` will both be set at cutover (after the 48h timelock matures ~2026-07-16),
not before — fail-closed while unset.

## Open follow-ups
1. ✅ **`order-engine/config.ts` now chain-aware** (PR #184) — `ORDER_EXECUTOR_BY_CHAIN {1: mainnet, 8453: null}`
   + `getOrderExecutor(chainId)`, Base fail-closed. **Still TODO before Base conditional orders:** deploy a
   real Base OrderExecutor + set `ORDER_EXECUTOR_BY_CHAIN[8453]`.
2. 🟡 **BaseScan mislabel** — re-verify the Base `0xeFC3…` contract against the FeeCollector source so the
   explorer name matches reality.
3. 🟡 **Align stale repo `.env` files** to the canonical values above.
