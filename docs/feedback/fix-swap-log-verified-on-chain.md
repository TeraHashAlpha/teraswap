# Feedback: fix/swap-log-verified-on-chain (ADR-029 phase 1, goal 133)

Tables and long evidence: `fix-swap-log-verified-on-chain.tables.md` beside this file.

## Checklist
- [x] Commit 1: verification function (details A), real receipt fixtures, tests
- [x] Commit 2: POST inserts only a private pending row; symbols from the catalog (details B)
- [ ] Commit 3: PATCH `{ txHash, wallet }` verifies on-chain, one transaction one row, trackers after confirmation (details C)
- [ ] Commit 4: migration text and schema.sql mirror; code works before it is applied (details E)
- [ ] Commit 5: readers behind `SWAPS_PUBLIC_VERIFIED_ONLY`, default off (details D)
- [ ] Commit 6: script for stored rows, report mode by default (details F)
- [ ] Tests of details G: route replay, property, differential, browser v1 and v2, mutation proof
- [ ] One `scripts/agent-verify.sh --codeql` run on the last code commit; result here; push

## Owner answers (2026-11-25; they supersede the details text)
Asked in one question of four parts before any code; a fifth part was asked later, when real receipts showed a
further premise to be false.
1. Sides. Kind fee_collector reads the FeeCollector's own `SwapWithFee` event (both sides, ETH included); kind router
   keeps A.6 (Transfer legs, tx.value); cow the Trade event. A side still underivable is stored NULL, and the migration
   also drops NOT NULL on the six token/amount/symbol columns (schema.sql:22-29 had them NOT NULL).
2. Caller fields. On verification the server derives or clears: fee_collected, is_gasless, mev_protected, source;
   gas_savings_usd 0 and both mev fields null until phase 2. slippage and expected_output stay.
3. Before the migration: POST and PATCH write nothing at all, answer `{ ok: true }`, log `swaps_verified_columns_missing`.
4. Old rows (`--apply`): mark only when stored tokens and amount-in equal the receipt's and the receipt's amount-out is
   within 50% to 200% of the stored one; the frozen mainnet FeeCollector V1 counts as kind fee_collector.
5. CoW rule (replaces "tx.to equals the settlement contract" of A.4): kind cow = a Trade event EMITTED BY that chain's
   settlement contract whose owner is the wallet, for `cowswap` rows only. Measured that day: 39 of 84 recent
   settlements on the three chains were sent to a solver's own contract.
