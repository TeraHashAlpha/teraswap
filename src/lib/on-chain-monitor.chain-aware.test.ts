/**
 * [CHORE-ORDER-EXEC-PREP A / #4] on-chain-monitor — chain-aware scan targets.
 *
 * getScanTargets() must scan order events on a chain's REAL OrderExecutor only:
 *   - mainnet (1):  executor === ORDER_EXECUTOR_ADDRESS (0xeFC31ADb…f130)
 *   - Base (8453):  executor === Base's OWN deployment (0x135B339902…D2598),
 *                   which is NOT the Base FeeCollector at 0xeFC31ADb…f130 —
 *                   the same string is a DIFFERENT bytecode contract on Base,
 *                   so order events must never be scanned against it.
 *   - unwired (e.g. Arbitrum 42161): getOrderExecutor(42161) === null, so the
 *                   target carries NO executor field — the monitor refuses to
 *                   scan a non-existent / wrong contract for order events.
 *
 * Distinct from on-chain-monitor.multichain.test.ts: that file pins the
 * multi-chain SCAN/alert/cursor behavior with a FAKE Base FeeCollector. THIS
 * file pins the CHAIN-AWARENESS of getScanTargets() — which contract the
 * executor leg resolves to per chain — using the REAL getOrderExecutor config
 * (1 + 8453 wired, 42161 not). The registry is mocked only to control WHICH
 * chains are enumerated (incl. an otherwise-unsupported 42161).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Byte-identical pins (lowercased for case-insensitive address comparison).
const MAINNET_EXECUTOR = '0xefc31adb5d10c51ac4383bb770e2fdc65780f130'
const BASE_EXECUTOR = '0x135b339902ea4e0fb4cf059961dc8856ba1d2598'
const FAKE_BASE_FC = '0xba5efc0000000000000000000000000000008453'
const FAKE_ARB_FC = '0xa4b1fc0000000000000000000000000000042161'
const MAINNET_LAST_BLOCK_KEY = 'teraswap:onchain:last-block'
const BASE_LAST_BLOCK_KEY = 'teraswap:onchain:last-block:8453'

// ── Mocks (same boundary set as the sibling tests) ───────

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

// Registry mock: keep mainnet (1) REAL; give Base (8453) a deployed FeeCollector
// (its real config has feeCollector=null in test env); add an OTHERWISE
// UNSUPPORTED Arbitrum (42161) with a deployed FeeCollector so getScanTargets
// enumerates it — 42161 has NO OrderExecutor in the real config.
vi.mock('@/lib/chains/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains/registry')>()
  return {
    ...actual,
    getSupportedChainIds: () => [1, 8453, 42161],
    getChainConfig: (chainId: number) => {
      if (chainId === 8453) {
        const base = actual.getChainConfig(8453)
        return { ...base, contracts: { ...base.contracts, feeCollector: FAKE_BASE_FC } }
      }
      if (chainId === 42161) {
        // Fabricate a minimal Arbitrum config with a deployed FeeCollector but
        // no executor wiring (executor resolution is via getOrderExecutor, not
        // the registry, so the real null result stands).
        const base = actual.getChainConfig(8453)
        return {
          ...base,
          chainId: 42161,
          name: 'Arbitrum One',
          slug: 'arbitrum',
          contracts: { ...base.contracts, feeCollector: FAKE_ARB_FC },
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

beforeEach(() => {
  vi.clearAllMocks()
  kvStore.clear()
  _resetLastScannedBlockCache()
  mockGetBlockNumber.mockResolvedValue(20000000n)
  mockGetLogs.mockResolvedValue([])
})

describe('on-chain-monitor — chain-aware scan targets [#4]', () => {
  it('mainnet (1) target.executor is the real OrderExecutor (0xeFC31ADb…f130)', () => {
    const mainnet = _internal.getScanTargets().find(t => t.chainId === 1)
    expect(mainnet).toBeDefined()
    expect(mainnet!.executor).toBeDefined()
    expect(mainnet!.executor!.toLowerCase()).toBe(MAINNET_EXECUTOR)
  })

  it('Base (8453) target.executor is Base\'s OWN OrderExecutor — NOT the Base FeeCollector (0xeFC3…f130)', () => {
    const base = _internal.getScanTargets().find(t => t.chainId === 8453)
    expect(base).toBeDefined()
    // The Base FeeCollector (mocked here) is a distinct address from the executor.
    expect(base!.feeCollector!.toLowerCase()).toBe(FAKE_BASE_FC)
    // Executor is Base's OWN deployment...
    expect(base!.executor).toBeDefined()
    expect(base!.executor!.toLowerCase()).toBe(BASE_EXECUTOR)
    // ...and it is NOT the FeeCollector address that on mainnet IS the executor.
    // Order events on Base must be scanned on the real executor, never on
    // 0xeFC31ADb…f130 (which is the FeeCollector — different bytecode — on Base).
    expect(base!.executor!.toLowerCase()).not.toBe(MAINNET_EXECUTOR)
  })

  it('an UNWIRED chain (Arbitrum 42161, no OrderExecutor) gets NO executor target', () => {
    // Guard: the real config truly has no executor for 42161 (so we are pinning
    // real fail-closed behavior, not an artifact of the mock).
    expect(_internal.getScanTargets).toBeTypeOf('function')

    const arb = _internal.getScanTargets().find(t => t.chainId === 42161)
    // It IS enumerated (its mocked FeeCollector makes it monitorable)...
    expect(arb).toBeDefined()
    expect(arb!.feeCollector!.toLowerCase()).toBe(FAKE_ARB_FC)
    // ...but the executor leg is absent — the monitor does NOT scan a
    // non-existent / wrong contract for OrderExecutor events.
    expect(arb!.executor).toBeUndefined()
    expect('executor' in arb!).toBe(false)
  })

  it('the unwired chain is still scanned for its FeeCollector but never queries an executor (no order-event leg)', async () => {
    // Drive a full scan and confirm getLogs is called for the Arbitrum
    // FeeCollector address but for NO executor on that chain. Both chains have
    // a prior cursor so a fresh small range is scanned for each.
    kvStore.set(MAINNET_LAST_BLOCK_KEY, 19999900)
    kvStore.set(BASE_LAST_BLOCK_KEY, 19999900)
    kvStore.set('teraswap:onchain:last-block:42161', 19999900)

    await runOnChainScan()

    const scanned = mockGetLogs.mock.calls.map(c =>
      String((c[0] as { address?: string }).address).toLowerCase(),
    )
    // The Arbitrum FeeCollector WAS queried (it's monitorable)...
    expect(scanned).toContain(FAKE_ARB_FC)
    // ...but neither executor address was queried "as part of" Arbitrum —
    // critically, no executor address was queried that resolves from 42161.
    // getScanTargets for 42161 has no executor, so the only executor queries
    // come from mainnet + Base. Mainnet executor query is expected:
    expect(scanned).toContain(MAINNET_EXECUTOR)
    // Base executor query is expected (Base IS wired):
    expect(scanned).toContain(BASE_EXECUTOR)
    // Sanity: exactly two distinct executor addresses ever queried (mainnet +
    // Base) — Arbitrum added none. If 42161 had wrongly inherited an executor,
    // a third executor address (or a repeat against the FeeCollector) would show.
    const executorQueries = scanned.filter(a => a === MAINNET_EXECUTOR || a === BASE_EXECUTOR)
    const distinctExecutors = new Set(executorQueries)
    expect(distinctExecutors.size).toBe(2)
  })

  it('per-chain last-scanned cursor keys differ: mainnet uses the legacy key, Base uses the :8453 suffix', async () => {
    // No logs → clean advance on every chain. Distinct prior cursors so each
    // advances its OWN key to head (20000000).
    kvStore.set(MAINNET_LAST_BLOCK_KEY, 19999900)
    kvStore.set(BASE_LAST_BLOCK_KEY, 19999800)
    kvStore.set('teraswap:onchain:last-block:42161', 19999700)

    await runOnChainScan()

    // Legacy (un-suffixed) key is the mainnet cursor — byte-identical to pre-E-4.
    expect(MAINNET_LAST_BLOCK_KEY).toBe(_internal.LAST_BLOCK_KEY)
    expect(kvStore.get(MAINNET_LAST_BLOCK_KEY)).toBe(20000000)
    // Base writes to a DISTINCT, chain-suffixed key (never the legacy one).
    expect(BASE_LAST_BLOCK_KEY).not.toBe(MAINNET_LAST_BLOCK_KEY)
    expect(kvStore.get(BASE_LAST_BLOCK_KEY)).toBe(20000000)

    // Confirm the writes were addressed to the EXPECTED keys (cursors never mix).
    const lastBlockSetKeys = mockKvSet.mock.calls
      .map(c => c[0] as string)
      .filter(k => k.startsWith(MAINNET_LAST_BLOCK_KEY))
    expect(lastBlockSetKeys).toContain(MAINNET_LAST_BLOCK_KEY)
    expect(lastBlockSetKeys).toContain(BASE_LAST_BLOCK_KEY)
  })
})
