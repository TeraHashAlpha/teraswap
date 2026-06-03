/**
 * [SPRINT-9J J2] /api/swap returns `{ error: message }` on failure. An upstream
 * adapter error could embed a request URL with an API key or an Authorization
 * header — those must never reach the client. sanitizeUpstreamError redacts
 * secrets while preserving the human-readable failure reason.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeUpstreamError } from './sanitize-error'

describe('sanitizeUpstreamError [SPRINT-9J J2]', () => {
  it('redacts an apiKey query param embedded in a URL', () => {
    const out = sanitizeUpstreamError('build failed: https://api.paraswap.io/transactions/8453?apiKey=SECRET_abc123&side=SELL')
    expect(out).not.toContain('SECRET_abc123')
  })

  it('redacts a Bearer token', () => {
    const out = sanitizeUpstreamError('Authorization: Bearer sk_live_DEADBEEF00 failed')
    expect(out).not.toContain('sk_live_DEADBEEF00')
  })

  it('redacts key/secret/token assignments', () => {
    for (const m of ['api_key=TOPSECRET', 'token: abcd1234efgh', 'secret=hunter2hunter2']) {
      const out = sanitizeUpstreamError(m)
      expect(out.toLowerCase()).not.toMatch(/topsecret|abcd1234efgh|hunter2hunter2/)
    }
  })

  it('[review F4] redacts a secret in a URL PATH segment, not just the query', () => {
    expect(sanitizeUpstreamError('build failed: https://api.foo.com/v1/sk_live_SECRET123ABC/quote'))
      .not.toContain('sk_live_SECRET123ABC')
    expect(sanitizeUpstreamError('GET https://api.0x.org/AbCdEf1234567890AbCdEf1234567890/swap 500'))
      .not.toContain('AbCdEf1234567890AbCdEf1234567890')
  })

  it('preserves a clean human-readable message unchanged', () => {
    expect(sanitizeUpstreamError('1inch API timeout')).toBe('1inch API timeout')
    expect(sanitizeUpstreamError('No route found for this pair')).toBe('No route found for this pair')
  })

  it('handles non-string input safely', () => {
    expect(typeof sanitizeUpstreamError(undefined as unknown as string)).toBe('string')
  })
})
