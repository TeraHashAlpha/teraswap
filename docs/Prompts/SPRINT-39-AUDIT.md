# Sprint 39 Audit — Encrypted Client Storage (FE-01)

**Role:** You are a Senior Security Auditor reviewing Sprint 39 of the TeraSwap DEX aggregator. Your job is to verify the correctness of the AES-256-GCM encryption implementation, the safety of the migration from plaintext/XOR to encrypted storage, and test coverage.

**Branch:** `feat/secure-storage`  
**Base:** `main`  
**Commits:** 4 (P199 `478c3e2`, P200 `df0683e`, P201-partial `ebcde24`, P201 `9c1cc0b`)  
**Files changed:** `src/lib/secure-storage.ts` (CREATE), `src/hooks/useOrderEngine.ts`, `src/hooks/useLimitOrder.ts`, `src/hooks/useConditionalOrder.ts`, `src/lib/analytics-tracker.ts`, test files  
**Test count:** 1173 → 1181 (+8 new)

**Risk level:** MEDIUM-HIGH — touches core order persistence layer. Incorrect encryption/decryption = users lose access to their orders. Incorrect migration = existing orders vanish. Async conversion of previously-synchronous hooks may cause race conditions or UI flash.

---

## Context

Sprint 39 implements FE-01 (backlog since Phase 1 audit): replace plaintext/XOR localStorage for sensitive order and trade data with AES-256-GCM encryption via the Web Crypto API.

- **P199** — `SecureStorage` utility module: `initSecureStorage(walletAddress)`, `secureSet<T>()`, `secureGet<T>()`, `secureRemove()`. PBKDF2 key derivation (100k iterations) from wallet address. Random 12-byte IV per write. Graceful plaintext fallback when `crypto.subtle` unavailable.
- **P200** — Migrates 4 sensitive keys: `teraswap_orders_v3` → `v4` (from XOR), `teraswap_limit_orders` → `v2`, `teraswap_conditional_orders` → `v2`, `teraswap_analytics` → `v2` (all from plaintext). Transparent one-time migration on first load.
- **P201** — 7 SecureStorage unit tests + migration tests across hooks.

**Prior audit context:** The comprehensive audit (2026-05-28) flagged FULL-H-03 ("SecureStorage is dead code; sensitive order data still plaintext/XOR") and FULL-M-08/M-09 (XOR mislabeled as security, limit/conditional plaintext). This sprint is the fix.

---

## Audit Checklist

### 1. P199 — SecureStorage Module (`src/lib/secure-storage.ts`)

#### Cryptography

- [ ] **Algorithm:** Verify `AES-GCM` with 256-bit key length is used (not AES-CBC, AES-CTR, or any other mode).
- [ ] **IV generation:** Verify `crypto.getRandomValues(new Uint8Array(12))` — must be 12 bytes, must be random per write, must NOT be static or derived.
- [ ] **IV uniqueness:** Two calls to `secureSet` with the same key must produce different IVs. Reusing an IV with the same key under GCM is catastrophic (leaks XOR of plaintexts + allows authentication tag forgery).
- [ ] **Key derivation:** PBKDF2 with SHA-256, 100,000 iterations, static salt `'TeraSwap_SecureStorage_v1'`. Verify the wallet address is lowercased before use as key material (prevents case-sensitivity issues across wallets).
- [ ] **Key material:** Wallet address used as input to PBKDF2 (not as the raw key). Verify `importKey('raw', ..., 'PBKDF2', false, ['deriveKey'])` followed by `deriveKey(...)`.
- [ ] **Key non-extractable:** The derived CryptoKey must have `extractable: false` — verify the third argument to `deriveKey` is `false`.
- [ ] **No key caching across wallets:** When `initSecureStorage(newAddress)` is called with a different address, verify the old key is discarded and a new one derived. Check there is no stale key scenario.

#### Storage Format

- [ ] **Encrypted payload structure:** Verify stored JSON matches `{ v: 1, iv: string, ct: string }` where `iv` and `ct` are base64-encoded.
- [ ] **Base64 encoding:** Verify `btoa(String.fromCharCode(...))` or equivalent for Uint8Array→base64. Check for potential issues with large payloads (btoa has a max call stack size with spread operator on very large arrays — check if `chunk` approach is used).
- [ ] **Version field:** `v: 1` present — enables future format migration.

#### Error Handling

- [ ] **`crypto.subtle` unavailable:** Falls back to plaintext `JSON.stringify`/`JSON.parse` with `console.warn`. Does NOT throw. Does NOT silently lose data.
- [ ] **Decryption failure:** Returns `null`, logs warning. Does NOT throw. Does NOT delete the encrypted data (allows retry with correct wallet).
- [ ] **QuotaExceededError:** Caught, logged, does NOT crash the app.
- [ ] **SSR safety:** All `window`, `localStorage`, `crypto` access guarded with `typeof window !== 'undefined'`. Module-level code does NOT access these.
- [ ] **Invalid JSON in localStorage:** If someone manually corrupts the stored value, `secureGet` should catch the parse error and return `null`.

#### API Design

- [ ] **`isSecureStorageReady()`** returns `false` before `initSecureStorage()` is called.
- [ ] **`secureGet`/`secureSet` before init:** Verify behaviour — should either throw a clear error or fall back to plaintext (not silently use an undefined key).
- [ ] **Generic types:** `secureGet<T>` and `secureSet<T>` preserve type safety.

### 2. P200 — Migration (`useOrderEngine`, `useLimitOrder`, `useConditionalOrder`, `analytics-tracker`)

#### `useOrderEngine.ts` — Orders v3→v4

- [ ] **XOR removal:** The old `obfuscate()`/`deobfuscate()` functions and `OBFUSCATION_KEY` (`'TeraSwap_2026_v3'`) are REMOVED.
- [ ] **Migration path:** On load, tries `secureGet('teraswap_orders_v4')` first. If null, reads old `teraswap_orders_v3`, XOR-decodes it, re-encrypts to v4 via `secureSet`, then removes `teraswap_orders_v3` from localStorage.
- [ ] **Migration atomicity:** If re-encryption fails (e.g., quota exceeded), the old v3 data must NOT be deleted. Verify the remove happens AFTER successful write.
- [ ] **Empty state:** If both v3 and v4 are missing, returns empty array (not null, not crash).
- [ ] **initSecureStorage called:** Verify `initSecureStorage(address)` is called in a `useEffect` when `address` becomes available, BEFORE any `secureGet`/`secureSet` calls.

#### `useLimitOrder.ts` — Limit Orders v1→v2

- [ ] **Migration:** tries `secureGet('teraswap_limit_orders_v2')`, falls back to `localStorage.getItem('teraswap_limit_orders')` (plaintext JSON), migrates, removes old key.
- [ ] **Same atomicity check** — old key removed only after successful write.

#### `useConditionalOrder.ts` — Conditional Orders v1→v2

- [ ] **Same pattern** as limit orders but for `teraswap_conditional_orders` → `teraswap_conditional_orders_v2`.

#### `analytics-tracker.ts` — Analytics v1→v2

- [ ] **Same pattern** for `teraswap_analytics` → `teraswap_analytics_v2`.
- [ ] **1000-event cap:** Verify the cap still works after encryption. The encrypted payload is larger (base64 overhead ~33%). Check if the cap is enforced BEFORE encryption (correct) or after (wrong — would cap at fewer events).

#### Async Handling (all hooks)

- [ ] **Loading state:** Hooks initialize with empty arrays, then populate via `useEffect` async call. Verify no flash of "no orders" before data loads.
- [ ] **Save pattern:** Fire-and-forget with error catch — `secureSet(key, data).catch(err => console.error(...))`. Does NOT block UI on encryption.
- [ ] **Race conditions:** If two saves fire concurrently (e.g., rapid order creation), verify the last write wins (no interleaving of partial data). Check if writes are serialized or if this is an accepted risk.
- [ ] **No stale closure:** Verify the save function captures the current data, not a stale closure from a previous render.

#### Untouched Keys

- [ ] **LOW/NONE sensitivity keys unchanged:** Verify these are NOT encrypted and still work as plaintext: `teraswap_dismissed_orders`, `teraswap-theme`, `teraswap_source_prefs`, `teraswap_mev_hint_dismissed`, `teraswap_permit2_education_seen`, `teraswap_beta_banner_dismissed`, `teraswap_notifications_enabled`, `teraswap_notif_prompt_dismissed`.

### 3. P201 — Tests

- [ ] **7 SecureStorage unit tests** in `secure-storage.test.ts`: encrypt/decrypt roundtrip, missing key, wrong wallet, different IVs, plaintext fallback, SSR safety, QuotaExceededError.
- [ ] **Migration tests** in hook test files: v3 XOR→v4, plaintext→v2 for limit/conditional/analytics.
- [ ] **No mock bleed:** Each test isolates its mocks. localStorage and crypto mocks cleaned up in afterEach.
- [ ] **Tests are genuine:** Verify tests actually exercise the encryption path (not accidentally hitting the plaintext fallback because crypto.subtle is missing in the test environment). Check if `crypto.subtle` is available in the test setup (Node 20+ webcrypto).
- [ ] **IV uniqueness test is real:** Verify the test writes the same value twice to the same key and checks the raw localStorage `iv` fields differ (not just that the ciphertext differs — ciphertext always differs with different IV, so that's a weaker check).

### 4. General

- [ ] **No scope creep:** Only the files listed above changed. No changes to Supabase sync, order creation API, contract interactions, or UI components.
- [ ] **No new dependencies:** Web Crypto is a browser built-in. No npm packages added.
- [ ] **FEEDBACK.md:** Check if the Code Agent documented any deviations from the spec.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.

### 5. Security Considerations

- [ ] **Wallet address as key material:** The wallet address is public — this means anyone who knows the address can derive the encryption key. This is ACCEPTED by design (see Sprint 39 spec: "UX: no extra password step"). The threat model is: protect against casual read access (extensions reading localStorage), not against targeted attacks where the attacker knows the wallet address. Verify this is documented/commented.
- [ ] **Static salt:** `'TeraSwap_SecureStorage_v1'` is acceptable because the wallet address provides per-user uniqueness. Flag only if salt is missing entirely.
- [ ] **No private key storage:** Verify the module does NOT store private keys, seed phrases, or any wallet secret. It should only store order metadata, signatures, and analytics.
- [ ] **XOR code fully removed:** After migration, no reference to the old XOR obfuscation should remain in production code. The constant `'TeraSwap_2026_v3'` should only appear in migration logic (reading old data), not in any write path.

---

## Expected Output

```markdown
## Sprint 39 Audit Verdict

**Branch:** feat/secure-storage
**Commits reviewed:** 478c3e2, df0683e, ebcde24, 9c1cc0b
**Tests:** 1173 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 39-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### Crypto Implementation Review

| Check | Status |
|-------|--------|
| AES-256-GCM | {✅/❌} |
| Random 12-byte IV per write | {✅/❌} |
| PBKDF2 100k iterations | {✅/❌} |
| Key non-extractable | {✅/❌} |
| Plaintext fallback | {✅/❌} |
| SSR safe | {✅/❌} |

### Migration Paths Verified

| Key | Old → New | Migration | Cleanup |
|-----|-----------|-----------|---------|
| orders | v3 (XOR) → v4 (AES) | {✅/❌} | {✅/❌} |
| limit_orders | v1 (plain) → v2 (AES) | {✅/❌} | {✅/❌} |
| conditional_orders | v1 (plain) → v2 (AES) | {✅/❌} | {✅/❌} |
| analytics | v1 (plain) → v2 (AES) | {✅/❌} | {✅/❌} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
