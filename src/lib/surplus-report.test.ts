/**
 * Unit tests for src/lib/surplus-report.ts — Sprint 16B / P119.
 *
 * We mock Supabase and KV at the import boundary. The fetch to Telegram is
 * stubbed via globalThis.fetch so we never hit the real Bot API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────
// The query chain is .from('swaps').select(...).eq(...).gt(...) and is
// awaited; we shape the final builder to be a thenable that resolves to
// { data, error }.

type Row = { source: string; mev_savings_actual: string | number | null }
let mockRows: Row[] = []
let mockError: { message: string } | null = null

function makeBuilder() {
  const builder: any = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gt: vi.fn(() => Promise.resolve({ data: mockRows, error: mockError })),
  }
  return builder
}

let supabaseEnabled = true
vi.mock('./supabase', () => ({
  getSupabase: () => (supabaseEnabled ? makeBuilder() : null),
}))

// ── KV mock ───────────────────────────────────────────────
const mockKvGet = vi.fn()
const mockKvSet = vi.fn()
vi.mock('./kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...args),
    set: (...args: unknown[]) => mockKvSet(...args),
  },
}))

// ── Fetch mock (Telegram) ─────────────────────────────────
const mockFetch = vi.fn()
beforeEach(() => {
  mockRows = []
  mockError = null
  supabaseEnabled = true
  mockKvGet.mockReset().mockResolvedValue(null)
  mockKvSet.mockReset().mockResolvedValue(undefined)
  mockFetch.mockReset()
  globalThis.fetch = mockFetch as unknown as typeof fetch
  process.env.TELEGRAM_BOT_TOKEN = 'TEST-TOKEN'
  process.env.TELEGRAM_CHAT_ID = '-1001234567890'
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
})

// ── Tests ────────────────────────────────────────────────

import {
  generateSurplusReport,
  formatSurplusReportMessage,
  shouldSendWeeklyReport,
  maybeSendWeeklyReport,
  isoWeek,
} from './surplus-report'

describe('generateSurplusReport', () => {
  it('groups rows by source and surfaces names in the formatted message', async () => {
    mockRows = [
      { source: '1inch', mev_savings_actual: '1000' },
      { source: '1inch', mev_savings_actual: '500' },
      { source: '1inch', mev_savings_actual: null },
      { source: 'odos', mev_savings_actual: '2000' },
      { source: 'cowswap', mev_savings_actual: '5000' },
      { source: 'cowswap', mev_savings_actual: '5000' },
    ]

    const report = await generateSurplusReport()
    expect(report.empty).toBe(false)
    expect(report.rows).toHaveLength(3)

    // Highest total surplus first → cowswap (10000), then odos (2000), then 1inch (1500)
    expect(report.rows[0].source).toBe('cowswap')
    expect(report.rows[0].totalSurplusWei).toBe('10000')
    expect(report.rows[0].swaps).toBe(2)
    expect(report.rows[0].withSurplus).toBe(2)

    const oneInch = report.rows.find((r) => r.source === '1inch')
    expect(oneInch).toBeDefined()
    expect(oneInch?.swaps).toBe(3)
    expect(oneInch?.withSurplus).toBe(2) // 1 row is null, doesn't count
    expect(oneInch?.totalSurplusWei).toBe('1500')

    const msg = formatSurplusReportMessage(report)
    expect(msg).toContain('cowswap')
    expect(msg).toContain('odos')
    expect(msg).toContain('1inch')
    expect(msg).toContain('Weekly Surplus Report')
    expect(msg).toContain('Projected monthly')
  })

  it('returns empty=true and a "no data" fallback message when Supabase returns 0 rows', async () => {
    mockRows = []
    const report = await generateSurplusReport()
    expect(report.empty).toBe(true)
    expect(report.rows).toHaveLength(0)

    const msg = formatSurplusReportMessage(report)
    expect(msg).toContain('No surplus data this week')
    expect(msg).toContain('Weekly Surplus Report')
  })
})

describe('shouldSendWeeklyReport (cron gating)', () => {
  it('returns true on Sunday 00:xx UTC when KV has no prior week', async () => {
    const sunday = new Date('2026-05-17T00:30:00Z') // Sunday
    mockKvGet.mockResolvedValueOnce(null)
    expect(await shouldSendWeeklyReport(sunday)).toBe(true)
  })

  it('returns false on Monday', async () => {
    const monday = new Date('2026-05-18T00:30:00Z')
    expect(await shouldSendWeeklyReport(monday)).toBe(false)
  })

  it('returns false on Sunday after the trigger hour', async () => {
    const sundayAfter = new Date('2026-05-17T01:30:00Z')
    expect(await shouldSendWeeklyReport(sundayAfter)).toBe(false)
  })

  it('returns false when KV already records the current ISO week (dedup)', async () => {
    const sunday = new Date('2026-05-17T00:30:00Z')
    mockKvGet.mockResolvedValueOnce(isoWeek(sunday))
    expect(await shouldSendWeeklyReport(sunday)).toBe(false)
  })
})

describe('maybeSendWeeklyReport (end-to-end)', () => {
  it('sends to Telegram and writes the dedup flag on success', async () => {
    mockRows = [{ source: '1inch', mev_savings_actual: '42' }]
    const sunday = new Date('2026-05-17T00:30:00Z')
    const ok = await maybeSendWeeklyReport(sunday)
    expect(ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockKvSet).toHaveBeenCalledWith(
      'teraswap:surplus-report:last-sent',
      isoWeek(sunday),
      { ex: 30 * 24 * 60 * 60 },
    )
  })

  it('still sends the fallback "no data" message and dedups when there are 0 rows', async () => {
    mockRows = []
    const sunday = new Date('2026-05-17T00:30:00Z')
    const ok = await maybeSendWeeklyReport(sunday)
    expect(ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.text).toContain('No surplus data this week')
  })
})
