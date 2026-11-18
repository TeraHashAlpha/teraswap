# fix/orders-hash-audit-fixes: A86 findings on PR #708 (S-1, S-3, S-7, S-2/S-8, S-10)

Audit A86 of PR #708, blocked 0C/1H (S-1, a missing test). Fund-flow adjacent: Draft PR, **Auditor required**.
Branch off `origin/main` `64da340a`. `route.ts`: POST only (PR #709 edits GET and the import block).

- [x] Read findings, POST, hash tests, `order-hash.ts`, check script + tests, `api/orders.ts`, PR #708 feedback
- [x] Premise question asked once (below) · [x] C1 S-1 · [x] C2 S-3 · [x] C3 S-7 · [x] C4 S-2/S-8 · [x] C5 S-10
- [x] Mutants · [x] Verify, push, evidence 5

## Owner answers (asked once, 2026-11-18; they supersede the goal text)
- **S-3 lookup, signature encodings.** Measured: viem recovers one signature from 4 texts that pass the route's 0x +
  130-hex check (v 27/28 or 0/1; the high-s twin with v flipped); the executors' OZ `ECDSA.recover` refuses 3 of them.
  Answer: **match all 4**, each case-insensitive and exact; the check script groups by the same canonical form.

## 1. Fixes (file:line → test, all in `orders-server-order-hash.test.ts` unless named)
- **S-1** tests only: `:325` "orderData differs … in %s" (8 skipped fields + routerDataHash with body zero + all nine,
  v2 and v3 = 20): stored hash = contract-style hash of the signed message; re-post with other orderData → 409, 1 row.
  `:253` retitled → `:293` "a top-level body field that differs … fails recovery".
- **S-3** `route.ts:762-781` lookup by `signature.ilike` of the 4 texts (`order-hash.ts:86` `orderSignatureEncodings`,
  `:108` `canonicalOrderSignature`) → 409 "Order already exists", nothing written; lookup error → 503. Comments
  `route.ts:801-803`, `:826-828`. Tests `:386` (legacy texts v2/v3, 4 encodings both ways, filter = 4 lower-case
  texts, 2 concurrent first posts → 201+409, 503); `order-hash.test.ts` (4 texts recover the same signer, real recovery).
- **S-7** `route.ts:739-760` `logHashMismatch(outcome)` called after the lookup/insert (`:775,:779,:830,:833,:837`);
  `storedHash` → `serverHash`; callerHash only if hash-shaped else `<string len N>`. Tests `:462`.
- **S-2/S-8** `check-order-hashes-lib.ts:121` byte-equal `match` / `non-canonical`, `:160` groups by computed hash and
  canonical signature, `:85-90` addresses lower-cased, `:57` `safeText`; CLI `check-order-hashes.ts:36` redact, `:74`
  0 rows → exit 1. Fixture `order-rows-a86.json` (12 rows); tests `check-order-hashes.test.ts:117-219`.
- **S-10** `contracts/order-engine/api/orders.ts:1-2` superseded comment.

## 2. Mutants (scratch worktree at head `e13dacd9`, logs in session scratchpad) — 10/10 killed
IM2 (auditor's text verbatim) → 18 fail: S-1 "v2|v3, orderData differs in {orderType, condition, targetPrice,
priceFeed, expiry, nonce, dcaInterval, dcaTotal, all nine at once}". IM2r (routerDataHash from order_data) → 4: S-1
"routerDataHash (the body's is zero)", "all nine", v2+v3. SL (lookup removed) → 26 (S-3 legacy/encoding/filter/race/503,
3 S-5 re-posts). SL4 (exact text only) → 4 (3 encodings + filter). RAW (caller text logged) → 5 (3 S-7 "no fragment",
"not a hash at all", 503 line). Script: S2N (normalised match) 4, S8 (no lower-case) 3, Z0 (0 rows exit 0) 1, GRPH 2, GRPS 2.

## 3. Legacy rows (pre-existing row + re-post of its signed order; before = SL mutant = main's route)
| order_hash text of the old row | before | after |
|---|---|---|
| UUID · 0x+UPPER · 0X+UPPER · 0X+lower · no 0x · another order's hash (v2 and v3) | 201, 2 rows | 409, 1 row |
| exact server hash (control) | 409 "(duplicate hash)", 1 row | 409 "Order already exists", 1 row |
| same order, signature re-posted as UPPER / v−27 / high-s twin / twin v−27 | 201, 2 rows | 409, 1 row |

## 4. Left to S-4/S-5 (their own goal), and no change
- S-4: the server should build `order_data` from the verified message + checked routerData (8 fields still unchecked).
- S-5: decide v3 once on the server and write `order_data` from it (route `typeof === 'number'` vs keeper `!= null`).
- S-6 (global uniqueness, no chain in the struct hash), S-9 (INTEGER columns vs uint256): no change, as asked.

## 5. Verify
- `agent-verify.sh --codeql`, ONE run at `07458f51` (started 11:26:59, load1 5.92 after two quiet checks 30 s apart, no
  other verify/CodeQL; `brew` stubbed): **RESULT PASS**, suite 11017/0 (514 files), lint +0/+0, tsc 0, build ok, parity
  123/0, rpc-budget 36/0, CodeQL 13 = 13, 0 new. `gen-claude-state --check`: current. gitleaks (branch commits): clean.
- diff `origin/main...HEAD`: 18 files, +1114/−94 (before this docs edit). Head = the commit adding this section.
  Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/orders-hash-audit-fixes
- **Not verified:** the lookup against real PostgREST/Supabase (`or` + `ilike` parsed by the fake only); the 7 s
  retry wait with Supabase down (read from postgrest-js source); production rows through the check script; the tree
  merged with main `bfe26155` (PR #713; no file overlap, `merge-tree` clean); keeper suite and forge (untouched); CI.

## Feedback — C2/C3 (`4a1311c8`, `0dda4837`)
### Concern
- postgrest-js 2.118 retries a GET that fails on the network 3× (1+2+4 s): with Supabase unreachable, POST now waits
  ~7 s before the 503 (the insert, a POST, never retried). `route.test.ts` had been reaching DNS for `fake.supabase.co`;
  it now stubs Supabase. Six other route mocks gained a no-row lookup stub.
### Performance
- `signature ilike` has no index: one scan of `orders` per POST. An index on `lower(signature)` would not serve `ilike`;
  a fix needs a migration (out of scope here).
### Edge case
- Log consumers filtering on `storedHash` must use `serverHash` + `outcome`. The lookup helper is a dynamic import inside
  POST only to leave PR #709's import block alone; it can move to the import block after #709 merges.
- The observe → reject switch in `fix-orders-server-side-order-hash.md` ("replace the `console.warn` just before the
  insert") no longer matches: it is now `if (callerHashMismatch) return 400` right after `route.ts:744`, before the lookup.
