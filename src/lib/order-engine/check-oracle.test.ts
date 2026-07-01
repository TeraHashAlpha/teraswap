/**
 * [chore/oracle-less-advisory] checkOracleCoverage — client pre-check that asks
 * /api/oracle-coverage whether the target token has an independent price oracle
 * (Chainlink feed OR DefiLlama coverage) on the active chain.
 *
 * FAIL-OPEN policy (mirrors checkRoute): any HTTP error, malformed body, or
 * network failure returns { hasOracle: true } so a transient probe outage NEVER
 * shows a false "no oracle" note. Only a clean 200 with hasOracle:false → note.
 * Informational only — never blocks submission.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkOracleCoverage } from './check-oracle'

// Obvious placeholder address (the value is arbitrary — fetch is mocked; it only
// has to round-trip into the query string). Kept low-entropy + off any secret
// keyword so gitleaks' generic-api-key heuristic doesn't false-positive on it.
const ETHFI_ADDR = '0x1111111111111111111111111111111111111111'

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch))
}
const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('checkOracleCoverage', () => {
  it('200 { hasOracle:false } → oracle-less (note should show)', async () => {
    mockFetch(() => json({ hasOracle: false, hasChainlink: false, defillama: 'none' }))
    expect(await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })).toEqual({ hasOracle: false })
  })

  it('200 { hasOracle:true } → covered (no note)', async () => {
    mockFetch(() => json({ hasOracle: true, hasChainlink: true, defillama: 'unknown' }))
    expect(await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })).toEqual({ hasOracle: true })
  })

  it('HTTP 500 → FAIL OPEN (hasOracle:true, no false note)', async () => {
    mockFetch(() => json({ error: 'boom' }, 500))
    expect(await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })).toEqual({ hasOracle: true })
  })

  it('network throw → FAIL OPEN', async () => {
    mockFetch(() => { throw new Error('network down') })
    expect(await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })).toEqual({ hasOracle: true })
  })

  it('malformed body (no boolean hasOracle) → FAIL OPEN', async () => {
    mockFetch(() => json({ nope: 1 }))
    expect(await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })).toEqual({ hasOracle: true })
  })

  it('sends token + chainId to /api/oracle-coverage', async () => {
    const spy = vi.fn((..._args: unknown[]) => json({ hasOracle: true }))
    vi.stubGlobal('fetch', spy as unknown as typeof fetch)
    await checkOracleCoverage({ token: ETHFI_ADDR, chainId: 8453 })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('/api/oracle-coverage')
    expect(url).toContain(`token=${ETHFI_ADDR}`)
    expect(url).toContain('chainId=8453')
  })
})
