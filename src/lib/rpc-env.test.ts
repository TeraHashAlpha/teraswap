// @vitest-environment node
/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] Resolution order, source naming and the one-line-per-chain log.
 * Env NAMES only: the values below are throwaway placeholders, and the log assertions check that
 * no value ever reaches a log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  serverRpcUrl,
  serverRpcEnvUrl,
  browserRpcUrl,
  browserRpcEnvUrl,
  rpcEnvSource,
  _resetRpcSourceLog,
  RPC_SOURCE_DEFAULT,
} from './rpc-env'

const NAMES = [
  'RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL',
  'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_ARBITRUM_RPC_URL',
] as const

const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n] }
  _resetRpcSourceLog()
})
afterEach(() => {
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
  vi.restoreAllMocks()
})

describe('server order', () => {
  it('mainnet: RPC_URL_1 > RPC_URL > NEXT_PUBLIC_RPC_URL > llamarpc', () => {
    expect(serverRpcUrl(1)).toBe('https://eth.llamarpc.com')
    expect(rpcEnvSource(1)).toBe(RPC_SOURCE_DEFAULT)
    process.env.NEXT_PUBLIC_RPC_URL = 'https://pub.test'
    expect([serverRpcUrl(1), rpcEnvSource(1)]).toEqual(['https://pub.test', 'NEXT_PUBLIC_RPC_URL'])
    process.env.RPC_URL = 'https://legacy.test'
    expect([serverRpcUrl(1), rpcEnvSource(1)]).toEqual(['https://legacy.test', 'RPC_URL'])
    process.env.RPC_URL_1 = 'https://srv.test'
    expect([serverRpcUrl(1), rpcEnvSource(1)]).toEqual(['https://srv.test', 'RPC_URL_1'])
  })

  it.each([
    [8453, 'RPC_URL_8453', 'NEXT_PUBLIC_BASE_RPC_URL', 'https://mainnet.base.org'],
    [42161, 'RPC_URL_42161', 'NEXT_PUBLIC_ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc'],
  ])('chain %i: RPC_URL_<id> > NEXT_PUBLIC_* > public default', (id, srv, pub, dflt) => {
    expect([serverRpcUrl(id), rpcEnvSource(id), serverRpcEnvUrl(id)]).toEqual([dflt, RPC_SOURCE_DEFAULT, undefined])
    process.env[pub] = 'https://pub.test'
    expect([serverRpcUrl(id), rpcEnvSource(id)]).toEqual(['https://pub.test', pub])
    process.env[srv] = 'https://srv.test'
    expect([serverRpcUrl(id), rpcEnvSource(id)]).toEqual(['https://srv.test', srv])
  })

  it('legacy RPC_URL (mainnet) NEVER answers for Base or Arbitrum', () => {
    process.env.RPC_URL = 'https://legacy-mainnet.test'
    expect(serverRpcEnvUrl(8453)).toBeUndefined()
    expect(serverRpcEnvUrl(42161)).toBeUndefined()
  })

  it('an empty value counts as unset (same `||` semantics as before)', () => {
    process.env.RPC_URL_1 = ''
    process.env.NEXT_PUBLIC_RPC_URL = 'https://pub.test'
    expect(rpcEnvSource(1)).toBe('NEXT_PUBLIC_RPC_URL')
  })

  it('throws on a chain with no resolver (never a silent mainnet fallback)', () => {
    expect(() => serverRpcUrl(10)).toThrow(/chain 10/)
    expect(() => browserRpcUrl(10)).toThrow(/chain 10/)
  })
})

describe('browser order (unchanged: NEXT_PUBLIC_* > default; RPC_URL_<id> ignored)', () => {
  it('ignores the server names entirely', () => {
    process.env.RPC_URL_1 = 'https://srv.test'
    process.env.RPC_URL = 'https://legacy.test'
    expect(browserRpcUrl(1)).toBe('https://eth.llamarpc.com')
    expect(browserRpcEnvUrl(1)).toBeUndefined()
    process.env.NEXT_PUBLIC_RPC_URL = 'https://pub.test'
    expect(browserRpcUrl(1)).toBe('https://pub.test')
  })
})

describe('rpc: chain=<id> source=<ENV_NAME> log', () => {
  it('logs once per chain per process, name only', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    process.env.RPC_URL_8453 = 'https://secret-key-in-path.test/v2/KEY'
    serverRpcUrl(8453); serverRpcUrl(8453); serverRpcEnvUrl(8453)
    serverRpcUrl(1)
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      'rpc: chain=8453 source=RPC_URL_8453',
      'rpc: chain=1 source=public-default',
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret-key')
  })
})
