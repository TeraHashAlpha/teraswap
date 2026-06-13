// @vitest-environment node
/**
 * [CHORE-POLISH-4 P5] Tamper-evident guard for the `qr` pin.
 *
 * `qr@0.5.5` is pinned via package.json `overrides` because `qr@0.6.0` throws
 * `invalid border=0` at runtime (INC-2026-06-09-001). This is blocked on upstream — NOT a
 * fix item now. JSON has no inline comments, and a sibling comment key inside `overrides`
 * (e.g. `"//qr"`) makes npm re-resolve and desyncs the lockfile (breaks `npm ci` in CI), so
 * this test is the pin's documentation + tamper-evidence: it FAILS the moment anyone (a
 * Dependabot batch, a manual edit) bumps or drops the override, before it can land silently.
 *
 * Remove the pin ONLY when an upstream `qr` release fixes border=0 (the Architect's upstream
 * watcher tracks that, mirroring the rainbowkit-wagmi-v3 watcher — out of scope here).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
  overrides?: Record<string, unknown>
}

describe('qr override pin [CHORE-POLISH-4 P5]', () => {
  it('qr is pinned to exactly 0.5.5 — do NOT bump (qr@0.6.0 `invalid border=0`, INC-2026-06-09-001)', () => {
    expect(pkg.overrides?.qr).toBe('0.5.5')
  })
})
