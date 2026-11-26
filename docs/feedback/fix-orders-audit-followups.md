# fix/orders-audit-followups: A98 (PR #718) R2-1, R2-2 · A102 (PR #719) R3-1, R3-2. Draft PR, **Auditor required**.

- [x] C1 R2-1 caller-text digest only for 0x + 64 hex
- [ ] C2 R2-2 tests: no-0x / 0X signature gets 400
- [ ] C3 R3-1 "Sign to view" follows its wallet
- [ ] C4 R3-2 stats: database client inside the try
- [ ] mutants · browser counts v1/v2 · verify

Owner's answers (asked once, before any code, 2026-11-26): (1) R3-1 also fixes the RAISE: a late 'denied' for B overwrote A's single slot
(measured on origin/main with a temporary test: A refused, then no rows and no button). (2) bare 64 hex (no 0x): no digest, label stays
`<hash-shaped>`. (3) "a read succeeded" = a 2xx reported by the fetchers (`supabase.ts`), never "a list came back".
