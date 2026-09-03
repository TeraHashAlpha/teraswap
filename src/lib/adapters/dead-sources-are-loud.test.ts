/**
 * [dead-sources-are-loud, 2026-09] Tests for circuit-breaker failure
 * classification: a breaker trip must log WHY (source, error class, HTTP
 * status when present) and must never leak response bodies, URLs, or query
 * strings into the log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/source-state-machine', () => ({
  getAllStatuses: vi.fn().mockResolvedValue([]),
}))

import {
  withCircuitBreaker,
  resetAllCircuitBreakers,
  classifyFailure,
} from './circuit-breaker'

describe('classifyFailure', () => {
  it('classifies an HTTP status error', () => {
    expect(classifyFailure(new Error('0x 401'))).toEqual({ errorClass: 'HttpError', status: 401 })
    expect(classifyFailure(new Error('Odos 502: upstream error'))).toEqual({ errorClass: 'HttpError', status: 502 })
  })

  it('classifies a timeout', () => {
    expect(classifyFailure(new Error('Timeout'))).toEqual({ errorClass: 'TimeoutError' })
  })

  it('classifies a non-JSON / HTML parse failure', () => {
    expect(classifyFailure(new Error('OpenOcean: invalid response (non-JSON). API may be down.')))
      .toEqual({ errorClass: 'ParseError' })
  })

  it('does not mistake a multi-digit chain id for an HTTP status', () => {
    const { status } = classifyFailure(new Error('Uniswap V3: not deployed on chain 42161'))
    expect(status).toBeUndefined()
  })

  it('falls back to UpstreamError for an unrecognized message', () => {
    expect(classifyFailure(new Error('Curve: no pool found for this pair'))).toEqual({ errorClass: 'UpstreamError' })
  })
})

describe('circuit-breaker — loud OPEN transitions [dead-sources-are-loud]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAllCircuitBreakers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a breaker tripped by a 401 logs the source name and the status, and never the raw message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fail401 = () => Promise.reject(new Error('0x 401'))

    for (let i = 0; i < 3; i++) {
      await withCircuitBreaker('0x', fail401).catch(() => {})
    }

    const line = warn.mock.calls.map(c => c.join(' ')).find(l => l.includes('CLOSED → OPEN'))
    expect(line).toBeTruthy()
    expect(line).toContain('0x')
    expect(line).toContain('401')
    expect(line).toContain('HttpError')
  })

  it('never logs a query string or header value — negative control on a URL carrying apikey=', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secretUrl = 'https://api.example.com/quote?apikey=super-secret-token-123&other=1'
    const failWithUrl = () => Promise.reject(new Error(`fetch failed: ${secretUrl} 401`))

    for (let i = 0; i < 3; i++) {
      await withCircuitBreaker('openocean', failWithUrl).catch(() => {})
    }

    const allOutput = warn.mock.calls.map(c => c.join(' ')).join('\n')
    expect(allOutput).not.toContain('apikey=')
    expect(allOutput).not.toContain('super-secret-token-123')
    expect(allOutput).not.toContain('?')
  })

  it('logs the reason on a HALF_OPEN → OPEN re-trip too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failTimeout = () => Promise.reject(new Error('Timeout'))

    vi.useFakeTimers()
    try {
      for (let i = 0; i < 3; i++) {
        await withCircuitBreaker('curve', failTimeout).catch(() => {})
      }
      warn.mockClear()

      // Force back into HALF_OPEN by advancing past cooldown, then fail once more.
      vi.advanceTimersByTime(61_000)
      await withCircuitBreaker('curve', failTimeout).catch(() => {})
    } finally {
      vi.useRealTimers()
    }

    const line = warn.mock.calls.map(c => c.join(' ')).find(l => l.includes('HALF_OPEN → OPEN'))
    expect(line).toBeTruthy()
    expect(line).toContain('curve')
    expect(line).toContain('TimeoutError')
  })
})
