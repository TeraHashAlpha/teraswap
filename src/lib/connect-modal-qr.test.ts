// @vitest-environment jsdom
/**
 * [HOTFIX rainbowkit-qr-crash] Connect-modal QR must render without throwing.
 *
 * RainbowKit 2.2.10's connect modal renders the WalletConnect / Ledger QR via
 * `cuer` → `qr.encodeQR(value, 'raw', { border: 0, ... })`, inside a useMemo.
 * `qr@0.6.0` shipped a BREAKING change — `if (!Number.isSafeInteger(border) ||
 * border <= 0) throw new Error('invalid border=' + border)` — so the borderless
 * QR (border: 0) that cuer requests now THROWS "invalid border=0", crashing the
 * modal ("Something went wrong"). cuer@0.0.3's over-permissive `qr: "~0"` range
 * let npm resolve 0.6.0. Fix: pin `qr` to 0.5.5 (accepts border: 0) via override.
 *
 * These guard BOTH the exact modal call path (cuer.create) AND the underlying
 * dependency contract (qr accepts border: 0), so a future qr drift re-breaks CI
 * here instead of in production.
 */
import { describe, it, expect } from 'vitest'
import { create } from 'cuer/QrCode'

// Synthetic, low-entropy placeholders — NOT real WalletConnect secrets. The
// border:0 crash is independent of the URI content (qr validates the border
// param before encoding the data), so these exercise the exact same code path
// as a real pairing URI while keeping the fixture obviously non-secret.
const WC_URI = 'wc:fake-walletconnect-test-topic@2?relay-protocol=irn&symKey=fake-test-symkey-not-a-secret'
const LEDGER_URI = 'wc:fake-ledger-test-topic@2?relay-protocol=irn&symKey=fake-test-symkey-not-a-secret'

describe('connect-modal QR rendering [HOTFIX rainbowkit-qr-crash]', () => {
  it('encodes the WalletConnect QR (borderless) without throwing', () => {
    expect(() => create(WC_URI)).not.toThrow()
  })

  it('encodes the Ledger (WalletConnect) QR without throwing', () => {
    expect(() => create(LEDGER_URI)).not.toThrow()
  })

  it('produces a valid QR grid for the modal to draw', () => {
    const qr = create(WC_URI)
    expect(qr.grid.length).toBeGreaterThan(0)
    expect(qr.edgeLength).toBe(qr.grid.length)
  })
})
