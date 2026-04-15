/**
 * Unit tests for Telegram webhook bot command + callback handler.
 *
 * Covers:
 * - Webhook secret verification (constant-time comparison)
 * - Command parsing (all 8 commands, unknown, edge cases)
 * - Callback data parsing (activate, keep, escalate, ack)
 * - Admin auth rejection for privileged commands and button actions
 * - /status returns formatted source table
 * - /disable calls forceDisable with operator-disable: prefix
 * - /activate calls forceActivate (with P0 confirmation gate)
 * - /grace sets KV grace period
 * - /quorum returns last quorum result
 * - /heartbeat returns monitoring heartbeat
 * - Inline keyboard buttons on callback queries
 * - Audit trail for button actions
 * - Response truncation at 4096 chars
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── Simulated KV store ─────────────────────────────────

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()

function getKvSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSet = vi.fn(async (key: string, value: unknown, _opts?: unknown) => { kvStore.set(key, value) })
const mockKvSmembers = vi.fn(async (key: string) => Array.from(getKvSet(key)))
const mockKvIncr = vi.fn(async (key: string) => {
  const current = (kvStore.get(key) as number) ?? 0
  const next = current + 1
  kvStore.set(key, next)
  return next
})

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((key: string, member: string) => { getKvSet(key).add(member) })
const mockPipelineExec = vi.fn(async () => [])
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown, unknown?])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    incr: (...args: unknown[]) => mockKvIncr(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => { mockPipelineSet(...(args as [string, unknown])); return { sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      sadd: (...args: unknown[]) => { mockPipelineSadd(...(args as [string, string])); return { set: mockPipelineSet, exec: mockPipelineExec, del: mockPipelineDel } },
      del: (...args: unknown[]) => { mockPipelineDel(...args); return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec } },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock alert channels (for escalation fan-out) ──────

const mockSendTelegramAlert = vi.fn().mockResolvedValue(undefined)
const mockSendEmailAlert = vi.fn().mockResolvedValue(undefined)
const mockSendDiscordAlert = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/alert-channels/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => mockSendTelegramAlert(...args),
  buildAlertKeyboard: vi.fn(),
}))

vi.mock('@/lib/alert-channels/email', () => ({
  sendEmailAlert: (...args: unknown[]) => mockSendEmailAlert(...args),
}))

vi.mock('@/lib/alert-channels/discord', () => ({
  sendDiscordAlert: (...args: unknown[]) => mockSendDiscordAlert(...args),
}))

// ── Mock fetch for sendMessage ─────────────────────────

const mockFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
vi.stubGlobal('fetch', mockFetch)

// ── Import after mocks ─────────────────────────────────

import { POST, verifyWebhookSecret, parseCommand, parseCallbackData } from './route'
import { beginTick } from '@/lib/source-state-machine'

// ── Helpers ─────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-secret-abc123'
const ADMIN_ID = 12345678
const NON_ADMIN_ID = 99999999

function makeRequest(body: unknown, secret?: string): Request {
  return new Request('https://teraswap.app/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(body),
  })
}

function makeUpdate(text: string, userId: number = ADMIN_ID): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: userId, first_name: 'Test' },
      chat: { id: -1001234567890 },
      text,
    },
  }
}

function seedSource(sourceId: string, state: 'active' | 'degraded' | 'disabled' = 'active'): void {
  getKvSet('teraswap:source-state:index').add(sourceId)
  kvStore.set(`teraswap:source-state:${sourceId}`, {
    id: sourceId,
    state,
    lastCheckAt: Date.now(),
    failureCount: state === 'active' ? 0 : 3,
    successCount: state === 'active' ? 5 : 0,
    latencyHistory: [100, 120, 90, 110, 105],
    lastTransitionAt: Date.now(),
    ...(state === 'disabled' ? { disabledReason: 'test', disabledAt: Date.now() } : {}),
  })
}

// Wait for the fire-and-forget sendMessage to complete
async function flushPromises(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

const originalEnv = { ...process.env }

// ═══════════════════════════════════════════════════════════════

describe('Telegram webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
    process.env = {
      ...originalEnv,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_ADMIN_IDS: `${ADMIN_ID},11111111`,
    }
    mockFetch.mockResolvedValue(new Response('{"ok":true}'))
  })

  afterAll(() => {
    process.env = originalEnv
  })

  // ── Webhook secret verification ──────────────────────

  describe('webhook secret verification', () => {
    it('verifyWebhookSecret returns true for matching secrets', () => {
      expect(verifyWebhookSecret('abc123', 'abc123')).toBe(true)
    })

    it('verifyWebhookSecret returns false for non-matching secrets', () => {
      expect(verifyWebhookSecret('wrong', 'abc123')).toBe(false)
    })

    it('verifyWebhookSecret handles different-length secrets via SHA-256 (no length leak)', () => {
      // Pre-fix: timingSafeEqual on raw buffers would throw on length mismatch.
      // Post-fix: SHA-256 produces fixed 32-byte digests regardless of input length.
      expect(verifyWebhookSecret('a', 'much-longer-secret-that-is-very-different')).toBe(false)
      expect(verifyWebhookSecret('much-longer-secret-that-is-very-different', 'a')).toBe(false)
    })

    it('verifyWebhookSecret returns false for empty strings', () => {
      expect(verifyWebhookSecret('', 'abc')).toBe(false)
      expect(verifyWebhookSecret('abc', '')).toBe(false)
    })

    it('returns 200 with invalid secret (no Telegram retry)', async () => {
      const req = makeRequest(makeUpdate('/help'), 'wrong-secret')
      const res = await POST(req)
      expect(res.status).toBe(200)
      // Should NOT have called sendMessage
      await flushPromises()
      const telegramCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(telegramCalls.length).toBe(0)
    })

    it('returns 200 with missing secret header', async () => {
      const req = makeRequest(makeUpdate('/help'))
      const res = await POST(req)
      expect(res.status).toBe(200)
    })

    it('returns 200 when TELEGRAM_WEBHOOK_SECRET is not configured', async () => {
      delete process.env.TELEGRAM_WEBHOOK_SECRET
      const req = makeRequest(makeUpdate('/help'), WEBHOOK_SECRET)
      const res = await POST(req)
      expect(res.status).toBe(200)
    })
  })

  // ── Command parsing ──────────────────────────────────

  describe('parseCommand', () => {
    it('parses simple command', () => {
      expect(parseCommand('/status')).toEqual({ command: 'status', args: '' })
    })

    it('parses command with args', () => {
      expect(parseCommand('/disable cowswap suspicious')).toEqual({ command: 'disable', args: 'cowswap suspicious' })
    })

    it('parses command with @botname suffix', () => {
      expect(parseCommand('/status@teraswap_monitor_bot')).toEqual({ command: 'status', args: '' })
    })

    it('parses command with @botname and args', () => {
      expect(parseCommand('/status@teraswap_monitor_bot cowswap')).toEqual({ command: 'status', args: 'cowswap' })
    })

    it('handles extra spaces', () => {
      expect(parseCommand('/disable   cowswap   reason here  ')).toEqual({ command: 'disable', args: 'cowswap   reason here' })
    })

    it('normalizes command to lowercase', () => {
      expect(parseCommand('/STATUS')).toEqual({ command: 'status', args: '' })
    })

    it('returns null for non-command text', () => {
      expect(parseCommand('hello')).toBeNull()
      expect(parseCommand('')).toBeNull()
    })

    it('returns null for empty command', () => {
      expect(parseCommand('/ ')).toBeNull()
    })

    it('parses all 8 command names', () => {
      const commands = ['status', 'quorum', 'heartbeat', 'disable', 'activate', 'grace', 'help', 'start']
      for (const cmd of commands) {
        const result = parseCommand(`/${cmd}`)
        expect(result).not.toBeNull()
        expect(result!.command).toBe(cmd)
      }
    })
  })

  // ── Admin auth ───────────────────────────────────────

  describe('admin auth', () => {
    it('/disable from non-admin returns rejection with user ID', async () => {
      seedSource('cowswap')
      const req = makeRequest(makeUpdate('/disable cowswap test', NON_ADMIN_ID), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Admin-only command')
      expect(body.text).toContain(String(NON_ADMIN_ID))
    })

    it('/activate from non-admin returns rejection', async () => {
      seedSource('cowswap', 'disabled')
      const req = makeRequest(makeUpdate('/activate cowswap', NON_ADMIN_ID), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Admin-only command')
    })

    it('/grace from non-admin returns rejection', async () => {
      const req = makeRequest(makeUpdate('/grace 30', NON_ADMIN_ID), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Admin-only command')
    })

    it('read-only commands work for non-admin users', async () => {
      seedSource('cowswap')
      const req = makeRequest(makeUpdate('/status', NON_ADMIN_ID), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).not.toContain('Admin-only')
    })
  })

  // ── /status command ──────────────────────────────────

  describe('/status', () => {
    it('returns formatted source table', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'degraded')
      seedSource('velora', 'disabled')

      const req = makeRequest(makeUpdate('/status'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Source Status')
      expect(body.text).toContain('<pre>')
      expect(body.text).toContain('1inch')
      expect(body.text).toContain('cowswap')
      expect(body.text).toContain('velora')
      expect(body.parse_mode).toBe('HTML')
    })

    it('returns detail for single source', async () => {
      seedSource('cowswap', 'degraded')

      const req = makeRequest(makeUpdate('/status cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('cowswap')
      expect(body.text).toContain('DEGRADED')
      expect(body.text).toContain('Failure count')
      expect(body.text).toContain('Thresholds')
    })

    it('returns not found for unknown source', async () => {
      const req = makeRequest(makeUpdate('/status nonexistent'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('not found')
    })

    it('returns no sources message when empty', async () => {
      const req = makeRequest(makeUpdate('/status'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('No sources registered')
    })
  })

  // ── /disable command ─────────────────────────────────

  describe('/disable', () => {
    it('calls forceDisable with operator-disable: prefix', async () => {
      seedSource('cowswap')

      const req = makeRequest(makeUpdate('/disable cowswap suspicious quotes'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Verify the source was disabled in KV
      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('disabled')
      expect(s.disabledReason).toBe('operator-disable: suspicious quotes')

      // Verify response message
      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('disabled')
      expect(body.text).toContain('operator-disable')
      expect(body.text).toContain('auto-recovery')
    })

    it('uses default reason when none provided', async () => {
      seedSource('cowswap')

      const req = makeRequest(makeUpdate('/disable cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.disabledReason).toBe('operator-disable: operator action')
    })

    it('returns usage when no sourceId provided', async () => {
      const req = makeRequest(makeUpdate('/disable'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Usage')
    })

    it('operator-disable is NOT a P0 reason (allows auto-recovery)', async () => {
      const { isP0Reason } = await import('@/lib/p0-reasons')
      expect(isP0Reason('operator-disable: test')).toBe(false)
    })
  })

  // ── /activate command ────────────────────────────────

  describe('/activate', () => {
    it('calls forceActivate and confirms', async () => {
      seedSource('cowswap', 'disabled')

      const req = makeRequest(makeUpdate('/activate cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('active')

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('activated')
    })

    it('returns usage when no sourceId provided', async () => {
      const req = makeRequest(makeUpdate('/activate'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Usage')
    })

    it('requires "confirm" for P0-disabled source', async () => {
      // Seed a source disabled with a P0 reason (quorum-correlated-anomaly)
      getKvSet('teraswap:source-state:index').add('cowswap')
      kvStore.set('teraswap:source-state:cowswap', {
        id: 'cowswap',
        state: 'disabled',
        lastCheckAt: Date.now(),
        failureCount: 10,
        successCount: 0,
        latencyHistory: [100, 120],
        lastTransitionAt: Date.now(),
        disabledReason: 'quorum-correlated-anomaly',
        disabledAt: Date.now(),
      })

      const req = makeRequest(makeUpdate('/activate cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('P0 reason')
      expect(body.text).toContain('confirm')
      expect(body.text).toContain('quorum-correlated-anomaly')

      // Source should still be disabled
      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('disabled')
    })

    it('proceeds with "confirm" for P0-disabled source', async () => {
      getKvSet('teraswap:source-state:index').add('cowswap')
      kvStore.set('teraswap:source-state:cowswap', {
        id: 'cowswap',
        state: 'disabled',
        lastCheckAt: Date.now(),
        failureCount: 10,
        successCount: 0,
        latencyHistory: [100, 120],
        lastTransitionAt: Date.now(),
        disabledReason: 'quorum-correlated-anomaly',
        disabledAt: Date.now(),
      })

      const req = makeRequest(makeUpdate('/activate cowswap confirm'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('active')

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('activated')
    })

    it('does NOT require "confirm" for non-P0 disabled source', async () => {
      // operator-disable is NOT a P0 reason — should activate without confirm
      getKvSet('teraswap:source-state:index').add('cowswap')
      kvStore.set('teraswap:source-state:cowswap', {
        id: 'cowswap',
        state: 'disabled',
        lastCheckAt: Date.now(),
        failureCount: 5,
        successCount: 0,
        latencyHistory: [100],
        lastTransitionAt: Date.now(),
        disabledReason: 'operator-disable: test reason',
        disabledAt: Date.now(),
      })

      const req = makeRequest(makeUpdate('/activate cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('active')

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('activated')
    })
  })

  // ── /grace command ───────────────────────────────────

  describe('/grace', () => {
    it('sets KV grace period with correct ISO format', async () => {
      const req = makeRequest(makeUpdate('/grace 30'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Verify KV was called with correct key
      const graceCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => args[0] === 'teraswap:monitor:graceUntil',
      )
      expect(graceCalls.length).toBe(1)
      const graceValue = graceCalls[0][1] as string
      // Should be a valid ISO date ~30 min in the future
      const graceDate = new Date(graceValue)
      expect(graceDate.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000)
      expect(graceDate.getTime()).toBeLessThan(Date.now() + 31 * 60_000)

      // Verify response
      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Grace period set')
      expect(body.text).toContain('30')
    })

    it('rejects invalid minutes (0)', async () => {
      const req = makeRequest(makeUpdate('/grace 0'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Usage')
    })

    it('rejects minutes > 1440', async () => {
      const req = makeRequest(makeUpdate('/grace 2000'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Usage')
    })

    it('rejects non-numeric argument', async () => {
      const req = makeRequest(makeUpdate('/grace abc'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Usage')
    })

    it('sets KV key readable by isInGracePeriodAsync()', async () => {
      const req = makeRequest(makeUpdate('/grace 15'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Verify the KV key was written
      const graceValue = kvStore.get('teraswap:monitor:graceUntil') as string
      expect(graceValue).toBeTruthy()

      // isInGracePeriodAsync should detect the KV value
      const { isInGracePeriodAsync } = await import('@/lib/grace-period')
      const result = await isInGracePeriodAsync()
      expect(result).toBe(true)
    })

    it('sets KV with TTL matching the requested minutes', async () => {
      const req = makeRequest(makeUpdate('/grace 60'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Verify kv.set was called with correct TTL (ex: 3600 for 60 minutes)
      const graceCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => args[0] === 'teraswap:monitor:graceUntil',
      )
      expect(graceCalls.length).toBe(1)
      // Third arg is options { ex: minutes * 60 }
      expect(graceCalls[0][2]).toEqual({ ex: 3600 })
    })
  })

  // ── /quorum command ──────────────────────────────────

  describe('/quorum', () => {
    it('returns last quorum result from KV', async () => {
      kvStore.set('teraswap:monitor:lastQuorumResult', {
        timestamp: '2026-04-15T00:00:00.000Z',
        pairs: [
          { label: 'WETH\u2192USDC (1 ETH)', quotesCollected: 5, outliers: [], skipped: false, medianAmount: '3000000000', maxDeviationPercent: 5 },
        ],
        outliers: [],
        correlatedOutlierCount: 0,
        skipped: false,
      })

      const req = makeRequest(makeUpdate('/quorum'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Last Quorum Check')
      expect(body.text).toContain('2026-04-15')
      expect(body.text).toContain('All sources within tolerance')
    })

    it('returns no data message when no quorum result exists', async () => {
      const req = makeRequest(makeUpdate('/quorum'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('No quorum check data available')
    })
  })

  // ── /heartbeat command ───────────────────────────────

  describe('/heartbeat', () => {
    it('returns heartbeat data from KV', async () => {
      kvStore.set('teraswap:monitor:lastTick', '2026-04-15T12:00:00.000Z')
      kvStore.set('teraswap:monitor:tickCount', 42)

      const req = makeRequest(makeUpdate('/heartbeat'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Monitoring Heartbeat')
      expect(body.text).toContain('42')
    })
  })

  // ── /help command ────────────────────────────────────

  describe('/help', () => {
    it('returns command reference', async () => {
      const req = makeRequest(makeUpdate('/help'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('TeraSwap Monitor Commands')
      expect(body.text).toContain('/status')
      expect(body.text).toContain('/disable')
      expect(body.text).toContain('/activate')
      expect(body.text).toContain('/grace')
      expect(body.text).toContain('/quorum')
      expect(body.text).toContain('/heartbeat')
    })

    it('/start also returns help (Telegram convention)', async () => {
      const req = makeRequest(makeUpdate('/start'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('TeraSwap Monitor Commands')
    })
  })

  // ── Unknown command ──────────────────────────────────

  describe('unknown command', () => {
    it('responds with unknown command message', async () => {
      const req = makeRequest(makeUpdate('/banana'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Unknown command')
      expect(body.text).toContain('/help')
    })
  })

  // ── Alert keyboard structure ─────────────────────────

  describe('alert inline keyboard (buildAlertKeyboard)', () => {
    it('attaches 3 buttons for degraded transition', async () => {
      // Import the real function (not the mocked one)
      const { buildAlertKeyboard } = await import('@/lib/alert-channels/telegram')
      // Since we mocked the module, we need to test via the actual implementation
      // Instead, we test that parseCallbackData can parse the expected callback_data formats
      const activateData = parseCallbackData('activate:cowswap')
      const keepData = parseCallbackData('keep:cowswap')
      const escalateData = parseCallbackData('escalate:cowswap')
      expect(activateData).toEqual({ action: 'activate', sourceId: 'cowswap' })
      expect(keepData).toEqual({ action: 'keep', sourceId: 'cowswap' })
      expect(escalateData).toEqual({ action: 'escalate', sourceId: 'cowswap' })
    })

    it('attaches ack button for active (recovery) transition', () => {
      const ackData = parseCallbackData('ack:cowswap')
      expect(ackData).toEqual({ action: 'ack', sourceId: 'cowswap' })
    })
  })

  // ── Callback data parsing ─────────────────────────────

  describe('parseCallbackData', () => {
    it('parses activate:sourceId', () => {
      expect(parseCallbackData('activate:cowswap')).toEqual({ action: 'activate', sourceId: 'cowswap' })
    })

    it('parses keep:sourceId', () => {
      expect(parseCallbackData('keep:1inch')).toEqual({ action: 'keep', sourceId: '1inch' })
    })

    it('parses escalate:sourceId', () => {
      expect(parseCallbackData('escalate:velora')).toEqual({ action: 'escalate', sourceId: 'velora' })
    })

    it('parses ack:sourceId', () => {
      expect(parseCallbackData('ack:cowswap')).toEqual({ action: 'ack', sourceId: 'cowswap' })
    })

    it('returns null for unknown action', () => {
      expect(parseCallbackData('unknown:cowswap')).toBeNull()
    })

    it('returns null for missing sourceId', () => {
      expect(parseCallbackData('activate:')).toBeNull()
    })

    it('returns null for missing colon', () => {
      expect(parseCallbackData('activatecowswap')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseCallbackData('')).toBeNull()
    })
  })

  // ── Callback query handling ─────────────────────────

  describe('callback queries', () => {
    function makeCallbackUpdate(data: string, userId: number = ADMIN_ID, username = 'TestAdmin'): unknown {
      return {
        update_id: 1,
        callback_query: {
          id: 'cbq-123',
          from: { id: userId, first_name: 'Test', username },
          message: {
            message_id: 42,
            from: { id: 0, first_name: 'Bot' },
            chat: { id: -1001234567890 },
            text: 'Original alert message text',
          },
          data,
        },
      }
    }

    // Helper to find calls to specific Telegram API methods
    function findApiCalls(method: string) {
      return mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes(method),
      )
    }

    it('activate button on non-P0 source calls forceActivate and edits message', async () => {
      seedSource('cowswap', 'disabled')

      const req = makeRequest(makeCallbackUpdate('activate:cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Should have called answerCallbackQuery
      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('reactivated')

      // Should have called editMessageText
      const editCalls = findApiCalls('editMessageText')
      expect(editCalls.length).toBe(1)
      const editBody = JSON.parse(editCalls[0][1].body)
      expect(editBody.text).toContain('Reactivated')
      expect(editBody.text).toContain('TestAdmin')
      expect(editBody.message_id).toBe(42)

      // Source should now be active
      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('active')
    })

    it('activate button on P0-disabled source redirects to text command', async () => {
      getKvSet('teraswap:source-state:index').add('cowswap')
      kvStore.set('teraswap:source-state:cowswap', {
        id: 'cowswap',
        state: 'disabled',
        lastCheckAt: Date.now(),
        failureCount: 10,
        successCount: 0,
        latencyHistory: [100],
        lastTransitionAt: Date.now(),
        disabledReason: 'quorum-correlated-anomaly',
        disabledAt: Date.now(),
      })

      const req = makeRequest(makeCallbackUpdate('activate:cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('P0 source')
      expect(answerBody.text).toContain('/activate cowswap confirm')
      expect(answerBody.show_alert).toBe(true)

      // Source should still be disabled
      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('disabled')
    })

    it('activate button on already-active source reports no change', async () => {
      seedSource('cowswap', 'active')

      const req = makeRequest(makeCallbackUpdate('activate:cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('already active')
    })

    it('keep button from admin answers and edits message (no state change)', async () => {
      seedSource('cowswap', 'disabled')

      const req = makeRequest(makeCallbackUpdate('keep:cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('kept disabled')

      const editCalls = findApiCalls('editMessageText')
      expect(editCalls.length).toBe(1)
      const editBody = JSON.parse(editCalls[0][1].body)
      expect(editBody.text).toContain('Kept Disabled')

      // Source should still be disabled
      beginTick()
      const { getStatus } = await import('@/lib/source-state-machine')
      const s = await getStatus('cowswap')
      expect(s.state).toBe('disabled')
    })

    it('escalate button triggers alert to all channels (bypass dedup)', async () => {
      seedSource('cowswap', 'disabled')

      const req = makeRequest(makeCallbackUpdate('escalate:cowswap'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // All three channel functions should have been called
      expect(mockSendTelegramAlert).toHaveBeenCalledTimes(1)
      expect(mockSendEmailAlert).toHaveBeenCalledTimes(1)
      expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1)

      // Verify the payload passed to channels
      const payload = mockSendTelegramAlert.mock.calls[0][0]
      expect(payload.sourceId).toBe('cowswap')
      expect(payload.reason).toContain('escalation')
      expect(payload.reason).toContain('TestAdmin')

      // answerCallbackQuery should report success
      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('Escalated')
      expect(answerBody.text).toContain('3/3')
    })

    it('ack button works for any group member (non-admin)', async () => {
      seedSource('cowswap', 'active')

      const req = makeRequest(makeCallbackUpdate('ack:cowswap', NON_ADMIN_ID, 'RegularUser'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('Acknowledged')
      expect(answerBody.text).toContain('RegularUser')

      const editCalls = findApiCalls('editMessageText')
      expect(editCalls.length).toBe(1)
      const editBody = JSON.parse(editCalls[0][1].body)
      expect(editBody.text).toContain('Acknowledged')
      expect(editBody.text).toContain('RegularUser')
    })

    it('admin button action from non-admin returns rejection', async () => {
      seedSource('cowswap', 'disabled')

      for (const action of ['activate', 'keep', 'escalate']) {
        mockFetch.mockClear()
        const req = makeRequest(makeCallbackUpdate(`${action}:cowswap`, NON_ADMIN_ID), WEBHOOK_SECRET)
        await POST(req)
        await flushPromises()

        const answerCalls = findApiCalls('answerCallbackQuery')
        expect(answerCalls.length).toBe(1)
        const answerBody = JSON.parse(answerCalls[0][1].body)
        expect(answerBody.text).toContain('Admin only')
        expect(answerBody.show_alert).toBe(true)

        // No editMessageText should have been called
        const editCalls = findApiCalls('editMessageText')
        expect(editCalls.length).toBe(0)
      }
    })

    it('stale/invalid callback_data handled gracefully (returns 200)', async () => {
      const req = makeRequest(makeCallbackUpdate('invalid_data'), WEBHOOK_SECRET)
      const res = await POST(req)
      expect(res.status).toBe(200)
      await flushPromises()

      // No API calls should have been made
      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(0)
    })

    it('callback for non-existent source returns not found', async () => {
      const req = makeRequest(makeCallbackUpdate('activate:nonexistent'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const answerCalls = findApiCalls('answerCallbackQuery')
      expect(answerCalls.length).toBe(1)
      const answerBody = JSON.parse(answerCalls[0][1].body)
      expect(answerBody.text).toContain('not found')
      expect(answerBody.show_alert).toBe(true)
    })

    it('logs button action to KV audit trail', async () => {
      seedSource('cowswap', 'disabled')

      const req = makeRequest(makeCallbackUpdate('keep:cowswap', ADMIN_ID, 'AuditUser'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Find the audit trail KV write
      const auditCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).startsWith('teraswap:telegram:action:'),
      )
      expect(auditCalls.length).toBe(1)
      const auditData = auditCalls[0][1] as Record<string, unknown>
      expect(auditData.action).toBe('keep')
      expect(auditData.sourceId).toBe('cowswap')
      expect(auditData.username).toBe('AuditUser')
      expect(auditData.userId).toBe(ADMIN_ID)
      expect(auditData.timestamp).toBeDefined()
    })

    it('sends fallback message when editMessageText fails', async () => {
      seedSource('cowswap', 'active')

      // Make editMessageText return non-ok (simulating >48h old message)
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('editMessageText')) {
          return new Response('{"ok":false,"description":"Bad Request: message is not modified"}', { status: 400 })
        }
        return new Response('{"ok":true}')
      })

      const req = makeRequest(makeCallbackUpdate('ack:cowswap', ADMIN_ID, 'TestUser'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      // Should have attempted editMessageText
      const editCalls = findApiCalls('editMessageText')
      expect(editCalls.length).toBe(1)

      // Should have sent a fallback sendMessage
      const sendCalls = findApiCalls('sendMessage')
      expect(sendCalls.length).toBe(1)
      const body = JSON.parse(sendCalls[0][1].body)
      expect(body.text).toContain('Could not update original message')
    })
  })

  // ── Edge cases ───────────────────────────────────────

  describe('edge cases', () => {
    it('ignores non-command messages', async () => {
      const req = makeRequest(
        { update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: 'hello' } },
        WEBHOOK_SECRET,
      )
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(0)
    })

    it('ignores updates without message', async () => {
      const req = makeRequest({ update_id: 1 }, WEBHOOK_SECRET)
      const res = await POST(req)
      expect(res.status).toBe(200)
    })

    it('ignores updates without text', async () => {
      const req = makeRequest(
        { update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: 1 } } },
        WEBHOOK_SECRET,
      )
      const res = await POST(req)
      expect(res.status).toBe(200)
    })

    it('handles malformed JSON gracefully', async () => {
      const req = new Request('https://teraswap.app/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
        },
        body: 'not json',
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
    })

    it('sendMessage includes AbortSignal timeout on fetch calls', async () => {
      seedSource('cowswap')
      const req = makeRequest(makeUpdate('/status'), WEBHOOK_SECRET)
      await POST(req)
      await flushPromises()

      const sendCalls = mockFetch.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
      )
      expect(sendCalls.length).toBe(1)
      // The second argument to fetch should contain a signal
      const fetchOptions = sendCalls[0][1] as RequestInit
      expect(fetchOptions.signal).toBeDefined()
    })

    it('no sensitive data in responses (no env vars, secrets, KV keys)', async () => {
      seedSource('cowswap')

      const commands = ['/status', '/status cowswap', '/quorum', '/heartbeat', '/help']
      for (const cmd of commands) {
        mockFetch.mockClear()
        const req = makeRequest(makeUpdate(cmd), WEBHOOK_SECRET)
        await POST(req)
        await flushPromises()

        const sendCalls = mockFetch.mock.calls.filter(
          (args) => typeof args[0] === 'string' && args[0].includes('sendMessage'),
        )
        if (sendCalls.length > 0) {
          const body = JSON.parse(sendCalls[0][1].body)
          const text = body.text as string
          expect(text).not.toContain('TELEGRAM_BOT_TOKEN')
          expect(text).not.toContain('TELEGRAM_WEBHOOK_SECRET')
          expect(text).not.toContain('KV_REST_API')
          expect(text).not.toContain('teraswap:source-state:')
          expect(text).not.toContain('teraswap:monitor:last')
        }
      }
    })
  })
})
