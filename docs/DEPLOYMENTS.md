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
| **OrderExecutor V3** (conditional orders, oracle floor) | Base (8453) | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` | **LIVE** (cutover 2026-07-21). Oracle feeds (WETH/USDC/DAI) executed via timelock; keeper dual-routing v2+v3. First production oracle-floor fill 2026-07-21 (`0x4a8d0b520ee2dfec0ccbeb949c8ef05509711ea616b03c427b0ccf9753794a6f`). ⚠️ Mass-cancel for DCA is DB-level only until `fix/mass-cancel-dca-onchain` merges (Auditor-gated) — single `cancelOrder` is the on-chain-terminal path. |
| **FeeCollector** (instant swaps) | Arbitrum One (42161) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | deployed+verified+bootstrapped (9 routers), prod flip 2026-07-20. Fee verified on Arbiscan tx `0xf14b181b91f1b3274fdaa19248d7619acadd21f0666cfbfbede40bdb660927b2` (0.002624 USDC → feeRecipient). ⚠️ Same address also used as mainnet OrderExecutor v2 and Base FeeCollector (deployer-nonce alignment) — **always qualify by chain**. |
| **OrderExecutor V3** (conditional orders, oracle floor) | Arbitrum One (42161) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | **Deployed 2026-08-04** (block 490,946,028, tx `0x0792a252…d13cb1a`, deployer `0x9A38…C73C` nonce 2) — **identified on-chain 2026-08-27**: 18,247 B, `keccak256` `0x363faecf8d0d0af8…`, identical on `arb1.arbitrum.io/rpc` and `arbitrum-one-rpc.publicnode.com`, **byte-proven** against `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (solc 0.8.28, metadata stripped + immutables masked). `admin` `0x9A38…C73C`, `feeRecipient` `0x107F…3ABA`, `WETH` `0x82aF…Bab1`, `sequencerUptimeFeed` `0xFdB6…697D`. `bootstrapped()` true, `paused()` false, **10 routers whitelisted** (9 manifest routers + CoW vault relayer — the runbook prescribed 2). ⚠️ **NOT operational:** no repo-known executor is whitelisted (`executeOrder` is gated on `whitelistedExecutors`), and the oracle floor is unconfigured (`tokenUsdFeeds`/`oracleConfigs` unset for all 5 manifest tokens/feeds). Deployed against the runbook's own BLOCKER (gate #3, multi-chain keeper) and gate #1. ⚠️ Same address is the **mainnet FeeCollector V2** and an abandoned Base OrderExecutor v2 — **always qualify by chain**. See `Audits/Incidents/INC-2026-08-26-001.md` §11. |
| **OrderExecutor** (testnet) | Sepolia (11155111) | `0xeFC31ADb…f130` + `0xa298e6ed9CF510b708a1F16c9729Bd69c6ee00f2` | testnet only — `0xa298…` exists ONLY on Sepolia |

### ⚠️ Key gotcha — same address, different contract per chain
`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` is the **OrderExecutor on mainnet**, **FeeCollector on Base**, AND **FeeCollector on Arbitrum One**
(different bytecode per chain, deployer-nonce alignment). Three chains, three roles—**always qualify by chain**. Do not assume one address = one contract across chains.

**Second instance (verified on-chain 2026-08-27, `INC-2026-08-26-001` §11.4):** `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` is the **FeeCollector V2 on mainnet** (5,419 B), an **abandoned, unbootstrapped OrderExecutor v2 on Base** (15,475 B, `bootstrapped()` = false), AND the **OrderExecutorV3 on Arbitrum One** (18,247 B, byte-proven). Same deployer at the same nonce on three chains. The FeeCollector-only `TIMELOCK_DELAY()` (`0x5ba1c1a9`) answers on mainnet and **reverts** on Arbitrum; the V3-only `ORDER_TYPEHASH()`/`domainSeparator()`/`sequencerUptimeFeed()` do the reverse. Two collisions now, same mechanism — **identify by chain + code hash, never by address**.

## Wallets

| Role | Address | Notes |
|------|---------|-------|
| Fee recipient | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | receives 0.1% fee (on-chain `feeRecipient`) |
| Contract admin | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` | on-chain `admin` of mainnet FeeCollector V2 + OrderExecutor |

## Keeper registry

*Added 2026-08-27, per `Audits/Incidents/INC-2026-08-26-001.md` §12 (Finding B — the whitelisted
Arbitrum executor was unrecorded, not a security issue).*

| Chain | Signer address | KMS alias | KMS key id | Region | Key created | Keeper polling today? |
|---|---|---|---|---|---|---|
| Base (8453) | `0x71f5AC191587AE132D966a719569b2468e0Aa2E5` | `teraswap-executor` | `096547c1-7664-4d5e-998e-8e56ce67c08b` (`docs/Runbooks/EC2-EXECUTOR-HOST.md`) | `eu-north-1` | 2026-06-16 17:49 UTC — owner-supplied, not verifiable from this repo | **Yes** — `Audits/Incidents/INC-2026-08-26-001.md` §6: "only a Base keeper runs." |
| Arbitrum One (42161) | `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab` (`Audits/Sprint/ARBITRUM-V3-STATE-2026-08-26.md` §0/§2.2 — event-derived, never hand-typed) | `teraswap-keeper-arbitrum` | `193845d3-c7d3-4858-9f7e-2eb0bd696d1c` — **owner-supplied, not verifiable from this repo** | `eu-north-1` | 2026-08-04 | **No** — `ARBITRUM-V3-STATE-2026-08-26.md` §0/§4 (B3): whitelisted on-chain, but no repo-known process runs against this chain. |

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

## Open follow-ups
1. ✅ **`order-engine/config.ts` now chain-aware** (PR #184) — `ORDER_EXECUTOR_BY_CHAIN {1: mainnet, 8453: null}`
   + `getOrderExecutor(chainId)`, Base fail-closed. **Still TODO before Base conditional orders:** deploy a
   real Base OrderExecutor + set `ORDER_EXECUTOR_BY_CHAIN[8453]`.
2. 🟡 **BaseScan mislabel** — re-verify the Base `0xeFC3…` contract against the FeeCollector source so the
   explorer name matches reality.
3. 🟡 **Align stale repo `.env` files** to the canonical values above.
