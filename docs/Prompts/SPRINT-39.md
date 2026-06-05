# Sprint 39 — Encrypted Client Storage (FE-01)

**Sprint goal:** Replace plaintext localStorage for sensitive order and trade data with AES-GCM encryption via the Web Crypto API. Low-sensitivity UI preferences remain plaintext.  
**Branch:** `feat/secure-storage` (from `main`)  
**Prerequisite:** Sprint 38 merged (adds `teraswap_dismissed_orders` key).  
**Test count baseline:** 1173 (vitest count)  
**Finding:** FE-01 (backlog since Phase 1 audit)

---

## Background

All client-side persistence currently uses raw `localStorage` with no encryption. The `teraswap_orders_v3` key has basic XOR obfuscation (not cryptographic), but limit orders, conditional orders, and analytics are stored as plaintext JSON. Any browser extension, XSS payload, or shared-computer user can read:

- Signed order data (hashes, router data, DCA intervals)
- Limit order conditions (receiver addresses, amounts, target prices)
- Conditional order logic (Chainlink feed addresses, trigger prices)
- Full trade history (wallet address, token pairs, amounts, tx hashes)

**Threat model:** An attacker with read access to localStorage (XSS, malicious extension, shared computer) can extract trading patterns, order strategies, and wallet activity. They cannot steal funds (no private keys stored), but can front-run pending orders or build a profile of the user's trading behaviour.

---

## localStorage Inventory

| Key | Sensitivity | Current Protection | Action |
|-----|------------|-------------------|--------|
| `teraswap_orders_v3` | CRITICAL | XOR obfuscation | **Encrypt** → `teraswap_orders_v4` |
| `teraswap_limit_orders` | HIGH | None (plaintext) | **Encrypt** → `teraswap_limit_orders_v2` |
| `teraswap_conditional_orders` | HIGH | None (plaintext) | **Encrypt** → `teraswap_conditional_orders_v2` |
| `teraswap_analytics` | MEDIUM | None (plaintext) | **Encrypt** → `teraswap_analytics_v2` |
| `teraswap_dismissed_orders` | LOW | None | Keep plaintext |
| `teraswap-theme` | NONE | None | Keep plaintext |
| `teraswap_source_prefs` | NONE | None | Keep plaintext |
| `teraswap_mev_hint_dismissed` | NONE | None | Keep plaintext |
| `teraswap_permit2_education_seen` | NONE | None | Keep plaintext |
| `teraswap_beta_banner_dismissed` | NONE | None | Keep plaintext |
| `teraswap_notifications_enabled` | NONE | None | Keep plaintext |
| `teraswap_notif_prompt_dismissed` | NONE | None | Keep plaintext |

---

## P199 — SecureStorage utility module

### Context

No storage abstraction exists — all code uses raw `localStorage.getItem()`/`setItem()` directly. We need a reusable module that encrypts sensitive data using the Web Crypto API (SubtleCrypto), available in all modern browsers.

### Objective

Create a `SecureStorage` utility that provides `get<T>()` and `set<T>()` methods with AES-256-GCM encryption, keyed per wallet address.

### Requirements

1. Create `src/lib/secure-storage.ts` with the following API:

   ```typescript
   // Initialise with the connected wallet address (used as key material)
   export function initSecureStorage(walletAddress: string): void

   // Encrypt and write to localStorage
   export async function secureSet<T>(key: string, value: T): Promise<void>

   // Read from localStorage and decrypt
   export async function secureGet<T>(key: string): Promise<T | null>

   // Remove from localStorage
   export function secureRemove(key: string): void

   // Check if SecureStorage has been initialised
   export function isSecureStorageReady(): boolean
   ```

2. **Key derivation:** Use PBKDF2 to derive an AES-256 key from the wallet address:

   ```typescript
   const SALT = 'TeraSwap_SecureStorage_v1'  // Static salt — acceptable because wallet address is unique per user
   const ITERATIONS = 100_000

   async function deriveKey(walletAddress: string): Promise<CryptoKey> {
     const encoder = new TextEncoder()
     const keyMaterial = await crypto.subtle.importKey(
       'raw',
       encoder.encode(walletAddress.toLowerCase()),
       'PBKDF2',
       false,
       ['deriveKey']
     )
     return crypto.subtle.deriveKey(
       { name: 'PBKDF2', salt: encoder.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
       keyMaterial,
       { name: 'AES-GCM', length: 256 },
       false,
       ['encrypt', 'decrypt']
     )
   }
   ```

3. **Encryption format:** Each encrypted value stored as a JSON object:

   ```typescript
   interface EncryptedPayload {
     v: 1           // Version — for future migration
     iv: string     // Base64-encoded 12-byte IV
     ct: string     // Base64-encoded ciphertext
   }
   ```

   On `secureSet`: generate random 12-byte IV, encrypt with AES-GCM, store `{ v: 1, iv, ct }` as JSON string.
   On `secureGet`: parse JSON, decode IV and ciphertext, decrypt with AES-GCM, parse result as JSON.

4. **Error handling:**
   - If `crypto.subtle` is not available (HTTP, old browser): fall back to plaintext with `console.warn('[SecureStorage] Web Crypto not available, falling back to plaintext')`
   - If decryption fails (wrong wallet, corrupted data): return `null` and log warning. Do NOT throw.
   - If localStorage is full (QuotaExceededError): catch, log warning, return without crashing.

5. **SSR safety:** `crypto.subtle` and `localStorage` must be guarded with `typeof window !== 'undefined'` checks. The module must not crash during Next.js SSR.

6. **Wallet change handling:** When the user disconnects and reconnects with a different wallet, `initSecureStorage()` is called with the new address. The derived key changes, so data encrypted with the old wallet is unreadable — this is correct (orders belong to the wallet that created them). The old encrypted data remains in localStorage but returns `null` on `secureGet`, which triggers fresh loading from Supabase.

7. Export the `SALT` and `ITERATIONS` constants for tests.

### Do NOT

- Do NOT store private keys or seed phrases — this module is for order/trade metadata only
- Do NOT use a user-provided password — the wallet address is the key material (UX: no extra password step)
- Do NOT use `crypto.getRandomValues` polyfill — if Web Crypto is unavailable, fall back to plaintext
- Do NOT add any npm dependencies — Web Crypto is a browser built-in

### Files affected

- `src/lib/secure-storage.ts` — **CREATE**

### Expected output

1 commit: `feat(security): add SecureStorage utility with AES-256-GCM encryption [P199]`

### Quality criteria

- `crypto.subtle.encrypt` / `decrypt` used (not a JS-only cipher)
- AES-GCM with random IV per write (no IV reuse)
- PBKDF2 key derivation with 100k iterations
- Graceful fallback when Web Crypto unavailable
- SSR-safe (no `window` access at module level)
- TypeScript clean

---

## P200 — Migrate sensitive keys to SecureStorage

### Context

Four localStorage keys contain sensitive data. This prompt migrates them from plaintext/XOR to AES-GCM encryption via the `SecureStorage` module from P199.

### Objective

Replace direct `localStorage.getItem()`/`setItem()` calls for the 4 sensitive keys with `secureGet()`/`secureSet()`. Include transparent migration of existing plaintext data.

### Requirements

#### 1. Initialise SecureStorage on wallet connect

In the appropriate hook or component that handles wallet connection (likely `src/hooks/useOrderEngine.ts` or a top-level provider), call `initSecureStorage(address)` when the wallet connects:

```typescript
import { initSecureStorage } from '@/lib/secure-storage'

// When wallet address becomes available:
useEffect(() => {
  if (address) {
    initSecureStorage(address)
  }
}, [address])
```

#### 2. Migrate `teraswap_orders_v3` → `teraswap_orders_v4`

In `src/hooks/useOrderEngine.ts`:

- Replace the XOR-based `encodeOrders()`/`decodeOrders()` functions with `secureSet`/`secureGet`
- On load: try `secureGet('teraswap_orders_v4')` first. If null, try reading the old `teraswap_orders_v3` (XOR decode), re-encrypt with `secureSet('teraswap_orders_v4', data)`, then `localStorage.removeItem('teraswap_orders_v3')`
- On save: `secureSet('teraswap_orders_v4', orders)`
- Remove the XOR `encode`/`decode` helper functions and the `'TeraSwap_2026_v3'` key constant

#### 3. Migrate `teraswap_limit_orders` → `teraswap_limit_orders_v2`

In `src/hooks/useLimitOrder.ts`:

- Replace `localStorage.getItem('teraswap_limit_orders')` with `secureGet('teraswap_limit_orders_v2')`
- On load: try v2 first, if null try plaintext v1, re-encrypt to v2, remove v1
- On save: `secureSet('teraswap_limit_orders_v2', orders)`

#### 4. Migrate `teraswap_conditional_orders` → `teraswap_conditional_orders_v2`

In `src/hooks/useConditionalOrder.ts`:

- Same pattern as limit orders: try v2, fallback to v1 plaintext, migrate, remove v1

#### 5. Migrate `teraswap_analytics` → `teraswap_analytics_v2`

In `src/lib/analytics-tracker.ts`:

- Same pattern. Note the 1000-event cap — the encrypted payload will be larger (base64 overhead). Verify the cap still works after encryption.

#### 6. Async handling

`secureGet` and `secureSet` are async (Web Crypto is promise-based). The current code uses synchronous localStorage reads in hooks. Handle this by:

- Loading state: initialise with empty array, then populate via `useEffect` async call
- Save: fire-and-forget with error catch (don't block UI on encryption)
- The hooks already have loading patterns — adapt them for async

### Do NOT

- Do NOT change any key that's LOW or NONE sensitivity (dismissed orders, theme, flags stay plaintext)
- Do NOT break the v3→v4 migration path — existing users must not lose their orders
- Do NOT remove `teraswap_dismissed_orders` from plaintext — it's just order IDs, LOW risk
- Do NOT change Supabase sync logic
- Do NOT change the order creation API

### Files affected

- `src/hooks/useOrderEngine.ts` — orders v3→v4 migration
- `src/hooks/useLimitOrder.ts` — limit orders migration
- `src/hooks/useConditionalOrder.ts` — conditional orders migration
- `src/lib/analytics-tracker.ts` — analytics migration

### Expected output

1 commit: `feat(security): migrate sensitive localStorage keys to AES-GCM encryption [P200]`

### Quality criteria

- All 4 sensitive keys encrypted with AES-GCM
- Transparent migration: existing plaintext data auto-encrypted on first load
- Old plaintext keys cleaned up after migration
- XOR obfuscation code removed from useOrderEngine
- No data loss during migration
- Async reads don't cause UI flash (loading state handled)
- All existing tests pass
- `npm run typecheck` passes

---

## P201 — Tests for SecureStorage and migration

### Context

P199 and P200 added encryption infrastructure and migrated 4 keys. This prompt adds test coverage.

### Requirements

#### SecureStorage unit tests (`src/lib/secure-storage.test.ts` — CREATE)

1. **`'encrypts and decrypts a value'`** — `secureSet` then `secureGet` returns original value.
2. **`'returns null for missing key'`** — `secureGet` on nonexistent key returns `null`.
3. **`'returns null when decryption fails (wrong wallet)'`** — init with wallet A, set value, init with wallet B, get returns `null`.
4. **`'different IVs per write'`** — `secureSet` same key twice, raw localStorage payloads have different `iv` fields.
5. **`'falls back to plaintext when crypto.subtle unavailable'`** — mock `crypto.subtle` as `undefined`, verify `secureSet`/`secureGet` still work (plaintext fallback).
6. **`'SSR safe: no crash when window undefined'`** — simulate SSR environment.
7. **`'handles QuotaExceededError gracefully'`** — mock `localStorage.setItem` to throw, verify no crash.

#### Migration tests (in existing test files)

8. **`'migrates v3 XOR orders to v4 encrypted on first load'`** — seed localStorage with old XOR-encoded `teraswap_orders_v3` data, load hook, verify orders are accessible AND `teraswap_orders_v3` is removed.
9. **`'migrates plaintext limit orders to v2 encrypted'`** — seed `teraswap_limit_orders` with JSON, load hook, verify migration.
10. **`'migrates plaintext conditional orders to v2 encrypted'`** — same pattern.
11. **`'migrates plaintext analytics to v2 encrypted'`** — same pattern.

#### Notes on mocking Web Crypto in tests

JSDOM does not include `crypto.subtle`. Options:
- Use the Node.js `crypto` module's `webcrypto` export: `globalThis.crypto = require('crypto').webcrypto`
- Set this in test setup (`vitest.setup.ts`) or per-file
- If JSDOM's TextEncoder is not available, import from `util`

### Do NOT

- Do NOT test the exact ciphertext output (non-deterministic due to random IV)
- Do NOT add external crypto polyfill dependencies

### Files affected

- `src/lib/secure-storage.test.ts` — **CREATE** (7 unit tests)
- `src/hooks/useOrderEngine.test.ts` — add migration test
- `src/hooks/useLimitOrder.test.ts` — add migration test
- `src/hooks/useConditionalOrder.test.ts` — add migration test (if test file exists, else create)
- `src/lib/analytics-tracker.test.ts` — add migration test (if test file exists, else create)

### Expected output

1 commit: `test(security): add SecureStorage unit tests and migration coverage [P201]`

### Quality criteria

- All new tests pass
- All existing tests pass (no regression from async changes)
- Test count: 1173 + ~11 = **~1184**
- `npm run typecheck` passes

---

## Sprint Summary

| Prompt | Scope | Files | Impact |
|--------|-------|-------|--------|
| P199 | SecureStorage utility | 1 new | Infrastructure — AES-GCM encryption module |
| P200 | Migrate 4 sensitive keys | 4 edited | Security — orders/analytics encrypted at rest |
| P201 | Tests | 5 new/edited | Coverage — ~11 new tests |

**Total estimated scope:** 3 commits, 1 new module + 4 edits + tests.

**Risk assessment:** MEDIUM. The async migration changes touch core order hooks. Transparent v1→v2 migration must not lose user data. The encryption itself is standard (AES-GCM via Web Crypto), but the async conversion of previously-synchronous reads requires careful handling of React hook lifecycle.

**Rollback plan:** If encryption causes issues, the fallback path (Web Crypto unavailable) falls through to plaintext — users don't lose access to their data.
