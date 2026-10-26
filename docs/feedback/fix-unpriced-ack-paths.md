# Feedback — fix/unpriced-ack-paths

Auditor 64 (2026-10-26) tightening: M-1 (CoW path drops the unpriced ack), L-3 (split legs post
without it), keeper CoinGecko leg silently fails on the keyless tier when ≥ 2 DCA tokens are batched.

## Tasks

- [x] C1 web (b9ac1ae): ack on every `/api/swap` call (standard, cowswap, each split leg); every catch
      turns 409 `unpriced_ack_required` into the dialog, never a raw error; tests.
- [x] C2 keeper (f643e89): CoinGecko one address per request, sequential, 429 → retry once then absent;
      per-cycle `chainlink=n defillama=n coingecko=n` line; `BATCH_SIZE` DefiLlama-only; tests.
- [x] C3 docs (this commit): ADR-024 amendment + runbook rollout note + one SwapBox.tsx comment reworded
      (`scripts/check-product-claims.mjs` flagged "one source of truth" as a source-count claim; comment only).
- [x] Verify: web suite vs origin/main, lint delta 0, tsc clean, keeper tests green, diff --stat.
- [x] Push + compare link; evidence 1–5 below.

Baseline (origin/main f32ac28, this worktree): web 342 files / 5393 tests, lint 93 warn / 0 err
(cap 94), tsc clean; keeper 736 pass.

## Evidence

1. **Ack flow** (decided once, in SwapBox `confirmUnpricedSwap`):
   `SwapBox dialog ─{unpricedAck:true}─▶ useSwap.execute(src,…,opts) ─ref─▶ fetchSwapViaApi: standard AND cowswap (M-1)`
   `              └{unpricedAck:true}─▶ useSplitSwap.execute(route,opts) ──▶ every leg's fetchSwapViaApi (L-3)`
   `/api/swap 409 unpriced_ack_required ─▶ UnpricedAckRequiredError (one class, useSwap) ─▶ idle + unpricedAckRequired`
   `in useSwap (standard + CoW) and useSplitSwap ─▶ SwapBox unpricedConsentOpen ─▶ dialog; Cancel resets the owning hook.`
   Tests: `SwapBox.price-tiers.test.tsx` +2 (split Continue → `executeSplitSwap(bestSplit, {unpricedAck:true})`;
   split 409 flag opens the dialog, Cancel resets the split hook). Server gate `route.ts` untouched.
2. **CoW/split 409**: `useSwap.test.ts` +5 — CoW 409 → idle, no error, no frozen order, no signature, 1 fetch;
   `execute('cowswap',[],{unpricedAck:true})` posts the key → `cow_awaiting_review`; priced pair → same frozen
   order with/without ack, plain execute sends no key; reset clears; other 409 code → ordinary error.
   `useSplitSwap.test.ts` +5 — both legs carry the ack; plain → no key; 409 on leg 1 → idle, 1 fetch, no plan,
   `confirmPlan` no-op; reset then re-run with ack; other 409 code → per-leg error as before.
3. **Keeper**: `price-sources.js` — `fetchCoinGeckoUsd` one `contract_addresses` value per request, sequential,
   250 ms pause, 429 → `Retry-After` clamped [2 s, 10 s] + retry once, second 429 ends the leg, 20 s cycle budget;
   `getJsonStatus` (status-aware) wraps the unchanged `getJson`; `BATCH_SIZE`=50 DefiLlama-only;
   `createCycleQuoteContext` +`sourceSummary()`/`summaryLine()`; `executor.js` +6 lines logs it after the loop.
   Tests +12 (mocked fetch, injected sleep/clock, zero waiting): 3 tokens → 3 calls, every URL matches
   `contract_addresses=0x[0-9a-f]{40}&`, sequential ordering, 429×1 → present, 429×2 → absent + stop, 400 → next
   token asked, budget, 51 tokens → 51 CoinGecko vs 2 DefiLlama calls, 300 bps / 600 s / $250 pinned, wiring pin.
   Sample line: `DCA price sources: tokens=2 chainlink=0 defillama=2 coingecko=0 (coingecko: 429 twice on 0x4200…0006 — 2 of 2 token(s) absent)`.
4. **Docs**: ADR-024 row 3 + consequence bullet updated, new "Amendment 2026-10-26 — CoinGecko keyless limit"
   (one address per call, log-line format). Runbook `EXECUTOR-OPERATIONS.md` §3: pull → `npm ci --ignore-scripts`
   → `pm2 restart teraswap-keeper-arbitrum` → then `teraswap-executor`, with the expected line.
5. **Verification (final tree)**: web 342 files / 5405 tests pass (= 5393 + 12 new); lint 93 warn / 0 err (delta 0);
   tsc clean. Keeper 748 tests: 747 pass, 1 fail = `chain-verify.test.mjs:765` regex-linearity TIMING assertion
   (RATIO_BOUND) — fails 3/3 on clean origin/main too, files untouched by this branch (passed once in the 19:13
   baseline run): pre-existing flake, not fixed here. `price-sources` + `price-quorum-wiring`: 59/59.
   `git diff --stat origin/main` (excl. this file): 12 files, +690 / −75.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/unpriced-ack-paths (no PR, owner opens).

### Concern
- `chain-verify.test.mjs` "pattern set is linear" asserts a wall-clock ratio over a 0.7 ms baseline — noisy on
  this host (41×). Suggest a larger base input or a p50-of-N measurement; out of scope here.
- Read-scope deviation: `executor.js` edited (+6 lines, the tally log after the loop) — the per-cycle line
  cannot be emitted from `price-sources.js` alone (it has no cycle-end signal).
