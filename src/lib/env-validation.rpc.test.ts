// @vitest-environment node
/**
 * [fix/mainnet-rpc-out-of-client, SEC-5] env-validation's RPC checks follow the server chain.
 *
 * Mainnet server RPC: RPC_URL_1, then RPC_URL, then the public default (rpc-env.ts). The browser reads every chain
 * through our own /api/rpc, so there is no browser RPC name left to require: the old `required` mainnet browser rule
 * (whose value used to be inlined into a client chunk) is gone, and setting or unsetting that name changes nothing.
 * Marker values only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { validateEnv } from './env-validation'

afterEach(() => {
  vi.unstubAllEnvs()
})

const allLines = () => {
  const { errors, warnings } = validateEnv()
  return [...errors, ...warnings]
}

describe('[SEC-5] env-validation: RPC checks follow RPC_URL_1 → RPC_URL → public default', () => {
  it('an unset NEXT_PUBLIC_RPC_URL is neither an error nor a warning', () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '')
    expect(allLines().filter((l) => l.includes('NEXT_PUBLIC_RPC_URL'))).toEqual([])
  })

  it('setting NEXT_PUBLIC_RPC_URL (or the two FALLBACK names) changes nothing in the result', () => {
    for (const n of ['NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_FALLBACK_RPC_1', 'NEXT_PUBLIC_FALLBACK_RPC_2']) vi.stubEnv(n, '')
    const unset = validateEnv()
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://mainnet-provider.invalid/v2/CAPTURE-MARKER-MAINNET-RPC-KEY')
    vi.stubEnv('NEXT_PUBLIC_FALLBACK_RPC_1', 'https://fallback1-provider.invalid/v2/CAPTURE-MARKER-FALLBACK-RPC-1-KEY')
    vi.stubEnv('NEXT_PUBLIC_FALLBACK_RPC_2', 'https://fallback2-provider.invalid/v2/CAPTURE-MARKER-FALLBACK-RPC-2-KEY')
    expect(validateEnv()).toEqual(unset)
  })

  it('RPC_URL_1 unset: exactly one warning, naming the new chain; never an error', () => {
    vi.stubEnv('RPC_URL_1', '')
    const { errors, warnings } = validateEnv()
    expect(errors.filter((e) => e.includes('RPC_URL_1'))).toEqual([])
    const lines = warnings.filter((w) => w.includes('RPC_URL_1'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('falls back to RPC_URL, then the public default')
    expect(lines[0]).not.toMatch(/NEXT_PUBLIC/)
  })

  it('RPC_URL_1 set: no RPC_URL_1 line at all', () => {
    vi.stubEnv('RPC_URL_1', 'https://server-mainnet.invalid/v2/SERVER-MARKER-KEY')
    expect(allLines().filter((l) => l.includes('RPC_URL_1'))).toEqual([])
  })

  it('no line names a mainnet browser RPC variable, whatever is set', () => {
    vi.stubEnv('RPC_URL_1', '')
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '')
    expect(allLines().filter((l) => /NEXT_PUBLIC_(?:RPC_URL|FALLBACK_RPC)/.test(l))).toEqual([])
  })
})
