/**
 * Unit tests for src/lib/dca-freeze.ts — DCA circuit-breaker freeze state.
 *
 * Supabase is mocked at the '@/lib/supabase' import boundary so getSupabase()
 * returns a controllable stub (never the real client / module cache).
 *
 * Read chain mirrors production:  .from(t).select(...).eq(...).maybeSingle()
 * Write chain:                    .from(t).upsert({ ... })
 *
 * Core contract under test: the reader fails OPEN — no client / no row / a
 * thrown DB error all resolve to { frozen:false }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────
// `mockGetSupabase` is swapped per-test to return either a builder stub or
// null. The builder is a thenable-free chain whose terminal method
// (maybeSingle / upsert) resolves to { data, error }.

const mockGetSupabase = vi.fn()
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}))

import { getDcaFreezeState, setDcaFreezeState } from '@/lib/dca-freeze'

// Capture the last upsert payload so we can assert the exact fields written.
let lastUpsertArg: Record<string, unknown> | null = null

interface BuilderConfig {
  // Resolution for the SELECT…maybeSingle() chain.
  maybeSingleData?: unknown
  maybeSingleError?: { message: string } | null
  // If set, maybeSingle() rejects with this (simulates a thrown DB error).
  maybeSingleThrows?: Error
  // Resolution for the upsert() chain.
  upsertError?: { message: string } | null
}

function makeBuilder(cfg: BuilderConfig) {
  const builder: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(() => {
      if (cfg.maybeSingleThrows) return Promise.reject(cfg.maybeSingleThrows)
      return Promise.resolve({
        data: cfg.maybeSingleData ?? null,
        error: cfg.maybeSingleError ?? null,
      })
    }),
    upsert: vi.fn((arg: Record<string, unknown>) => {
      lastUpsertArg = arg
      return Promise.resolve({ data: null, error: cfg.upsertError ?? null })
    }),
  }
  return builder
}

beforeEach(() => {
  mockGetSupabase.mockReset()
  lastUpsertArg = null
})

// ── getDcaFreezeState ─────────────────────────────────────
describe('getDcaFreezeState', () => {
  it('returns frozen:true with reason when the row is frozen', async () => {
    mockGetSupabase.mockReturnValue(
      makeBuilder({
        maybeSingleData: {
          frozen: true,
          reason: 'unexplained outflow',
          updated_at: '2026-06-17T00:00:00.000Z',
          updated_by: 'admin-0x9A38',
        },
      }),
    )

    const state = await getDcaFreezeState()

    expect(state).toEqual({
      frozen: true,
      reason: 'unexplained outflow',
      updatedAt: '2026-06-17T00:00:00.000Z',
      updatedBy: 'admin-0x9A38',
    })
  })

  it('queries id=dca with maybeSingle on the circuit_breaker table', async () => {
    const builder = makeBuilder({ maybeSingleData: { frozen: false } })
    mockGetSupabase.mockReturnValue(builder)

    await getDcaFreezeState()

    expect(builder.from).toHaveBeenCalledWith('circuit_breaker')
    expect(builder.eq).toHaveBeenCalledWith('id', 'dca')
    expect(builder.maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('returns frozen:false when there is no row (maybeSingle → null)', async () => {
    mockGetSupabase.mockReturnValue(makeBuilder({ maybeSingleData: null }))

    const state = await getDcaFreezeState()

    expect(state).toEqual({
      frozen: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
    })
  })

  it('fails open (frozen:false) when getSupabase() is null (unconfigured)', async () => {
    mockGetSupabase.mockReturnValue(null)

    const state = await getDcaFreezeState()

    expect(state).toEqual({
      frozen: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
    })
  })

  it('fails open (frozen:false) when the query returns an error (table missing)', async () => {
    mockGetSupabase.mockReturnValue(
      makeBuilder({
        maybeSingleError: { message: 'relation "circuit_breaker" does not exist' },
      }),
    )

    const state = await getDcaFreezeState()

    expect(state.frozen).toBe(false)
    expect(state).toEqual({
      frozen: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
    })
  })

  it('fails open (frozen:false) when the DB read throws', async () => {
    mockGetSupabase.mockReturnValue(
      makeBuilder({ maybeSingleThrows: new Error('network down') }),
    )

    const state = await getDcaFreezeState()

    expect(state).toEqual({
      frozen: false,
      reason: null,
      updatedAt: null,
      updatedBy: null,
    })
  })

  it('coerces a non-true frozen value to false (fail-open on truthy junk)', async () => {
    mockGetSupabase.mockReturnValue(
      makeBuilder({ maybeSingleData: { frozen: null, reason: 'x' } }),
    )

    const state = await getDcaFreezeState()

    expect(state.frozen).toBe(false)
    expect(state.reason).toBe('x')
  })
})

// ── setDcaFreezeState ─────────────────────────────────────
describe('setDcaFreezeState', () => {
  it('upserts id=dca with the right fields and returns the new state', async () => {
    mockGetSupabase.mockReturnValue(makeBuilder({}))

    const before = Date.now()
    const state = await setDcaFreezeState(true, 'manual freeze', 'admin-0x9A38')
    const after = Date.now()

    // Returned state echoes the requested values.
    expect(state.frozen).toBe(true)
    expect(state.reason).toBe('manual freeze')
    expect(state.updatedBy).toBe('admin-0x9A38')
    expect(state.updatedAt).toBeTypeOf('string')

    // updatedAt is a fresh ISO timestamp.
    const ts = new Date(state.updatedAt as string).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)

    // The upsert payload uses the snake_case columns + fixed id.
    expect(lastUpsertArg).not.toBeNull()
    expect(lastUpsertArg).toMatchObject({
      id: 'dca',
      frozen: true,
      reason: 'manual freeze',
      updated_by: 'admin-0x9A38',
    })
    expect(lastUpsertArg).toHaveProperty('updated_at', state.updatedAt)
  })

  it('upserts to the circuit_breaker table', async () => {
    const builder = makeBuilder({})
    mockGetSupabase.mockReturnValue(builder)

    await setDcaFreezeState(false, 'unfreeze', 'admin')

    expect(builder.from).toHaveBeenCalledWith('circuit_breaker')
    expect(builder.upsert).toHaveBeenCalledTimes(1)
  })

  it('can persist an unfreeze (frozen:false)', async () => {
    mockGetSupabase.mockReturnValue(makeBuilder({}))

    const state = await setDcaFreezeState(false, 'all clear', 'admin-0x9A38')

    expect(state.frozen).toBe(false)
    expect(lastUpsertArg).toMatchObject({ id: 'dca', frozen: false })
  })

  it('throws when the upsert fails', async () => {
    mockGetSupabase.mockReturnValue(
      makeBuilder({ upsertError: { message: 'permission denied' } }),
    )

    await expect(
      setDcaFreezeState(true, 'oops', 'admin'),
    ).rejects.toThrow(/permission denied/)
  })

  it('returns the requested state without throwing when Supabase is unconfigured', async () => {
    mockGetSupabase.mockReturnValue(null)

    const state = await setDcaFreezeState(true, 'no backend', 'admin')

    expect(state).toEqual({
      frozen: true,
      reason: 'no backend',
      updatedAt: state.updatedAt,
      updatedBy: 'admin',
    })
    expect(state.updatedAt).toBeTypeOf('string')
  })
})
