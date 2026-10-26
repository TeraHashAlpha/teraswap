# Feedback — fix/unpriced-ack-paths

Auditor 64 (2026-10-26) tightening: M-1 (CoW path drops the unpriced ack), L-3 (split legs post
without it), keeper CoinGecko leg silently fails on the keyless tier when ≥ 2 DCA tokens are batched.

## Tasks

- [x] C1 web: ack travels with every `/api/swap` call (standard, cowswap, each split leg); every
      catch turns 409 `unpriced_ack_required` into the dialog, never a raw error; tests.
- [ ] C2 keeper: CoinGecko one address per request, sequential, 429 → retry once then absent;
      per-cycle `chainlink=n defillama=n coingecko=n` line; `BATCH_SIZE` DefiLlama-only; tests.
- [ ] C3 docs: ADR-024 paragraph + runbook restart note.
- [ ] Verify: web suite vs origin/main, lint delta 0, tsc clean, keeper tests green, diff --stat.
- [ ] Push + compare link; evidence 1–5 below.

## Baseline (origin/main f32ac28, this worktree, 2026-10-26)

Web 342 files / 5393 tests, lint 93 warnings / 0 errors (cap 94), tsc clean. Keeper 736 tests pass.

## Evidence

1. **Ack flow** (one source of truth = SwapBox `confirmUnpricedSwap`):
   `SwapBox dialog ─{unpricedAck:true}─▶ useSwap.execute(src,…,opts) ─ref─▶ fetchSwapViaApi: standard AND cowswap (M-1)`
   `              └{unpricedAck:true}─▶ useSplitSwap.execute(route,opts) ──▶ every leg's fetchSwapViaApi (L-3)`
   `/api/swap 409 unpriced_ack_required ─▶ UnpricedAckRequiredError (one class, useSwap) ─▶ idle + unpricedAckRequired`
   `in useSwap (standard + CoW) and useSplitSwap ─▶ SwapBox unpricedConsentOpen ─▶ dialog; Cancel resets the owning hook.`
   Tests: `SwapBox.price-tiers.test.tsx` +2 (split Continue → `executeSplitSwap(bestSplit, {unpricedAck:true})`;
   split 409 flag opens dialog, Cancel resets the split hook). Server gate `route.ts` untouched.
2. **CoW/split 409**: `useSwap.test.ts` +5 — CoW 409 → idle, no error, no frozen order, no signature, 1 fetch;
   `execute('cowswap',[],{unpricedAck:true})` posts the key → `cow_awaiting_review`; priced pair → same frozen
   order with/without ack, plain execute sends no key; reset clears; other 409 code → ordinary error.
   `useSplitSwap.test.ts` +5 — both legs carry the ack; plain → no key; 409 on leg 1 → idle, 1 fetch, no plan,
   `confirmPlan` no-op; reset then re-run with ack; other 409 code → per-leg error as before.
