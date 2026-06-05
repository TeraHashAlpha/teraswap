// @vitest-environment node
/**
 * [diag] diagnoseQuoteSources — read-only per-source quote diagnostic.
 *
 * Drives the helper with a fake ADAPTER_REGISTRY so each source's outcome
 * (ok / HTTP error / missing-key / zero-output) is deterministic, and asserts
 * the per-source records, the env-presence booleans, and that NO secret value
 * is ever logged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DEXAdapter } from '@/lib/adapters'

// Fake registry, swapped in per test. The mock factory reads it lazily (after
// vi.resetModules + dynamic import), so each test controls the source set.
let fakeRegistry: DEXAdapter[] = []

vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>()
  // Live getter so each probe reads the CURRENT fakeRegistry (the factory itself
  // is only evaluated once, so a captured value would go stale across tests).
  return { ...actual, get ADAPTER_REGISTRY() { return fakeRegistry } }
})

function okAdapter(name: string, toAmount: string): DEXAdapter {
  return {
    name: name as DEXAdapter['name'],
    fetchQuote: async () => ({ source: name as DEXAdapter['name'], toAmount, estimatedGas: 0, gasUsd: 0, routes: [] }),
    fetchSwapData: async () => null,
  }
}

function throwingAdapter(name: string, message: string): DEXAdapter {
  return {
    name: name as DEXAdapter['name'],
    fetchQuote: async () => { throw new Error(message) },
    fetchSwapData: async () => null,
  }
}

const KEYS = ['ONEINCH_API_KEY', 'ZEROX_API_KEY', 'ODOS_API_KEY', 'NEXT_PUBLIC_BASE_RPC_URL'] as const
const savedEnv: Record<string, string | undefined> = {}

async function loadHelper() {
  vi.resetModules()
  const { diagnoseQuoteSources } = await import('@/lib/api')
  return diagnoseQuoteSources
}

describe('diagnoseQuoteSources [diag]', () => {
  beforeEach(() => {
    for (const k of KEYS) savedEnv[k] = process.env[k]
    for (const k of KEYS) delete process.env[k]
    fakeRegistry = []
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
      else delete process.env[k]
    }
    vi.restoreAllMocks()
  })

  it('reports ok / HTTP-error / missing-key / zero-output per source', async () => {
    fakeRegistry = [
      okAdapter('uniswapv3', '1000'),
      throwingAdapter('1inch', '1inch 401: Unauthorized — invalid API key'),
      throwingAdapter('0x', '0x API key not configured'),
      okAdapter('curve', '0'), // zero output → treated as error (no usable quote)
    ]
    const diagnose = await loadHelper()
    const res = await diagnose('0xaaa', '0xbbb', '1000000', 18, 18, 8453)

    const by = Object.fromEntries(res.sources.map((s) => [s.source, s]))

    expect(by['uniswapv3'].status).toBe('ok')
    expect(by['uniswapv3'].toAmount).toBe('1000')
    expect(typeof by['uniswapv3'].latencyMs).toBe('number')

    expect(by['1inch'].status).toBe('error')
    expect(by['1inch'].error).toContain('401')

    expect(by['0x'].status).toBe('error')
    expect(by['0x'].error).toContain('API key not configured')

    expect(by['curve'].status).toBe('error') // zero output is not a usable quote
  })

  it('threads chainId into the adapter call (so results reflect the requested chain)', async () => {
    const spy = vi.fn(async () => ({ source: 'uniswapv3' as DEXAdapter['name'], toAmount: '5', estimatedGas: 0, gasUsd: 0, routes: [] }))
    fakeRegistry = [{ name: 'uniswapv3' as DEXAdapter['name'], fetchQuote: spy, fetchSwapData: async () => null }]
    const diagnose = await loadHelper()
    await diagnose('0xaaa', '0xbbb', '777', 8, 9, 8453)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ src: '0xaaa', dst: '0xbbb', amount: '777', chainId: 8453 }))
  })

  it('reports env-var presence as booleans (present vs missing)', async () => {
    process.env.ONEINCH_API_KEY = 'present-key'
    // ZEROX_API_KEY / ODOS_API_KEY / NEXT_PUBLIC_BASE_RPC_URL left unset
    fakeRegistry = [okAdapter('uniswapv3', '1')]
    const diagnose = await loadHelper()
    const res = await diagnose('0xaaa', '0xbbb', '1', 18, 18, 8453)

    expect(res.env.ONEINCH_API_KEY).toBe(true)
    expect(res.env.ZEROX_API_KEY).toBe(false)
    expect(res.env.ODOS_API_KEY).toBe(false)
    expect(res.env.NEXT_PUBLIC_BASE_RPC_URL).toBe(false)
    expect(res.env.rpcPrimaryConfigured).toBe(false) // empty Base registry primary
  })

  it('NEVER logs a secret value — only boolean presence', async () => {
    const SECRET = 'sk_live_SUPER_SECRET_ABCDEF'
    process.env.ONEINCH_API_KEY = SECRET
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    fakeRegistry = [okAdapter('uniswapv3', '1')]
    const diagnose = await loadHelper()
    await diagnose('0xaaa', '0xbbb', '1', 18, 18, 8453)

    const allLogged = [...infoSpy.mock.calls, ...logSpy.mock.calls]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n')

    expect(allLogged).not.toContain(SECRET)
    // a one-line presence log IS emitted, naming the var with a boolean
    expect(allLogged).toMatch(/ONEINCH_API_KEY/)
    expect(allLogged).toMatch(/true|false/)
  })

  it('skips a source whose breaker is OPEN — reports it WITHOUT calling the adapter (reflects production skip)', async () => {
    const spy = vi.fn(async () => ({ source: '1inch' as DEXAdapter['name'], toAmount: '9', estimatedGas: 0, gasUsd: 0, routes: [] }))
    fakeRegistry = [{ name: '1inch' as DEXAdapter['name'], fetchQuote: spy, fetchSwapData: async () => null }]
    const diagnose = await loadHelper()
    // Drive the SAME breaker instance the probe will read to OPEN (forceOpen sets
    // lastFailureAt=now, so cooldownRemaining > 0). [SPRINT-9S S3] The probe now reads the
    // CHAIN-SCOPED breaker, so open the 8453 key — opening bare '1inch' would leave the Base
    // probe CLOSED, which itself proves the per-chain isolation.
    const { getCircuitBreaker, circuitKey } = await import('@/lib/adapters/circuit-breaker')
    getCircuitBreaker(circuitKey('1inch', 8453)).forceOpen('test: pre-opened')

    const res = await diagnose('0xaaa', '0xbbb', '1', 18, 18, 8453)
    const rec = res.sources.find((s) => s.source === '1inch')!
    expect(rec.status).toBe('error')
    expect(rec.error).toMatch(/circuit breaker OPEN/i)
    expect(rec.latencyMs).toBe(0)
    expect(spy).not.toHaveBeenCalled() // OPEN → the adapter is never invoked
    // read-only: the breaker is still OPEN, the probe did not transition it
    expect(getCircuitBreaker(circuitKey('1inch', 8453)).getState()).toBe('OPEN')
  })

  it('is READ-ONLY: a failing source does NOT increment the production breaker (no withCircuitBreaker)', async () => {
    fakeRegistry = [throwingAdapter('1inch', '1inch 500: upstream error')]
    const diagnose = await loadHelper()
    const { getCircuitBreaker } = await import('@/lib/adapters/circuit-breaker')

    await diagnose('0xaaa', '0xbbb', '1', 18, 18, 8453)

    // A real quote routed through withCircuitBreaker would call onFailure()
    // (consecutiveFailures++ → eventually OPEN). The diagnostic must not.
    const info = getCircuitBreaker('1inch').getInfo()
    expect(info.consecutiveFailures).toBe(0)
    expect(info.state).toBe('CLOSED')
  })
})
