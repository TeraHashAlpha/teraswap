// @vitest-environment node
/**
 * [diag] GET /api/quote — debug=sources per-source diagnostic branch.
 *
 * Verifies (1) the normal (no-debug) response is unchanged, (2) the debug
 * branch is admin-gated via DEBUG_QUOTE_TOKEN, and (3) when authorised it
 * returns the per-source diagnostics plus a pipeline-timing block. The
 * adapter-level diagnostic logic is covered in src/lib/api.diagnose.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks (hoisted) ──────────────────────────────────────────
const fetchMetaQuoteMock = vi.fn()
const diagnoseQuoteSourcesMock = vi.fn()
vi.mock('@/lib/api', () => ({
  fetchMetaQuote: (...a: unknown[]) => fetchMetaQuoteMock(...a),
  diagnoseQuoteSources: (...a: unknown[]) => diagnoseQuoteSourcesMock(...a),
}))

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, resetAt: 1_000 }),
  QUOTE_RATE_LIMIT: { limit: 120, windowMs: 60_000 },
}))

vi.mock('@/lib/circuit-breaker', () => ({
  isSystemHalted: vi.fn().mockResolvedValue(false),
}))

const DEBUG_TOKEN = 'debug-quote-token-xyz'
// A valid checksummed-looking address so the real isValidAddress passes.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A6e5c4F27eAD9083C756Cc2'

const META_RESULT = {
  best: { source: 'uniswapv3', toAmount: '123', estimatedGas: 0, gasUsd: 0, routes: [] },
  all: [{ source: 'uniswapv3', toAmount: '123', estimatedGas: 0, gasUsd: 0, routes: [] }],
  fetchedAt: 42,
}

const DIAG_RESULT = {
  chainId: 8453,
  sources: [
    { source: 'uniswapv3', status: 'ok', toAmount: '123', latencyMs: 5 },
    { source: '1inch', status: 'error', error: '1inch 401: bad key', latencyMs: 3 },
  ],
  env: {
    ONEINCH_API_KEY: false,
    ZEROX_API_KEY: false,
    ODOS_API_KEY: false,
    NEXT_PUBLIC_BASE_RPC_URL: false,
    rpcPrimaryConfigured: false,
    rpcReachable: null,
  },
}

function url(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `http://localhost/api/quote?${qs}`
}

async function callGET(params: Record<string, string>, headers: Record<string, string> = {}) {
  process.env.DEBUG_QUOTE_TOKEN = DEBUG_TOKEN
  const { GET } = await import('./route')
  const req = new NextRequest(url(params), { headers })
  return GET(req)
}

describe('GET /api/quote — debug=sources', () => {
  let originalToken: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    originalToken = process.env.DEBUG_QUOTE_TOKEN
    fetchMetaQuoteMock.mockResolvedValue(META_RESULT)
    diagnoseQuoteSourcesMock.mockResolvedValue(DIAG_RESULT)
  })

  afterEach(() => {
    if (originalToken !== undefined) process.env.DEBUG_QUOTE_TOKEN = originalToken
    else delete process.env.DEBUG_QUOTE_TOKEN
  })

  it('default request (no debug param) is unchanged — returns the meta-quote, never touches the diagnostic', async () => {
    const res = await callGET({ src: USDC, dst: WETH, amount: '1000000', chainId: '8453' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(META_RESULT)
    expect(fetchMetaQuoteMock).toHaveBeenCalledTimes(1)
    expect(diagnoseQuoteSourcesMock).not.toHaveBeenCalled()
  })

  it('debug=sources WITHOUT auth → 401 and the diagnostic never runs', async () => {
    const res = await callGET({ src: USDC, dst: WETH, amount: '1000000', chainId: '8453', debug: 'sources' })
    expect(res.status).toBe(401)
    expect(diagnoseQuoteSourcesMock).not.toHaveBeenCalled()
  })

  it('debug=sources with the WRONG token → 401', async () => {
    const res = await callGET(
      { src: USDC, dst: WETH, amount: '1000000', chainId: '8453', debug: 'sources' },
      { Authorization: 'Bearer not-the-token' },
    )
    expect(res.status).toBe(401)
    expect(diagnoseQuoteSourcesMock).not.toHaveBeenCalled()
  })

  it('debug=sources with the correct Bearer → per-source diagnostics + pipeline timing', async () => {
    const res = await callGET(
      { src: USDC, dst: WETH, amount: '1000000', chainId: '8453', debug: 'sources' },
      { Authorization: `Bearer ${DEBUG_TOKEN}` },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // diagnostic ran with the requested chainId threaded through (decimals default to 18)
    expect(diagnoseQuoteSourcesMock).toHaveBeenCalledWith(USDC, WETH, '1000000', 18, 18, 8453)
    expect(body.sources).toEqual(DIAG_RESULT.sources)
    expect(body.env).toEqual(DIAG_RESULT.env)
    // pipeline block times the real fetchMetaQuote on the same chain
    expect(body.pipeline.status).toBe('ok')
    expect(typeof body.pipeline.totalMs).toBe('number')
    expect(body.pipeline.bestSource).toBe('uniswapv3')
    expect(fetchMetaQuoteMock).toHaveBeenCalledTimes(1)
  })

  it('debug pipeline reports an error when fetchMetaQuote throws (so a pipeline-level failure is visible)', async () => {
    fetchMetaQuoteMock.mockRejectedValueOnce(new Error('No valid quotes. All sources timed out.'))
    const res = await callGET(
      { src: USDC, dst: WETH, amount: '1000000', chainId: '8453', debug: 'sources' },
      { Authorization: `Bearer ${DEBUG_TOKEN}` },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pipeline.status).toBe('error')
    expect(body.pipeline.error).toContain('No valid quotes')
    // diagnostics still returned alongside the failed pipeline
    expect(body.sources).toEqual(DIAG_RESULT.sources)
  })

  // [SPRINT-9G G4] Quote stays multi-chain-OPEN for supported chains (incl.
  // coming-soon, for browsing) but rejects a genuinely unsupported chain. Uses
  // the REAL getChainStatus (no mock) — chainId 8453 is supported and unaffected.
  it('rejects an unsupported chainId with 400 (and never calls fetchMetaQuote)', async () => {
    const res = await callGET({ src: USDC, dst: WETH, amount: '1000000', chainId: '999999' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('CHAIN_UNSUPPORTED')
    expect(fetchMetaQuoteMock).not.toHaveBeenCalled()
  })
})

describe('[SPRINT-9X X2] quote function ceiling', () => {
  it('exports maxDuration = 60 (parity with /api/swap) so the platform never kills it → HTML 504', async () => {
    const mod = await import('./route')
    expect(mod.maxDuration).toBe(60)
  })
})

// ── [E-2] sequencer-down mapping ─────────────────────────────────────────────

describe('/api/quote — L2 sequencer gate mapping [E-2]', () => {
  it('maps SequencerDownError to a calm 503 JSON with sequencerDown: true', async () => {
    // The harness vi.resetModules()-then-dynamically-imports the route, so the
    // error must come from the SAME (fresh) module registry for instanceof to hold.
    const { SequencerDownError } = await import('@/lib/chains/sequencer-check')
    fetchMetaQuoteMock.mockRejectedValueOnce(new SequencerDownError(8453))
    const res = await callGET({ src: USDC, dst: WETH, amount: '1000000', chainId: '8453' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.sequencerDown).toBe(true)
    expect(body.error).toMatch(/^Base sequencer is down or recovering/i)
    expect(body.error).toMatch(/quotes are paused/i)
    expect(res.headers.get('Retry-After')).toBe('60')
  })
})

// ── [E2-AUDIT] POST handler: chainId coercion + sequencer mapping ────────────

describe('POST /api/quote — chainId coercion + sequencer mapping [E2-AUDIT]', () => {
  async function callPOST(body: Record<string, unknown>) {
    const { POST } = await import('./route')
    const req = new NextRequest('http://localhost/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return POST(req)
  }

  it('coerces a STRING chainId from the JSON body to a number before fetchMetaQuote', async () => {
    fetchMetaQuoteMock.mockResolvedValueOnce(META_RESULT)
    const res = await callPOST({ src: USDC, dst: WETH, amount: '1000000', chainId: '8453' })
    expect(res.status).toBe(200)
    // 7th arg (chainId) must be the NUMBER 8453 — a raw string would defeat the
    // strict mainnet short-circuit in fetchMetaQuote ("1" !== 1) and leak a
    // string chainId into every adapter.
    const args = fetchMetaQuoteMock.mock.calls.at(-1)!
    expect(args[6]).toBe(8453)
  })

  it('maps SequencerDownError to the same calm 503 JSON as GET', async () => {
    const { SequencerDownError } = await import('@/lib/chains/sequencer-check')
    fetchMetaQuoteMock.mockRejectedValueOnce(new SequencerDownError(8453))
    const res = await callPOST({ src: USDC, dst: WETH, amount: '1000000', chainId: 8453 })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.sequencerDown).toBe(true)
    expect(body.error).toMatch(/^Base sequencer is down or recovering/i)
    expect(res.headers.get('Retry-After')).toBe('60')
  })
})
