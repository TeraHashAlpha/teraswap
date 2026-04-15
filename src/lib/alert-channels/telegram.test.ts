/**
 * Unit tests for Telegram alert channel — inline keyboard builder.
 *
 * Tests that alert messages include the correct inline keyboard
 * structure per ADR-001 § H6.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock KV (telegram.ts imports alert-wrapper which imports kv)
vi.mock('@vercel/kv', () => ({
  kv: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}))

import { buildAlertKeyboard } from './telegram'

describe('buildAlertKeyboard', () => {
  it('returns 3 buttons (Reactivate, Keep Disabled, Escalate) for degraded', () => {
    const kb = buildAlertKeyboard('cowswap', 'degraded')
    expect(kb).toBeDefined()
    expect(kb!.inline_keyboard).toHaveLength(1)
    expect(kb!.inline_keyboard[0]).toHaveLength(3)

    const [reactivate, keep, escalate] = kb!.inline_keyboard[0]
    expect(reactivate.text).toContain('Reactivate')
    expect(reactivate.callback_data).toBe('activate:cowswap')
    expect(keep.text).toContain('Keep Disabled')
    expect(keep.callback_data).toBe('keep:cowswap')
    expect(escalate.text).toContain('Escalate')
    expect(escalate.callback_data).toBe('escalate:cowswap')
  })

  it('returns 3 buttons for disabled', () => {
    const kb = buildAlertKeyboard('1inch', 'disabled')
    expect(kb).toBeDefined()
    expect(kb!.inline_keyboard[0]).toHaveLength(3)
    expect(kb!.inline_keyboard[0][0].callback_data).toBe('activate:1inch')
    expect(kb!.inline_keyboard[0][1].callback_data).toBe('keep:1inch')
    expect(kb!.inline_keyboard[0][2].callback_data).toBe('escalate:1inch')
  })

  it('returns 1 button (Acknowledged) for active (recovery)', () => {
    const kb = buildAlertKeyboard('cowswap', 'active')
    expect(kb).toBeDefined()
    expect(kb!.inline_keyboard).toHaveLength(1)
    expect(kb!.inline_keyboard[0]).toHaveLength(1)

    const [ack] = kb!.inline_keyboard[0]
    expect(ack.text).toContain('Acknowledged')
    expect(ack.callback_data).toBe('ack:cowswap')
  })

  it('returns undefined for unknown transition state', () => {
    const kb = buildAlertKeyboard('cowswap', 'unknown')
    expect(kb).toBeUndefined()
  })

  it('callback_data fits within 64 bytes', () => {
    // Max sourceId in our system is ~15 chars. Verify the format fits.
    const longSourceId = 'a'.repeat(50) // extreme case
    const kb = buildAlertKeyboard(longSourceId, 'disabled')
    expect(kb).toBeDefined()
    for (const btn of kb!.inline_keyboard[0]) {
      const bytes = new TextEncoder().encode(btn.callback_data).length
      expect(bytes).toBeLessThanOrEqual(64)
    }
  })
})
