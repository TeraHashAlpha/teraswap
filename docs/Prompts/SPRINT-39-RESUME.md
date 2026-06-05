# Sprint 39 Resume — P200 commit + P201 completion

**Branch:** `feat/secure-storage` (currently checked out)  
**State:** P199 committed (478c3e2). P200 code is DONE but uncommitted (4 source files + 3 test files modified). P201 is partially done — migration tests exist in the 3 hook test files, but `secure-storage.test.ts` and `analytics-tracker.test.ts` are MISSING.

---

## Step 1 — Verify and commit P200

The following files have uncommitted changes that implement P200 (migrate sensitive keys to SecureStorage):

- `src/hooks/useOrderEngine.ts` — orders v3→v4 migration
- `src/hooks/useLimitOrder.ts` — limit orders v1→v2 migration
- `src/hooks/useConditionalOrder.ts` — conditional orders v1→v2 migration
- `src/lib/analytics-tracker.ts` — analytics v1→v2 migration

And these test files have been adapted for the async migration:

- `src/hooks/useOrderEngine.test.ts` — migration test added
- `src/hooks/useLimitOrder.test.ts` — migration test added
- `src/hooks/useConditionalOrder.test.ts` — migration test added

**Action:**

1. Run `npm run typecheck` — must pass
2. Run `npm run test` — check all existing tests pass
3. If all green, make TWO commits:

   ```bash
   git add src/hooks/useOrderEngine.ts src/hooks/useLimitOrder.ts src/hooks/useConditionalOrder.ts src/lib/analytics-tracker.ts
   git commit -m "feat(security): migrate sensitive localStorage keys to AES-GCM encryption [P200]"

   git add src/hooks/useOrderEngine.test.ts src/hooks/useLimitOrder.test.ts src/hooks/useConditionalOrder.test.ts
   git commit -m "test(security): add migration tests for encrypted storage keys [P201-partial]"
   ```

4. If tests FAIL, fix them before committing. Common issues:
   - Async `secureGet`/`secureSet` may need `await` in test setup
   - `crypto.subtle` must be available in vitest (Node's `webcrypto` — check `vitest.setup.ts`)
   - The XOR decode test for v3→v4 migration needs the old obfuscation key `'TeraSwap_2026_v3'`

---

## Step 2 — Create missing test files (P201 completion)

### `src/lib/secure-storage.test.ts` — CREATE (7 tests)

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initSecureStorage, secureSet, secureGet, secureRemove, isSecureStorageReady, SALT, ITERATIONS } from './secure-storage'

describe('SecureStorage', () => {
  const TEST_WALLET = '0x1234567890abcdef1234567890abcdef12345678'
  const TEST_WALLET_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

  beforeEach(() => {
    localStorage.clear()
    initSecureStorage(TEST_WALLET)
  })

  it('encrypts and decrypts a value', async () => {
    const data = { orders: [{ id: '1', amount: '100' }] }
    await secureSet('test_key', data)
    const result = await secureGet<typeof data>('test_key')
    expect(result).toEqual(data)
  })

  it('returns null for missing key', async () => {
    const result = await secureGet('nonexistent')
    expect(result).toBeNull()
  })

  it('returns null when decryption fails (wrong wallet)', async () => {
    await secureSet('test_key', { secret: 'data' })
    // Re-init with different wallet
    initSecureStorage(TEST_WALLET_B)
    const result = await secureGet('test_key')
    expect(result).toBeNull()
  })

  it('uses different IVs per write', async () => {
    await secureSet('test_key', 'value1')
    const raw1 = localStorage.getItem('test_key')
    await secureSet('test_key', 'value1') // same value, should get different IV
    const raw2 = localStorage.getItem('test_key')
    
    expect(raw1).toBeTruthy()
    expect(raw2).toBeTruthy()
    const payload1 = JSON.parse(raw1!)
    const payload2 = JSON.parse(raw2!)
    expect(payload1.iv).not.toEqual(payload2.iv)
  })

  it('falls back to plaintext when crypto.subtle unavailable', async () => {
    const originalSubtle = globalThis.crypto?.subtle
    // @ts-expect-error — testing fallback
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })
    
    try {
      initSecureStorage(TEST_WALLET)
      await secureSet('plain_key', { test: true })
      const result = await secureGet<{ test: boolean }>('plain_key')
      expect(result).toEqual({ test: true })
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: originalSubtle, configurable: true })
    }
  })

  it('handles QuotaExceededError gracefully', async () => {
    const originalSetItem = localStorage.setItem
    localStorage.setItem = vi.fn().mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    
    try {
      // Should not throw
      await expect(secureSet('quota_key', 'data')).resolves.not.toThrow()
    } finally {
      localStorage.setItem = originalSetItem
    }
  })

  it('reports ready state correctly', () => {
    expect(isSecureStorageReady()).toBe(true)
  })
})
```

**Notes:**
- The `crypto.subtle` fallback test may need adjustment depending on how `secure-storage.ts` checks for it. If it uses `typeof crypto !== 'undefined' && crypto.subtle`, mock accordingly.
- If `secureSet` doesn't resolve (returns void Promise), use `await secureSet(...)` without `resolves`.
- vitest in Node 25+ has `crypto.subtle` available natively — no polyfill needed.

### `src/lib/analytics-tracker.test.ts` — CREATE (1 migration test)

Only if analytics-tracker has no existing test file. Add:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'

describe('analytics-tracker migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('migrates plaintext analytics to v2 encrypted', async () => {
    // Seed old plaintext data
    const oldData = [
      { event: 'swap', timestamp: Date.now(), data: { pair: 'ETH/USDC' } }
    ]
    localStorage.setItem('teraswap_analytics', JSON.stringify(oldData))
    
    // Import and trigger migration (depends on how analytics-tracker exports)
    // This test structure depends on the actual analytics-tracker API
    // Adapt based on the module's public interface
    const { initSecureStorage } = await import('./secure-storage')
    initSecureStorage('0x1234567890abcdef1234567890abcdef12345678')
    
    // The actual migration happens when the tracker loads/reads
    // Verify old key is removed after migration
    // ... adapt based on actual implementation
  })
})
```

**Important:** This test skeleton needs adaptation based on how `analytics-tracker.ts` exposes its migration. Read the actual file to understand the public API, then write a test that seeds `teraswap_analytics` with plaintext JSON, triggers the load path, and verifies:
1. Data is accessible after migration
2. `teraswap_analytics` (old key) is removed from localStorage
3. `teraswap_analytics_v2` (new key) exists in localStorage

---

## Step 3 — Final commit

```bash
git add src/lib/secure-storage.test.ts src/lib/analytics-tracker.test.ts
git commit -m "test(security): add SecureStorage unit tests and migration coverage [P201]"
```

---

## Step 4 — Verify

```bash
npm run typecheck && npm run lint && npm run test
```

Report the final test count. Expected: ~1184 (1173 baseline + ~11 new).

---

## Quality checklist

- [ ] `crypto.subtle.encrypt` / `decrypt` used in secure-storage.ts (not JS-only cipher)
- [ ] AES-GCM with random IV per write (no IV reuse)
- [ ] PBKDF2 key derivation with 100k iterations
- [ ] Graceful fallback when Web Crypto unavailable
- [ ] SSR-safe (no `window` access at module level)
- [ ] All 4 sensitive keys encrypted with AES-GCM
- [ ] Transparent migration: existing plaintext data auto-encrypted on first load
- [ ] Old plaintext keys cleaned up after migration
- [ ] XOR obfuscation code removed from useOrderEngine
- [ ] All new + existing tests pass
- [ ] `npm run typecheck` passes
