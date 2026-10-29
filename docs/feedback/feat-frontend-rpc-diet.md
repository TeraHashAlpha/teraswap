# Feedback — feat/frontend-rpc-diet (2026-10-29, base origin/main 2c0849c)

Env NAMES only; no RPC URLs/keys. Goal: ≥90 % less browser RPC per tab, nothing visible changes, quote/swap semantics untouched.

## Checklist
- [x] C1 harness (`src/test-utils/rpc-{harness,scenarios,budget.harness.test}`) + BEFORE table
- [ ] C2 diet (v1+v2 shared hooks) + change table
- [ ] C3 AFTER table + budget guards + parity/suite/lint/tsc/build
- [ ] push + compare link

## Owner decisions / premise notes
- **a0 (landing `/`)**: only on-chain figure is the footer "Block #N" (static stats come from `product-claims.ts`, no RPC). A 24 h server cache would show a wrong block, so the owner chose: **keep it live, a0 budget relaxed from 0 to ≤1 call/min** (60 s poll, visibility-gated).
- Recon #70 figures are **modelled from code, not measured** (its own header). This harness is the first measurement.
- Recon correction: a **visitor** (no wallet) makes **no** Chainlink/depeg reads — `useChainlinkPrice`/`useDepegCheck` resolve their chain from `useAccount().chain` (undefined without a wallet) and stay disabled. Visitor polling is the footer block only.
- Windows: `mount` = first 5 s (one-time page-load burst, not a per-minute rate); `steady` = next 60 s; hidden = 60 s after the tab goes hidden; `return` = 5 s after it becomes visible. Production-only `eth_chainId` guard probes are mocked out (≈1/endpoint/page load).

## 1. BEFORE (origin/main 2c0849c; `npx vitest run src/test-utils/rpc-budget.harness.test.tsx`)
Real `providers.tsx` + wagmi config + hooks, counting transport, fake clock. c = mock wallet, ETH→USDC, 1 ETH typed; c20 = same, USDC→ETH (ERC-20 sell). Mount burst = block + 2 fee reads + 1 Chainlink/gas multicall (+ wallet reads).

| UI | state | mount burst | steady calls/min | steady by method | hidden 60 s | on return (5 s) |
|---|---|---:|---:|---|---:|---:|
| v1 | a0 landing | 4 | 5 | blockNumber×5 | 0 | 4 |
| v1 | a swap, idle | 4 | 5 | blockNumber×5 | 0 | 4 |
| v1 | b visitor+amount | 4 | 5 | blockNumber×5 | 0 | 4 |
| v1 | c wallet | 10 | 14 | blockNumber×5 eth_call×9 | 0 | 9 |
| v1 | c20 wallet, ERC-20 | 11 | 14 | blockNumber×5 eth_call×9 | 0 | 10 |
| v2 | a0 / a / b | 4 | 5 | blockNumber×5 | 0 | 4 |
| v2 | c wallet | 7 | 8 | blockNumber×5 eth_call×3 | 0 | 6 |
| v2 | c20 wallet, ERC-20 | 9 | 8 | blockNumber×5 eth_call×3 | 0 | 8 |

Reading: visitor 5/min = 7.2K/day, exactly recon row 1. v1 wallet 14/min ≈ 20K/day, at the low end of recon's browser rows 1–4 (16–45K/day): the fake clock batches every same-tick read into one Multicall3 `eth_call` perfectly, a real tab batches less, so real counts are ≥ these. Hidden tabs already pause TanStack `refetchInterval` (0 hidden) — the waste is the *visible* poll and the focus-return burst.
