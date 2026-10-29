# Feedback — feat/frontend-rpc-diet (2026-10-29, base origin/main 2c0849c)

Env NAMES only; no RPC URLs/keys. Goal: ≥90 % less browser RPC per tab, nothing visible changes, quote/swap/oracle semantics untouched. **Result: budgets met in every state; the ≥90 % headline is NOT met (see §3).**

- [x] C1 harness · [x] C2 diet · [x] C3 AFTER + guards · [x] push (no PR)

## Owner decisions / premise notes
- **a0 (landing `/`)**: the only on-chain figure is the footer "Block #N" (landing stats are static `product-claims.ts`, no RPC). A 24 h server cache would show a wrong block, so owner chose: keep it live, **a0 budget 0 → ≤ 1 call/min**.
- Recon #70's numbers are **modelled, not measured** (its own header); a visitor makes **no** oracle/depeg reads (chain comes from `useAccount().chain`, undefined without a wallet) — visitor polling is the footer only.
- Windows: mount = first 5 s (page-load burst); steady = next 60 s; hidden = 60 s after the tab hides (BEFORE already 0: TanStack pauses `refetchInterval`); return = 5 s after it shows again. The fake clock batches same-tick reads perfectly, so real tabs read ≥ these. Harness: `src/test-utils/rpc-harness.ts` + `src/ui/v2/__tests__/rpc-budget/{scenarios,harness.test,guards.test}` (under `ui/v2` because `isolation.test.ts` forbids `ui/v2` references elsewhere).

## 1+3. BEFORE → AFTER (steady calls/min; mount burst; return burst)
| UI · state | BEFORE | AFTER | cut | mount b→a | return b→a |
|---|---:|---:|---:|---|---|
| v1+v2 · a0 landing, a swap idle, b visitor+amount | 5 | **1** | −80 % | 4→4 | 4→4 |
| v1 · c wallet (ETH→USDC) | 14 | **6** | −57 % | 10→8 | 9→7 |
| v1 · c20 wallet, ERC-20 sell | 14 | **6** | −57 % | 11→9 | 10→8 |
| v2 · c wallet | 8 | **4** | −50 % | 7→7 | 6→6 |
| v2 · c20 wallet, ERC-20 sell | 8 | **4** | −50 % | 9→9 | 8→8 |
| hidden 60 s (all) | 0 | **0** | — | | |

## 2. Changes (each measured by reverting it alone)
| file:line | before | after | calls/min saved |
|---|---|---|---|
| `lib/rpc-polling.ts:13` (new) → `components/Footer.tsx:14`, `ui/v2/shell/Footer.tsx:14` | `eth_blockNumber` every 12 s, two constants | one shared `BLOCK_POLL_MS` = 60 s, still hidden-tab-paused | **4 in every state** |
| `lib/wagmiConfig.ts:142` | `batch.multicall.batchSize` default 1 024 B → v1 token-list balance refresh (30 s) split into ~5 `eth_call`s | `batchSize: 16_384` → 1 call/refresh (Arbitrum 227 tokens ≈ 3) | **4 on v1 wallet** (v2 list lives in a modal: 0) |
| tests `Footer.test.tsx`, `shell.test.tsx` | pinned 12 000 | pinned 60 000 | — |

Dropped, measured 0 requests saved: reading Chainlink/depeg `decimals()`/`description()` once (they share a tick with `latestRoundData`, same Multicall3 request; would have touched fail-closed gates). Not needed for any budget, not done: wagmi `pollingInterval` (slows approve/receipt UX), `watch` removal (already absent), visibility hook (TanStack already pauses), balance event-refetch.

**Why not 90 %:** visitors are capped at −80 % by the ≤ 1 call/min budget (a 120 s poll would be −90 %, but a 2-min-old "live" block). Wallet states keep the 30 s `latestRoundData` oracle/depeg freshness polls (fund-flow gates, out of scope) + 30 s balances. Safe next levers if wanted: poll balances only while the token list is open (−2/min v1), align the two Chainlink legs' timers so they share one request (−2/min), 120 s block poll (−0.5/min).

## 4. Budget tests (`rpc-budget/guards.test.tsx`, v1 and v2)
a0/a ≤ 1 · b ≤ 6 · c, c20 ≤ 12 calls/min; hidden = 0; return > 0 and ≤ mount burst; wallet-less polls only `eth_blockNumber`; mount ceilings 4/12. Mutation-checked: restoring 12 s + 1 KiB batch fails 6 of 12 (e.g. "expected 14 ≤ 12", "expected 5 ≤ 1").

## 5. Verification
Suite 377 files / 6 068 tests green (main 375 / 6 046 + 2 files, 22 tests) · parity (`content-parity.swap`, `sounds-parity.swap`, `__tests__` content-parity) 45 green, content-map untouched, no copy changed · lint 93 warnings = baseline 93, 0 errors · `tsc --noEmit` clean · `next build` OK · no new deps/secrets/force-push; `src/app/api`, price-quorum, order engine, quote cadence untouched.

## 6. Diff
11 files, +592 / −7 (`git diff --stat origin/main...HEAD`): prod code = `Footer.tsx` ±7, `ui/v2/shell/Footer.tsx` ±5, `wagmiConfig.ts` +5, `rpc-polling.ts` +13 (new); everything else is tests/harness (`rpc-harness.ts` 183, `scenarios.tsx` 234, `harness.test.tsx` 54, `guards.test.tsx` 53) and this file.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/frontend-rpc-diet
