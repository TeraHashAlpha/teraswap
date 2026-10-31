# feat/ui-v2-orders-history — feedback (B7: DCA positions parity, Orders, History)
Off origin/main `0a642a9` (#633). Signed, noreply, no PR (owner opens it as DRAFT — Auditor note: cancel path). Mocked tests.

## Checklist
- [x] C0 feedback file (`afec8dc`)
- [x] C1 DCA positions parity: ring + countdown (reduced motion: static text), P&L, filled/total, fills timeline, receipt, badges, cancel
- [x] C1 tests: content parity v1 DCADashboard ⊆ v2 (0 missing), countdown = v1, P&L = v1 (number equality)
- [x] C2 Orders tab: types, filters, status, chain, created/expiry, cancel via the reused DcaCancelSheet, empty/loading/error
- [x] C2 tests: per type + status, filter parity, cancel args = v1 per cancellable type
- [x] C3 History tab: swaps + DCA fills, tx links (tx chain), CSV export (v1 has it), mobile 375, keyboard nav, focus restore
- [x] C3 tests: per state
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, build, v1 module-identical proof, rpc-budget guards
- [ ] Evidence 1–7 + content-map delta; compare link
