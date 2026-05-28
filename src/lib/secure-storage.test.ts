// @vitest-environment jsdom
/**
 * [P201] SecureStorage — AES-256-GCM encryption-at-rest unit tests.
 *
 * Exercises the public API end-to-end against the jsdom env's localStorage and
 * the Node webcrypto SubtleCrypto exposed on globalThis. Covers the happy path
 * (encrypt → decrypt round-trip), the wrong-wallet / missing-key null paths, IV
 * uniqueness per write, and the three graceful-degradation paths — no Web
 * Crypto, SSR (no window), and storage quota — which must NEVER throw.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initSecureStorage,
  secureGet,
  secureSet,
  secureRemove,
} from './secure-storage'

const WALLET_A = '0x1111111111111111111111111111111111111111'
const WALLET_B = '0x2222222222222222222222222222222222222222'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // Reconnect a wallet so a key can be derived. Switching address between
  // tests resets the cached derived key inside the module.
  initSecureStorage(WALLET_A)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SecureStorage', () => {
  it('encrypts and decrypts a value', async () => {
    const value = { orders: [{ id: 'a', sig: '0xdeadbeef' }], secretNote: 'top-secret' }
    await secureSet('teraswap_orders_v4', value)

    // On disk it is an AES-GCM EncryptedPayload, not the plaintext object.
    const raw = localStorage.getItem('teraswap_orders_v4')
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('top-secret')
    const payload = JSON.parse(raw as string)
    expect(payload.v).toBe(1)
    expect(typeof payload.iv).toBe('string')
    expect(typeof payload.ct).toBe('string')

    // …and it round-trips back to the original object.
    const out = await secureGet<typeof value>('teraswap_orders_v4')
    expect(out).toEqual(value)
  })

  it('returns null for a missing key', async () => {
    expect(await secureGet('does_not_exist')).toBeNull()
  })

  it('returns null when decryption fails (wrong wallet)', async () => {
    await secureSet('k', { amount: 1000 })
    // Reconnecting as a different wallet derives a different key, so the
    // ciphertext written by wallet A cannot be decrypted — returns null
    // (which the hooks treat as "fall back to a fresh load from Supabase").
    initSecureStorage(WALLET_B)
    expect(await secureGet('k')).toBeNull()
  })

  it('uses a different IV for each write', async () => {
    await secureSet('k', { a: 1 })
    const iv1 = JSON.parse(localStorage.getItem('k') as string).iv
    await secureSet('k', { a: 1 })
    const iv2 = JSON.parse(localStorage.getItem('k') as string).iv
    expect(iv1).not.toBe(iv2)
  })

  it('falls back to plaintext when crypto.subtle is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('crypto', undefined)

    await secureSet('pref', { hello: 'world' })
    // Written as plaintext JSON (no encrypted-payload wrapper)…
    expect(JSON.parse(localStorage.getItem('pref') as string)).toEqual({ hello: 'world' })
    // …and still reads back through the same API.
    expect(await secureGet<{ hello: string }>('pref')).toEqual({ hello: 'world' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Web Crypto not available'))
  })

  it('is SSR-safe when window is undefined', async () => {
    vi.stubGlobal('window', undefined)
    await expect(secureSet('k', { a: 1 })).resolves.toBeUndefined()
    await expect(secureGet('k')).resolves.toBeNull()
    expect(() => secureRemove('k')).not.toThrow()
  })

  it('handles QuotaExceededError gracefully (never throws)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw quota })

    await expect(secureSet('k', { a: 1 })).resolves.toBeUndefined()
  })
})
