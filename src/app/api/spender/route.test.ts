// @vitest-environment node
/**
 * Unit tests for GET /api/spender.
 *
 * [SPRINT-9G G4 / L06] Adds the server-side chain-activation gate: the route
 * must not hand out an approval spender for an unsupported or not-yet-live
 * chain. Pre-existing behaviour (missing source → 400, valid → spender) is
 * pinned alongside so the gate can't regress it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockFetchApproveSpender = vi.fn()
vi.mock('@/lib/api', () => ({
  fetchApproveSpender: (...a: unknown[]) => mockFetchApproveSpender(...a),
}))

const mockGetChainStatus = vi.fn().mockReturnValue('active')
vi.mock('@/lib/chains/activation', () => ({
  getChainStatus: (id: number) => mockGetChainStatus(id),
}))

import { GET } from './route'

const SPENDER = '0x1111111111111111111111111111111111111111'

function req(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString()
  return new NextRequest(`http://localhost/api/spender?${qs}`)
}

describe('GET /api/spender', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChainStatus.mockReturnValue('active')
    mockFetchApproveSpender.mockResolvedValue(SPENDER)
  })

  it('returns 400 when source is missing', async () => {
    const res = await GET(req({}))
    expect(res.status).toBe(400)
    expect(mockFetchApproveSpender).not.toHaveBeenCalled()
  })

  it('returns the spender for a valid source (mainnet default)', async () => {
    const res = await GET(req({ source: '1inch' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.spender).toBe(SPENDER)
  })

  it('rejects an unsupported chain with 400 (no spender handed out)', async () => {
    mockGetChainStatus.mockReturnValueOnce('unsupported')
    const res = await GET(req({ source: '1inch', chainId: '999999' }))
    expect(res.status).toBe(400)
    expect(mockFetchApproveSpender).not.toHaveBeenCalled()
  })

  it('rejects a coming-soon chain with 409', async () => {
    mockGetChainStatus.mockReturnValueOnce('coming-soon')
    const res = await GET(req({ source: '1inch', chainId: '8453' }))
    expect(res.status).toBe(409)
    expect(mockFetchApproveSpender).not.toHaveBeenCalled()
  })

  it('allows an active chain to proceed', async () => {
    const res = await GET(req({ source: '1inch', chainId: '8453' }))
    expect(res.status).toBe(200)
    expect(mockFetchApproveSpender).toHaveBeenCalled()
  })
})
