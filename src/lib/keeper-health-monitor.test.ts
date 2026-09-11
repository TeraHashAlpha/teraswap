/**
 * Unit tests for src/lib/keeper-health-monitor.ts — [Auditor M2 / PR #497] chain-aware keeper
 * monitoring (gas balance + overdue-DCA-fill liveness), one rule iterated over KEEPER_CHAINS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────

const mockGetBalance = vi.fn()
const mockGetPublicClientForChain = vi.fn((_chainId?: number) => ({ getBalance: mockGetBalance }))

vi.mock('./chains/clients', () => ({
  getPublicClientForChain: (chainId: number) => mockGetPublicClientForChain(chainId),
}))

const mockIsChainActive = vi.fn()

vi.mock('./chains/activation', () => ({
  isChainActive: (chainId: number) => mockIsChainActive(chainId),
}))

function makeSupabaseStub(rows: unknown[] | null, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: rows, error }),
          }),
        }),
      }),
    }),
  }
}

const mockGetSupabase = vi.fn(() => makeSupabaseStub([]))

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}))

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)

vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

import {
  KEEPER_CHAINS,
  checkKeeperChain,
  checkAllKeeperChains,
  alertOnKeeperTrouble,
  describeKeeperHealth,
  type KeeperChainHealth,
} from './keeper-health-monitor'

const BASE_ENV = 'KEEPER_ADDRESS_BASE'
const ARBITRUM_ENV = 'KEEPER_ADDRESS_ARBITRUM'
const BASE_ADDR = '0x71f5AC191587AE132D966a719569b2468e0Aa2E5'
const ARBITRUM_ADDR = '0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab'

function ethToWei(eth: number): bigint {
  return BigInt(Math.round(eth * 1e18))
}

describe('keeper-health-monitor', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env[BASE_ENV]
    delete process.env[ARBITRUM_ENV]
    mockGetSupabase.mockReturnValue(makeSupabaseStub([]))
    mockIsChainActive.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('the keeper table has exactly Base and Arbitrum, one rule shape each', () => {
    expect(KEEPER_CHAINS).toEqual([
      { chainId: 8453, envVar: 'KEEPER_ADDRESS_BASE' },
      { chainId: 42161, envVar: 'KEEPER_ADDRESS_ARBITRUM' },
    ])
  })

  // ── Pin: Base-only behaviour is byte-identical to today's workflow thresholds ──
  describe('Base-only (pin — matches the pre-existing 0.01 / 0.002 ETH convention)', () => {
    beforeEach(() => {
      process.env[BASE_ENV] = BASE_ADDR
      mockIsChainActive.mockImplementation((chainId: number) => chainId === 8453)
    })

    it('reports ok above the 0.01 ETH warning threshold', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.02))
      const result = await checkKeeperChain(KEEPER_CHAINS[0])
      expect(result).toEqual({
        chainId: 8453,
        monitored: true,
        gasStatus: 'ok',
        balanceEth: 0.02,
        overdueOrderCount: 0,
      })
    })

    it('reports warning between 0.002 and 0.01 ETH', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.005))
      const result = await checkKeeperChain(KEEPER_CHAINS[0])
      expect(result.gasStatus).toBe('warning')
    })

    it('reports critical below 0.002 ETH', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.001))
      const result = await checkKeeperChain(KEEPER_CHAINS[0])
      expect(result.gasStatus).toBe('critical')
    })

    it('Arbitrum is not-monitored when its env var is unset — full-table result', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.02))
      const results = await checkAllKeeperChains()
      expect(results).toEqual([
        { chainId: 8453, monitored: true, gasStatus: 'ok', balanceEth: 0.02, overdueOrderCount: 0 },
        { chainId: 42161, monitored: false },
      ])
    })
  })

  // ── Base + Arbitrum both healthy ─────────────────────────
  it('Base + Arbitrum both healthy → two monitored blocks, no alert', async () => {
    process.env[BASE_ENV] = BASE_ADDR
    process.env[ARBITRUM_ENV] = ARBITRUM_ADDR
    mockIsChainActive.mockReturnValue(true)
    mockGetBalance
      .mockResolvedValueOnce(ethToWei(0.02)) // Base
      .mockResolvedValueOnce(ethToWei(0.01)) // Arbitrum (above its 0.002 warning)

    const results = await checkAllKeeperChains()
    expect(results.every(r => r.monitored)).toBe(true)
    expect(results.map(r => r.gasStatus)).toEqual(['ok', 'ok'])

    await alertOnKeeperTrouble(results)
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  // ── Arbitrum trouble → loud alert naming 42161 ──────────
  describe('Arbitrum keeper trouble', () => {
    beforeEach(() => {
      process.env[ARBITRUM_ENV] = ARBITRUM_ADDR
      mockIsChainActive.mockImplementation((chainId: number) => chainId === 42161)
    })

    it('balance 0 → critical + loud alert naming chain 42161', async () => {
      mockGetBalance.mockResolvedValueOnce(0n)
      const results = await checkAllKeeperChains()
      const arb = results.find(r => r.chainId === 42161)!
      expect(arb.gasStatus).toBe('critical')

      await alertOnKeeperTrouble(results)
      expect(mockEmitTransitionAlert).toHaveBeenCalledWith(
        'keeper-gas-42161',
        'active',
        'disabled',
        expect.stringContaining('42161'),
      )
    })

    it('RPC unreachable → loud alert naming chain 42161', async () => {
      mockGetBalance.mockRejectedValueOnce(new Error('RPC timeout'))
      const results = await checkAllKeeperChains()
      const arb = results.find(r => r.chainId === 42161)!
      expect(arb.gasStatus).toBe('rpc-unreachable')

      await alertOnKeeperTrouble(results)
      expect(mockEmitTransitionAlert).toHaveBeenCalledWith(
        'keeper-gas-42161',
        'active',
        'disabled',
        expect.stringContaining('42161'),
      )
    })

    it('overdue DCA fills → loud alert naming chain 42161 with the count', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.01)) // healthy gas
      const now = Date.now()
      const overdueRow = {
        // Schedule started well in the past, no fill ever recorded, 1h interval →
        // next-buy was due long ago, well past the 2-poll-interval (120s) grace.
        created_at: new Date(now - 3 * 3600_000).toISOString(),
        executed_at: null,
        dca_interval: 3600, // seconds
      }
      mockGetSupabase.mockReturnValue(makeSupabaseStub([overdueRow]))

      const results = await checkAllKeeperChains()
      const arb = results.find(r => r.chainId === 42161)!
      expect(arb.overdueOrderCount).toBe(1)

      await alertOnKeeperTrouble(results)
      expect(mockEmitTransitionAlert).toHaveBeenCalledWith(
        'keeper-overdue-42161',
        'active',
        'degraded',
        expect.stringContaining('chain 42161 count=1'),
      )
    })

    it('a fill within the last poll window is NOT overdue', async () => {
      mockGetBalance.mockResolvedValueOnce(ethToWei(0.01))
      const now = Date.now()
      const freshRow = {
        created_at: new Date(now - 3 * 3600_000).toISOString(),
        executed_at: new Date(now - 5_000).toISOString(), // fill 5s ago
        dca_interval: 3600,
      }
      mockGetSupabase.mockReturnValue(makeSupabaseStub([freshRow]))

      const results = await checkAllKeeperChains()
      const arb = results.find(r => r.chainId === 42161)!
      expect(arb.overdueOrderCount).toBe(0)

      await alertOnKeeperTrouble(results)
      expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
    })
  })

  // ── Arbitrum var unset → explicit "not monitored", never silent ──
  it('Arbitrum var unset → not monitored, and never touches RPC or Supabase for it', async () => {
    process.env[BASE_ENV] = BASE_ADDR
    mockIsChainActive.mockImplementation((chainId: number) => chainId === 8453)
    mockGetBalance.mockResolvedValueOnce(ethToWei(0.02))

    const results = await checkAllKeeperChains()
    const arb = results.find(r => r.chainId === 42161)!
    expect(arb).toEqual({ chainId: 42161, monitored: false })
    expect(mockGetBalance).toHaveBeenCalledTimes(1) // Base only — Arbitrum never queried
  })

  it('Arbitrum unset when active on-chain still reports not-monitored (env var gates too)', async () => {
    mockIsChainActive.mockReturnValue(true) // chain active, but no env var set
    const results = await checkAllKeeperChains()
    const arb = results.find(r => r.chainId === 42161)!
    expect(arb.monitored).toBe(false)
  })

  // ── describeKeeperHealth — the exact reporting-line convention ──
  describe('describeKeeperHealth', () => {
    it('renders "not monitored" verbatim for an unmonitored chain', () => {
      const health: KeeperChainHealth = { chainId: 42161, monitored: false }
      expect(describeKeeperHealth(health)).toBe('42161: not monitored')
    })

    it('renders gas status + balance for a healthy monitored chain', () => {
      const health: KeeperChainHealth = {
        chainId: 8453,
        monitored: true,
        gasStatus: 'ok',
        balanceEth: 0.05,
        overdueOrderCount: 0,
      }
      expect(describeKeeperHealth(health)).toBe('8453: ok (0.05 ETH)')
    })

    it('appends the overdue-fill count when present', () => {
      const health: KeeperChainHealth = {
        chainId: 42161,
        monitored: true,
        gasStatus: 'ok',
        balanceEth: 0.01,
        overdueOrderCount: 2,
      }
      expect(describeKeeperHealth(health)).toBe('42161: ok (0.01 ETH), 2 overdue fill(s)')
    })

    it('renders rpc-unreachable without a balance figure', () => {
      const health: KeeperChainHealth = {
        chainId: 42161,
        monitored: true,
        gasStatus: 'rpc-unreachable',
        overdueOrderCount: 0,
      }
      expect(describeKeeperHealth(health)).toBe('42161: rpc-unreachable')
    })
  })

  // ── Never-throw guarantees ────────────────────────────────
  it('a Supabase error yields overdueOrderCount 0 rather than throwing', async () => {
    process.env[BASE_ENV] = BASE_ADDR
    mockIsChainActive.mockReturnValue(true)
    mockGetBalance.mockResolvedValueOnce(ethToWei(0.02))
    mockGetSupabase.mockReturnValue(makeSupabaseStub(null, { message: 'boom' }))

    const result = await checkKeeperChain(KEEPER_CHAINS[0])
    expect(result.overdueOrderCount).toBe(0)
  })

  it('a missing Supabase client yields overdueOrderCount 0 rather than throwing', async () => {
    process.env[BASE_ENV] = BASE_ADDR
    mockIsChainActive.mockReturnValue(true)
    mockGetBalance.mockResolvedValueOnce(ethToWei(0.02))
    mockGetSupabase.mockReturnValue(null as unknown as ReturnType<typeof makeSupabaseStub>)

    const result = await checkKeeperChain(KEEPER_CHAINS[0])
    expect(result.overdueOrderCount).toBe(0)
  })

  it('alertOnKeeperTrouble never throws even when emitTransitionAlert rejects', async () => {
    mockEmitTransitionAlert.mockRejectedValueOnce(new Error('telegram down'))
    const health: KeeperChainHealth[] = [
      { chainId: 42161, monitored: true, gasStatus: 'critical', balanceEth: 0, overdueOrderCount: 0 },
    ]
    await expect(alertOnKeeperTrouble(health)).resolves.toBeUndefined()
  })
})
