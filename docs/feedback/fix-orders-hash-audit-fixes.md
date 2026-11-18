# fix/orders-hash-audit-fixes: A86 findings on PR #708 (S-1, S-3, S-7, S-2/S-8, S-10)

Audit A86 of PR #708, blocked 0C/1H (S-1, a missing test). Fund-flow adjacent: Draft PR, **Auditor required**.
Branch off `origin/main` `64da340a`. POST only in `route.ts` (PR #709 edits GET and the import block).

- [x] Read findings, POST, hash tests, `order-hash.ts`, check script + tests, `contracts/order-engine/api/orders.ts`, PR #708 feedback
- [x] Premise question asked once (below)
- [ ] C1 S-1 route tests (tests only) + IM2 proof
- [ ] C2 S-3 lookup by signature before insert, comments corrected, legacy-row tests
- [ ] C3 S-7 observe log after the insert, with outcome; no signature fragment
- [ ] C4 S-2 + S-8 check script
- [ ] C5 S-10 superseded comment
- [ ] Verify (`agent-verify.sh --codeql`, `gen-claude-state --check`, lint delta), mutants, push, evidence 1-5

## Owner answers (asked once, 2026-11-18; they supersede the goal text)
- **S-3 lookup, signature encodings.** Measured: viem recovers one signature from 4 texts that all pass the route's
  0x + 130-hex check (v 27/28 or 0/1; the high-s twin with v flipped), and the executors' OZ `ECDSA.recover` refuses
  three of them, so an exact-text lookup lets a variant re-post of a legacy order add a never-executable row.
  Answer: **match all 4 encodings**, each case-insensitive and exact; the check script groups by the same canonical form.
