/**
 * [P114/M-03] Tests for the dual Supabase clients.
 *
 * Pins three behaviours:
 *   1. getSupabaseLogger uses SUPABASE_LOGGER_KEY when present.
 *   2. When SUPABASE_LOGGER_KEY is unset, the logger getter falls
 *      back to the service-role client and warns exactly once.
 *   3. Each getter caches its client (singleton).
 *
 * We mock @supabase/supabase-js so the test doesn't actually open a
 * network connection — we just verify createClient was called with
 * the right key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockCreateClient = vi.fn().mockReturnValue({ __mocked: true })
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

import {
  getSupabase,
  getSupabaseLogger,
  _resetSupabaseClients,
} from './supabase'

describe('supabase client factories [P114/M-03]', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetSupabaseClients()
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    delete process.env.SUPABASE_LOGGER_KEY
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('getSupabase creates a client with the service-role key', () => {
    const client = getSupabase()
    expect(client).not.toBeNull()
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'service-role-key',
      expect.objectContaining({ auth: { persistSession: false } }),
    )
  })

  it('getSupabase returns null when SUPABASE_URL is missing', () => {
    delete process.env.SUPABASE_URL
    _resetSupabaseClients()
    expect(getSupabase()).toBeNull()
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('getSupabaseLogger uses SUPABASE_LOGGER_KEY when set', () => {
    process.env.SUPABASE_LOGGER_KEY = 'logger-only-key'
    _resetSupabaseClients()

    const logger = getSupabaseLogger()
    expect(logger).not.toBeNull()
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'logger-only-key',
      expect.objectContaining({ auth: { persistSession: false } }),
    )
  })

  it('falls back to the service-role client when SUPABASE_LOGGER_KEY is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No SUPABASE_LOGGER_KEY in env.

    const logger = getSupabaseLogger()
    const service = getSupabase()
    expect(logger).toBe(service) // same singleton

    // Warning fired exactly once on the fallback.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SUPABASE_LOGGER_KEY not set'),
    )

    // Subsequent calls don't re-warn — fallback is idempotent.
    getSupabaseLogger()
    getSupabaseLogger()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('caches each client as a singleton', () => {
    process.env.SUPABASE_LOGGER_KEY = 'logger-only-key'
    _resetSupabaseClients()

    const a = getSupabaseLogger()
    const b = getSupabaseLogger()
    expect(a).toBe(b)

    // createClient was called once for the logger; getSupabase wasn't
    // touched in this test path.
    expect(mockCreateClient).toHaveBeenCalledTimes(1)
  })

  it('keeps the two clients independent when both keys are set', () => {
    process.env.SUPABASE_LOGGER_KEY = 'logger-only-key'
    _resetSupabaseClients()

    getSupabase()
    getSupabaseLogger()

    expect(mockCreateClient).toHaveBeenCalledTimes(2)
    expect(mockCreateClient).toHaveBeenNthCalledWith(
      1,
      'https://test.supabase.co',
      'service-role-key',
      expect.anything(),
    )
    expect(mockCreateClient).toHaveBeenNthCalledWith(
      2,
      'https://test.supabase.co',
      'logger-only-key',
      expect.anything(),
    )
  })

  it('getSupabaseLogger returns null when SUPABASE_URL is missing', () => {
    delete process.env.SUPABASE_URL
    _resetSupabaseClients()
    expect(getSupabaseLogger()).toBeNull()
  })
})
