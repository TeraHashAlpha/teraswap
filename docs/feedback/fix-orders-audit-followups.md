# fix/orders-audit-followups: A98 (PR #718) R2-1, R2-2 · A102 (PR #719) R3-1, R3-2. Draft PR, **Auditor required**.
- [x] C1 `b64ac6ce` · [x] C2 `f0b93a9e` · [x] C3 `917e189f` · [x] C4 `a4a28d34` · [x] `12c01bb6` line citations (comments only) · [x] mutants, browser, verify

Owner's answers (asked once, before any fix code, 2026-11-26): (1) R3-1 also fixes the RAISE (a late 'denied' for B overwrote A's one slot; measured on
origin/main: A refused, then no rows, no button). (2) bare 64 hex: no digest, label stays `<hash-shaped>`. (3) "read succeeded" = a 2xx the fetchers report.

## 1. Findings (all four reproduced on origin/main `623f58fd`; none skipped). Mutants: 13/13 KILLED in a scratch copy of `12c01bb6`
- **R2-1** `order-hash.ts:89,97` (route `:846`, script lib `:64`). Tests `orders-server-builds-order-data.test.ts:612`, `check-order-hashes.test.ts:326`:
  13 new failed before. Mutants digest-for-short-text 17 red, bare-64 6 red.
- **R2-2** format check `route.ts:236`; `orders-create.validation.test.ts:184`; S-2 title `:792` and the old feedback line corrected. Canonical-step-first: 2 red.
- **R3-1** `useOrderEngine.ts:507-513` one state per wallet; raise `:545`; lower `:548`, `:1451`; answered reads `:636`, `:704`, `supabase.ts:169,199`.
  Tests `read-auth-flow.test.ts:405` (9 failed before: late 'ok', late 'denied', button path, two surfaces, failed/empty polls, list read) and
  `supabase.test.ts:77` (2 failed before). Mutants: unscoped lowering 3 red, each site alone 1, one-slot raise 1, list/poll not reporting 1/5, failure counted 1-2.
- **R3-2** `stats/route.ts:32-34`; `stats-read-signature.test.ts:112` (2 failed before). Back outside the try: 2 red.
- CHANGED EXPECTATIONS: (a) EIGHT TESTS THAT EXPECTED A DIGEST OF A TEXT THAT IS NOT 0x + 64 HEX NOW EXPECT `null` (not-a-hash, 3 signature spellings, bare
  window ×2, UUID, "every kind"); (b) `useOrderEngine.test.ts:173` NOW ALSO REQUIRES THE CALLBACK; (c) THE OLD (b) TEST KEEPS ITS ASSERTIONS UNDER A TITLE
  SAYING WHAT IT DOES (nothing cached), the two-surface test is new; (d) TITLES that claimed a digest / "no 0x is stored" reworded.

## 2. Browser, production builds, v1 and v2 (Chromium 1248 via PW_CHROMIUM; 1.65's 1255 not installed). Prompts head = main, same account and wallet named
account-switch P1/PB/PA 1/1/1 (4 samples per tree) · orders 1 · while-B 1/1/1 · preloaded 1 · race P1/RACE 1/1 · smart-B (main in full mode, from its own
tree) P1/PB/RETRY/PA 1/1/1/0 · smart-A-tabs 1/0/0 · REFUSING ordinary wallet (scratch spec) P1/STAY/PB/PA/RETRY/AFTER 1/0/1/0/1/0, same button per phase.
Committed rig 16/16 on each tree. 401 console counts differ run to run on BOTH trees (account-switch: 1 or 2 unsigned list reads in PB/PA). race-v1 (4 vs 3)
and while-B-v1 (8 vs 7): one extra unsigned B list read on head, one sample each, not sampled further (main's race-v2 has it too). Analytics: only timestamps differ.

## 3. Concerns
- R2-1 residual: 0x + a short signature piece + GUESSABLE padding to 64 hex still gets a digest, so it can still be searched. Only an HMAC (A98's other fix) closes it.
- A surface with no tracked order never polls: it comes down at its next list read (account switch, remount) or its own button.
- Not touched (A102 pre-existing): "Sign to view" still sets the list it fetched if the account changed while the prompt was open.
- Stats 500 body now includes createClient's message; the real client's, on 3 malformed URLs, repeated no URL or key. Beyond the named files: `supabase.ts`,
  `product-claims.ts` (5 line numbers; privacy sentence untouched), `fix-server-builds-order-data.md`. `AUDIT-TOTAL.md` has no A98/A102 entry: unchanged.

## 4. Verify: ONE run, **PASS**, on code commit `12c01bb6` (base `623f58fd`; started at load 5.49). This docs commit follows it.
suite 11,666/0 (555 files) · lint-delta +0/+0 · tsc 0 · build ok · v1v2-parity 123/0 · rpc-budget 36/0 · CodeQL head 11 = base 11, 0 new (pack 2.5.0) ·
keeper not requested. gitleaks on the 5 code commits: no leaks.
diff --stat at `12c01bb6`, 18 files +504 −56: hooks (`useOrderEngine.ts` 37, `read-auth-flow.test` 189, `.test` 3) · `lib/order-engine` (`order-hash` 9, `supabase` 9,
`supabase.test` 41) · `api/orders` (`route` 6, `stats/route` 14, tests `builds-order-data` 118, `stats-read-signature` 26, `validation` 21, `order-hash` 12) ·
`scripts/orders` (test 49, lib 6, CLI 3) · `product-claims` 4 · feedback 11 + 2.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/orders-audit-followups
NOT verified: CI; a real wallet extension, WalletConnect, Safe; real Supabase/PostgREST (shim); a Vercel deployment; keeper and Foundry (untouched); two mounted
surfaces in a real browser (jsdom only); the refusal spec is not committed (copy and all browser logs: `~/ts-worktrees/orders-audit-followups.logs/`).
