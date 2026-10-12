# Feedback — fix/codeql-auth-swap

Base `origin/main` e226962 (PR #566 `fix/codeql-log-injection` merged — its `forLog` is reused). Worktree `~/ts-worktrees/codeql-auth-swap`, real `npm ci`.
Scope: CodeQL #1 `auth.ts:31`, #2 `api-auth.ts:94` (js/insufficient-password-hash), #16 `swap/route.ts:242` (js/log-injection). The agent dismissed nothing.

## Checklist
- [x] C1 facts (a)(b)(c) — this file, no code
- [x] C2 #1 `auth.ts` → HMAC-SHA256 with per-process random key + tests
- [x] C3 #2 `api-auth.ts` decision + dismissal text (comment-only)
- [x] C4 #16 `swap/route.ts:242` → `forLog()` on the logged values + test
- [x] Verify: suite vs origin/main, lint delta 0, tsc, `diff --stat`, push + compare link

## 1. Facts (read-only, origin/main e226962)
**(a) Issuance.** One path: `src/app/api/admin/api-keys/route.ts:73-76` — `const body = randomBytes(32).toString('base64url')` / `` return `tsk_${body}` `` → 32 random bytes (256 bit), server-minted. POST reads only `name, tier, expiresAt, rateLimitPerMin, rateLimitPerDay` (L96-149); L162-163 `const plaintext = generatePlaintextKey()` / `const keyHash = hashApiKey(plaintext)` → L169 `key_hash: keyHash`. Only `api_keys` writers in the tree: this route (insert L168, soft-delete L269) and `api-auth.ts` usage counters (L128). No script, SQL seed or other `tsk_` producer. **No path accepts a caller-supplied key value.**
**(b) `ADMIN_API_KEYS_SECRET`.** `.env.example:101-105`: "Pepper used to derive the SHA-256 hash for admin API keys (per-key storage avoids ever persisting the plaintext). Generate via: `openssl rand -hex 32`. Rotation requires re-hashing every key in the KV admin index." → 32 random bytes / 64 hex chars. Doc drift (read-only, not fixed): in code it is a plain Bearer token (`api-keys/route.ts:43-47` → `verifyBearerToken`); `hashApiKey` is unkeyed and `api_keys` lives in Supabase — there is no pepper and no KV index.
**(c) `auth.ts:30-32`.** `const hashA = createHash('sha256').update(token).digest()` / `const hashB = createHash('sha256').update(expectedSecret).digest()` (L31, flagged) / `return timingSafeEqual(hashA, hashB)`. `token` = Authorization header minus `Bearer `; `expectedSecret` = env secret from 7 callers (admin/api-keys, admin/dca-freeze, admin/kill-switch, monitor/heartbeat/admin, monitor/tick, monitor/validate-execution, quote). Nothing is persisted; the digests only give `timingSafeEqual` equal-length inputs.

Out-of-list reads, recorded: `swap/route.ts` import block (L1-15, to add the import) and L63-85/L150-175 via targeted grep (`ADDRESS_RE` validates `from` L162 and `recipient` L168 before the R1 block); `package.json` scripts (verification commands); `supabase/api-keys.sql` header + `key_hash` column comment (hit by the key_hash grep); `docs/feedback/` listing (file naming).

## 2. #1 — HMAC change (C2)
`auth.ts`: `createHash('sha256')` → `createHmac('sha256', COMPARISON_KEY)` on both sides; `COMPARISON_KEY = randomBytes(32)` at module load (memory only — no env var, no persisted format, no migration). Signature and verdicts unchanged; 7 callers untouched.
Tests `src/lib/auth.test.ts` — 15 (11 existing + 4 new; RED 4/15 before the change, GREEN after). Valid secret: "returns true for matching Bearer token"; wrong secret: "returns false for mismatched tokens (same length)"; new: "draws a 32-byte random comparison key at module load (in-memory only, no env var)", "MACs both sides with the same in-process key, then compares the two 32-byte MACs", "length mismatch never short-circuits: both sides are MAC’d and timingSafeEqual still sees 32 vs 32 bytes", "a second module instance draws a different key, produces different MACs, and returns the same verdicts".
Auditor note: CodeQL models `createHmac(...).update(x)` with the same CryptographicOperation sink as `createHash`, and the flagged source is the `*secret*`-named parameter, which still flows into `.update()` — alert #1 may remain open after this PR. If so, the remaining action is the owner's dismissal: "Not credential storage — a constant-time comparator whose inputs are machine-generated 256-bit tokens (`openssl rand -hex 32`); nothing is persisted; a work-factor hash would add latency with no security gain." `admin/api-keys/route.ts:9` still says "SHA-256-comparison helper" (comment only, file out of scope).

## 3. #2 — decision: NO code change (C3)
Per fact (a) every `key_hash` is SHA-256 of a server-minted `tsk_` + base64url(`randomBytes(32)`) token (256 random bits) and no caller-supplied key path exists. Only the dead `// codeql[js/insufficient-key-size]` (wrong rule id) at `api-auth.ts:93` became a one-line pointer; `hashApiKey` and its digest tests (incl. the sha256("") vector) are untouched.
Dismissal text for the owner (alert #2, js/insufficient-password-hash, `api-auth.ts:94`, reason "false positive"): "hashApiKey() is a lookup digest of a 256-bit random API token minted server-side (admin/api-keys/route.ts generatePlaintextKey: randomBytes(32)); no human-chosen or caller-supplied value ever reaches it. Password hashes (bcrypt/scrypt/argon2/PBKDF2) exist to slow brute force of low-entropy secrets; a 2^256 keyspace cannot be brute-forced, so plain SHA-256 is the correct primitive and the industry standard for API-key storage (Stripe, GitHub, AWS). A keyed HMAC would also invalidate every stored digest and force rotation of all issued keys."

## 4. #16 — swap route (C4)
Diff `src/app/api/swap/route.ts` = 3 lines: `+import { forLog } from '@/lib/log-sanitize'`; L243 `` `Expected: ${forLog(expectedRecipient)}, Got: ${forLog(recipientCheck.extracted)}` `` (was unwrapped). Control flow, R1 recipient guard, calldata validation and responses untouched — the validator still receives the raw value, same 400, same error string.
Auditor note: `from` (L162) and `recipient` (L168) are `ADDRESS_RE`-validated before the R1 block, so CRLF cannot reach this line via POST; the wrap is a CodeQL-visible barrier for `expectedRecipient` and a real one for the upstream-derived `recipientCheck.extracted`.
Tests `src/app/api/swap/route.test.ts`: existing V9 "returns 400 when recipient does not match requesting wallet" untouched; new "guard unchanged: still 400 with the same error, validator still receives the RAW expected recipient" and "log line receives the sanitised values: CR/LF flattened to spaces, nothing else altered" (RED 1/36 before the wrap, GREEN 36/36 after).

## 5. Verify (measured 2026-10-12 23:52–23:57)
Suite: branch 294 files / 4418 tests pass vs origin/main 294 / 4412 (+6 = 4 auth + 2 swap; 0 failures). Lint `eslint . --max-warnings 94`: 94 warnings / 0 errors on both (delta 0). `tsc --noEmit`: 0 errors on both. Baseline ran in a detached worktree `~/ts-worktrees/codeql-auth-swap-base` (e226962, own `npm ci`), left in place.
`git diff --stat origin/main..HEAD` (code): `src/lib/auth.ts` 30 · `src/lib/auth.test.ts` 98 · `src/lib/api-auth.ts` 2 (comment only) · `src/app/api/swap/route.ts` 3 · `src/app/api/swap/route.test.ts` 54 · + this file. No new deps, env vars or secrets; no dismissals; no force-push; no PR.
Commits (SSH-signed, noreply committer): ab903b9 C1 · 8a6858d C2 · 4c9236f C3 · 41fac8e C4 · C5 = this file. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/codeql-auth-swap
