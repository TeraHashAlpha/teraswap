/**
 * [AUDIT-W6 / W6-L-01] Shared request body-size guard.
 *
 * Extracted from the swap route's content-length cap so EVERY body route can
 * refuse oversized payloads app-side (413 JSON) instead of relying on the
 * platform default (~4 MB).
 */
import { describe, it, expect } from 'vitest'
import { bodySizeGuard, DEFAULT_MAX_BODY_BYTES, RPC_MAX_BODY_BYTES } from './body-limit'

function reqWithLength(len: string | null): Request {
  const headers: Record<string, string> = {}
  if (len !== null) headers['content-length'] = len
  return new Request('http://localhost/api/anything', { method: 'POST', headers })
}

describe('bodySizeGuard', () => {
  it('passes a body under the default cap', () => {
    expect(bodySizeGuard(reqWithLength('5000'))).toBeNull()
  })

  it('refuses a body over the default cap with 413 JSON', async () => {
    const res = bodySizeGuard(reqWithLength(String(DEFAULT_MAX_BODY_BYTES + 1)))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(413)
    const json = await res!.json()
    expect(json.error).toMatch(/too large/i)
  })

  it('honours a per-route override (rpc allows large eth_call payloads)', () => {
    expect(bodySizeGuard(reqWithLength('100000'), RPC_MAX_BODY_BYTES)).toBeNull()
    expect(bodySizeGuard(reqWithLength(String(RPC_MAX_BODY_BYTES + 1)), RPC_MAX_BODY_BYTES)).not.toBeNull()
  })

  it('passes when content-length is absent or non-numeric (parse guards downstream)', () => {
    expect(bodySizeGuard(reqWithLength(null))).toBeNull()
    expect(bodySizeGuard(reqWithLength('abc'))).toBeNull()
  })
})
