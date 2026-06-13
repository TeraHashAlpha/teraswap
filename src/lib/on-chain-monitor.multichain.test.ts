/**
 * [E-4] on-chain-monitor — multi-chain scanning (Base FeeCollector live).
 *
 * Separate file from on-chain-monitor.test.ts ON PURPOSE: that file runs with
 * the REAL registry (Base contracts unset in tests → mainnet-only targets) and
 * is therefore the mainnet byte-identical pin. THIS file mocks a fake Base
 * config (deployed FeeCollector) and pins the multi-chain behavior: Base events
 * scanned + alert-tagged, and per-chain cursor isolation in both directions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FAKE_BASE_FC = '0xBA5EFC0000000000000000000000000000008453' as const
const MAINNET_LAST_BLOCK_KEY = 'teraswap:onchain:last-block'
const BASE_LAST_BLOCK_KEY = 'teraswap:onchain:last-block:8453'

// ── Mocks ────────────────────────────────────────────────

const mockGetLogs = vi.fn()
const mockGetBlockNumber = vi.fn()

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem')
  return {
    ...actual,
    createPublicClient: () => ({
      getLogs: (...args: unknown[]) => mockGetLogs(...args),
      getBlockNumber: () => mockGetBlockNumber(),
    }),
  }
})

// Fake Base config: deployed FeeCollector; everything else mirrors the real
// registry. Mainnet (1) stays the REAL config so the mainnet leg is authentic.
vi.mock('@/lib/chains/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains/registry')>()
  return {
    ...actual,
    getSupportedChainIds: () => [1, 8453],
    getChainConfig: (chainId: number) => {
      if (chainId === 8453) {
        const base = actual.getChainConfig(8453)
        return {
          ...base,
          contracts: { ...base.contracts, feeCollector: FAKE_BASE_FC },
        }
      }
      return actual.getChainConfig(chainId)
    },
  }
})

const kvStore = new Map<string, unknown>()
const mockKvSet = vi.fn(async (k: string, v: unknown) => { kvStore.set(k, v) })
const mockKvGet = vi.fn(async (k: string) => kvStore.get(k) ?? null)
const mockKvIncr = vi.fn().mockResolvedValue(1)
vi.mock('@/lib/kv', () => ({
  kv: {
    set: (...a: unknown[]) => mockKvSet(...(a as [string, unknown])),
    get: (...a: unknown[]) => mockKvGet(...(a as [string])),
    incr: (...a: unknown[]) => mockKvIncr(...a),
  },
}))

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

import { runOnChainScan, _resetLastScannedBlockCache, _internal } from './on-chain-monitor'
import { FEE_COLLECTOR_ADDRESS } from './constants'
import { ORDER_EXECUTOR_ADDRESS } from './order-engine/config'

const { TOPICS } = _internal

function ownershipTransferredLog(address: string) {
  return {
    address,
    topics: [TOPICS.OwnershipTransferred, '0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
    data: '0x',
    transactionHash: '0x' + 'b'.repeat(64),
    blockNumber: 20000000n,
    logIndex: 0,
    blockHash: '0x' + '0'.repeat(64),
    transactionIndex: 0,
    removed: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  kvStore.clear()
  _resetLastScannedBlockCache()
  mockGetBlockNumber.mockResolvedValue(20000000n)
  mockGetLogs.mockResolvedValue([])
  // Both chains have a prior cursor so each scans a fresh small range.
  kvStore.set(MAINNET_LAST_BLOCK_KEY, 19999900)
  kvStore.set(BASE_LAST_BLOCK_KEY, 19999900)
})

describe('on-chain-monitor — multi-chain [E-4]', () => {
  it('scans the Base FeeCollector and tags its alerts with the chain', async () => {
    // A critical event on the BASE FeeCollector only.
    mockGetLogs.mockImplementation(async (args: { address?: string }) =>
      args.address?.toLowerCase() === FAKE_BASE_FC.toLowerCase()
        ? [ownershipTransferredLog(FAKE_BASE_FC)]
        : [],
    )

    const result = await runOnChainScan()
    expect(result).not.toBeNull()

    // Base FeeCollector was actually queried.
    const scannedAddresses = mockGetLogs.mock.calls.map(c => String((c[0] as { address?: string }).address).toLowerCase())
    expect(scannedAddresses).toContain(FAKE_BASE_FC.toLowerCase())
    // Mainnet legs unchanged: executor + FC v2 still queried.
    expect(scannedAddresses).toContain(ORDER_EXECUTOR_ADDRESS.toLowerCase())
    expect(scannedAddresses).toContain(FEE_COLLECTOR_ADDRESS.toLowerCase())

    // The Base critical alert is chain-tagged (mainnet alert keys stay legacy).
    const alertSources = mockEmitTransitionAlert.mock.calls.map(c => c[0])
    expect(alertSources).toContain('onchain-feecollector-8453')
    const baseReason = mockEmitTransitionAlert.mock.calls.find(c => c[0] === 'onchain-feecollector-8453')![3] as string
    expect(baseReason).toContain('chain 8453')

    // The multi-chain result surfaces the Base leg.
    expect(result!.chains?.some(c => c.chainId === 8453 && c.eventsFound === 1 && c.criticalCount === 1)).toBe(true)
  })

  it('per-chain cursors are isolated: a held mainnet advance does not block the Base cursor', async () => {
    // Mainnet emits a critical whose alert FAILS → mainnet cursor held.
    mockGetLogs.mockImplementation(async (args: { address?: string }) =>
      args.address?.toLowerCase() === FEE_COLLECTOR_ADDRESS.toLowerCase()
        ? [ownershipTransferredLog(FEE_COLLECTOR_ADDRESS)]
        : [],
    )
    mockEmitTransitionAlert.mockImplementation(async (source: string) => {
      if (!String(source).endsWith('-8453')) throw new Error('telegram down (mainnet alert)')
    })

    await runOnChainScan()

    // Mainnet cursor HELD at the prior value; Base cursor advanced to head.
    expect(kvStore.get(MAINNET_LAST_BLOCK_KEY)).toBe(19999900)
    expect(kvStore.get(BASE_LAST_BLOCK_KEY)).toBe(20000000)
  })

  it('per-chain cursors are isolated: a held Base advance does not block the mainnet cursor', async () => {
    mockGetLogs.mockImplementation(async (args: { address?: string }) =>
      args.address?.toLowerCase() === FAKE_BASE_FC.toLowerCase()
        ? [ownershipTransferredLog(FAKE_BASE_FC)]
        : [],
    )
    mockEmitTransitionAlert.mockImplementation(async (source: string) => {
      if (String(source).endsWith('-8453')) throw new Error('telegram down (base alert)')
    })

    await runOnChainScan()

    expect(kvStore.get(MAINNET_LAST_BLOCK_KEY)).toBe(20000000)
    expect(kvStore.get(BASE_LAST_BLOCK_KEY)).toBe(19999900)
  })

  it('the top-level result stays the MAINNET scan shape (monitoring-loop contract unchanged)', async () => {
    const result = await runOnChainScan()
    expect(result).toMatchObject({
      fromBlock: 19999901,
      toBlock: 20000000,
      eventsFound: 0,
    })
  })

  it('[CHORE-ORDER-EXEC-PREP A] Base gets a FeeCollector target but NO OrderExecutor — the monitor skips it', () => {
    const targets = _internal.getScanTargets()
    const base = targets.find(t => t.chainId === 8453)
    const mainnet = targets.find(t => t.chainId === 1)
    // Base is still scanned for its FeeCollector...
    expect(base?.feeCollector?.toLowerCase()).toBe(FAKE_BASE_FC.toLowerCase())
    // ...but NOT for OrderExecutor events (0xeFC3…f130 is the FeeCollector on Base, not an executor).
    expect(base?.executor).toBeUndefined()
    // Mainnet still scans the real OrderExecutor.
    expect(mainnet?.executor?.toLowerCase()).toBe(ORDER_EXECUTOR_ADDRESS.toLowerCase())
  })
})
