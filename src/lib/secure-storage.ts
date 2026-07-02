/**
 * [P199] SecureStorage — AES-256-GCM encryption-at-rest for sensitive
 * localStorage data (orders, limit/conditional orders, analytics).
 *
 * Sensitive client-side data was previously stored as plaintext JSON (or, for
 * the order engine, weak XOR obfuscation). Any browser extension, XSS payload
 * or shared-computer user could read trading patterns, order strategies and
 * wallet activity. This module encrypts those values with AES-GCM using a key
 * derived from the connected wallet address via PBKDF2.
 *
 * Design notes:
 *   - The wallet address is the key material — no extra password prompt. Each
 *     wallet derives a distinct key, so data written by wallet A is unreadable
 *     by wallet B (returns null → fresh load from Supabase). That is correct:
 *     orders belong to the wallet that created them.
 *   - The static SALT is acceptable because the wallet address is already
 *     unique per user; PBKDF2 stretches it to resist offline brute force.
 *   - [W9-L-01] When Web Crypto is unavailable (insecure origin, ancient
 *     browser) or the per-wallet key can't be derived, the module FAILS CLOSED:
 *     it SKIPS persistence rather than writing sensitive order/trade metadata as
 *     plaintext (which any extension / XSS / shared-computer user could read).
 *     The data is re-derivable — Supabase is the source of truth for orders — so
 *     a missing local cache is strictly preferable to a plaintext-at-rest leak.
 *     Reads of any legacy plaintext still work (backward compatible). Production
 *     is HTTPS, so this fail-closed path is effectively never hit by real users.
 *   - SSR-safe: no `window`/`crypto` access at module load; every public
 *     method guards `typeof window`.
 *
 * This module never stores private keys or seed phrases — order/trade metadata
 * only.
 */

/** Static salt for PBKDF2. Exported for tests. */
export const SALT = 'TeraSwap_SecureStorage_v1'

/** PBKDF2 iteration count. Exported for tests. */
export const ITERATIONS = 100_000

/** On-disk shape of an encrypted value. */
interface EncryptedPayload {
  /** Format version — for future migration. */
  v: 1
  /** Base64-encoded 12-byte IV (random per write). */
  iv: string
  /** Base64-encoded AES-GCM ciphertext. */
  ct: string
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Lower-cased wallet address used as key material, or null before init. */
let walletKeyMaterial: string | null = null

/**
 * Cached key-derivation promise for the current wallet. Reset to null on
 * (re)init so a new wallet derives a fresh key. Resolves to null when Web
 * Crypto is unavailable.
 */
let keyPromise: Promise<CryptoKey | null> | null = null

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/** True only in a browser-like environment with a usable DOM. */
function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

/** Resolve the platform Crypto object, or undefined if absent. */
function getCrypto(): Crypto | undefined {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto
  return undefined
}

/** True when SubtleCrypto is present (real encryption is possible). */
function cryptoAvailable(): boolean {
  const c = getCrypto()
  return !!(c && c.subtle)
}

const NO_CRYPTO_WARNING = '[SecureStorage] Web Crypto not available'

// ---------------------------------------------------------------------------
// Base64 <-> bytes (manual loop avoids call-stack limits on large arrays and
// works identically in browser + jsdom)
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

async function deriveKey(walletAddress: string): Promise<CryptoKey> {
  const subtle = getCrypto()!.subtle
  const encoder = new TextEncoder()
  const keyMaterial = await subtle.importKey(
    'raw',
    encoder.encode(walletAddress.toLowerCase()),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Return the current wallet's AES-GCM key, deriving (and caching) it on first
 * use. Resolves to null when not initialised or Web Crypto is unavailable —
 * callers treat null as "use the plaintext path".
 */
function getKey(): Promise<CryptoKey | null> {
  if (!walletKeyMaterial || !cryptoAvailable()) return Promise.resolve(null)
  if (!keyPromise) {
    keyPromise = deriveKey(walletKeyMaterial).catch((err) => {
      console.warn('[SecureStorage] key derivation failed', err)
      return null
    })
  }
  return keyPromise
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.v === 1 && typeof candidate.iv === 'string' && typeof candidate.ct === 'string'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise (or re-initialise) SecureStorage with the connected wallet
 * address. The address becomes the key material; calling again with a
 * different address resets the derived key. No-op for falsy addresses.
 */
export function initSecureStorage(walletAddress: string): void {
  if (!walletAddress) return
  const next = walletAddress.toLowerCase()
  if (next === walletKeyMaterial) return
  walletKeyMaterial = next
  keyPromise = null
}

/** True once `initSecureStorage` has been called with a non-empty address. */
export function isSecureStorageReady(): boolean {
  return walletKeyMaterial !== null
}

/**
 * Encrypt `value` (JSON-serialised) and write it to localStorage under `key`.
 * [W9-L-01] Fails CLOSED: when no per-wallet key can be derived (Web Crypto
 * unavailable or not yet initialised) it SKIPS the write rather than persisting
 * sensitive metadata as plaintext. Never throws — quota and serialisation
 * errors are caught and logged.
 */
export async function secureSet<T>(key: string, value: T): Promise<void> {
  if (!hasWindow()) return // SSR no-op
  let json: string
  try {
    json = JSON.stringify(value)
  } catch (err) {
    console.warn('[SecureStorage] failed to serialise value', err)
    return
  }

  try {
    const cryptoKey = await getKey()
    if (!cryptoKey) {
      // [W9-L-01] Fail CLOSED — no key means we cannot encrypt, so we SKIP the
      // write rather than leaking sensitive order/trade metadata as plaintext.
      // The data is re-derivable (Supabase is authoritative for orders), so a
      // missing local cache beats a plaintext-at-rest leak. Never persists here.
      if (!cryptoAvailable()) console.warn(`${NO_CRYPTO_WARNING} — skipping persistence (fail-closed)`)
      return
    }
    const c = getCrypto()!
    const iv = c.getRandomValues(new Uint8Array(12))
    const ciphertext = await c.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(json),
    )
    const payload: EncryptedPayload = {
      v: 1,
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ciphertext)),
    }
    localStorage.setItem(key, JSON.stringify(payload))
  } catch (err) {
    // QuotaExceededError or any encryption failure — log and continue.
    console.warn('[SecureStorage] failed to write key', key, err)
  }
}

/**
 * Read `key` from localStorage and decrypt it. Returns null for a missing key,
 * undecryptable data (wrong wallet / corrupted), or unavailable crypto on an
 * encrypted payload. Plaintext values (written under the fallback path) are
 * returned as-is.
 */
export async function secureGet<T>(key: string): Promise<T | null> {
  if (!hasWindow()) return null // SSR
  const raw = localStorage.getItem(key)
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isEncryptedPayload(parsed)) {
    // Plaintext value (Web Crypto fallback path).
    return parsed as T
  }

  const cryptoKey = await getKey()
  if (!cryptoKey) {
    if (!cryptoAvailable()) console.warn(NO_CRYPTO_WARNING)
    return null
  }

  try {
    const c = getCrypto()!
    const plaintext = await c.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(parsed.iv) },
      cryptoKey,
      fromBase64(parsed.ct),
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch (err) {
    // Wrong wallet, tampered data, or corrupted payload — never throw.
    console.warn('[SecureStorage] decryption failed for key', key, err)
    return null
  }
}

/** Remove `key` from localStorage. SSR-safe; never throws. */
export function secureRemove(key: string): void {
  if (!hasWindow()) return
  try {
    localStorage.removeItem(key)
  } catch (err) {
    console.warn('[SecureStorage] failed to remove key', key, err)
  }
}
