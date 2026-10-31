/**
 * Shared test harness for the DCA tab (B6a): v1's DCAPanel and the v2 card are rendered against ONE set of mocked hook answers.
 * Not a test file — `vi.mock` calls live in each test (they are hoisted per file) and read `h` through a dynamic import in their factories.
 *
 * Imported by `dca-draft-parity.test.tsx`, `dca-card.test.tsx`, `dca-content-parity.test.tsx`, `dca-review.test.tsx`.
 */
import { vi } from 'vitest'
import type { PairFloorInfo } from '@/components/dca/pair-floor-info'

export const BASE = 8453

export const h = {
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 8453 } as { id: number } | undefined },
  /** keyed by lower-cased token address -> raw balance */
  balances: new Map<string, { raw: bigint; formatted: string }>(),
  direct: { raw: 0n as bigint | undefined, formatted: undefined as string | undefined, hasValue: false },
  oracle: { chainlinkPrice: 2500 as number | null, executionPrice: null, deviation: 0, level: 'none', message: null as string | null, oracleUnavailable: false, oracleIntegrityFailed: false, oracleReadFailed: false } as Record<string, unknown>,
  oracleOut: { chainlinkPrice: 1 as number | null, executionPrice: null, deviation: 0, level: 'none', message: null as string | null, oracleUnavailable: false, oracleIntegrityFailed: false, oracleReadFailed: false } as Record<string, unknown>,
  depeg: { mode: 'ok', divergence: 0, symbol: '', message: '' } as { mode: string; divergence: number; symbol: string; message: string },
  floor: null as PairFloorInfo | null,
  /** the v3 executor is "deployed" on these chains for the test run */
  v3Chains: [8453, 42161] as number[],
  engine: {
    createOrder: vi.fn(async (_config: unknown) => {}),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    removeOrder: vi.fn(),
    dcaOrders: [] as unknown[],
    latestEvent: null as unknown,
    // B6b: the two-phase gates of v1's engine (freeze → confirm), controllable per test
    pendingOrder: null as unknown,
    confirmOrder: vi.fn(async () => {}),
    clearPendingOrder: vi.fn(),
    isSubmitting: false,
    pendingCancel: null as unknown,
    confirmCancel: vi.fn(async () => {}),
    clearPendingCancel: vi.fn(),
  },
  /** `useOrderApproval` (v1's approve-then-sign gate inside the EIP-712 review), as the test wants it. */
  approval: {
    spender: '0x3333333333333333333333333333333333333333' as `0x${string}` | null,
    allowance: 0n as bigint | undefined,
    isApproved: true,
    needsApproval: false,
    status: 'idle' as 'idle' | 'approving' | 'confirming' | 'ready' | 'error',
    error: null as string | null,
    approve: vi.fn(async () => {}),
  },
  /** every `useOrderApproval(...)` argument list a tree made (v1's OrderReviewModal vs the v2 sign sheet must agree) */
  approvalArgs: [] as unknown[][],
  /** every sounds.ts call, in order, by name — the table test compares v1's sequence with v2's */
  soundLog: [] as string[],
  sounds: {} as Record<'playClick' | 'playTouchMP3' | 'playSwapConfirmMP3' | 'playCancelOrderMP3' | 'startWaitingSound' | 'stopWaitingSound', ReturnType<typeof vi.fn>>,
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
  toast: vi.fn((_t?: unknown) => 'toast-id'),
}

for (const name of ['playClick', 'playTouchMP3', 'playSwapConfirmMP3', 'playCancelOrderMP3', 'startWaitingSound', 'stopWaitingSound'] as const) {
  h.sounds[name] = vi.fn(() => { h.soundLog.push(name) })
}

export const unpricedInfo = (over: Partial<PairFloorInfo> = {}): PairFloorInfo => ({
  tier: 'unpriced',
  legs: { in: { registered: true, priced: true }, out: { registered: false, priced: false } },
  registeredFeedCount: 3,
  effectiveCap: 250,
  ...over,
})

export const offchainInfo = (over: Partial<PairFloorInfo> = {}): PairFloorInfo => ({
  tier: 'offchain-price',
  legs: { in: { registered: true, priced: true }, out: { registered: false, priced: true } },
  registeredFeedCount: 2,
  effectiveCap: 250,
  ...over,
})

export const onchainInfo = (): PairFloorInfo => ({
  tier: 'onchain-feed',
  legs: { in: { registered: true, priced: true }, out: { registered: true, priced: true } },
  registeredFeedCount: 2,
  effectiveCap: 250,
})

export function resetHarness() {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: BASE } }
  h.balances = new Map()
  h.direct = { raw: 0n, formatted: undefined, hasValue: false }
  h.oracle = { chainlinkPrice: 2500, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false, oracleIntegrityFailed: false, oracleReadFailed: false }
  h.oracleOut = { chainlinkPrice: 1, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false, oracleIntegrityFailed: false, oracleReadFailed: false }
  h.depeg = { mode: 'ok', divergence: 0, symbol: '', message: '' }
  h.floor = onchainInfo()
  h.v3Chains = [BASE, 42161]
  h.engine.dcaOrders = []
  h.engine.latestEvent = null
  h.engine.pendingOrder = null
  h.engine.isSubmitting = false
  h.engine.pendingCancel = null
  h.approval = { spender: '0x3333333333333333333333333333333333333333', allowance: 0n, isApproved: true, needsApproval: false, status: 'idle', error: null, approve: vi.fn(async () => {}) }
  h.approvalArgs = []
  vi.clearAllMocks()
  h.soundLog.length = 0
}

/** The `useOrderEngine()` answer every DCA test mounts v1's DCAPanel and the v2 card on — one object, read from `h.engine` at render. */
export function engineMock() {
  return {
    dcaOrders: h.engine.dcaOrders, activeOrders: [], historyOrders: [], latestEvent: h.engine.latestEvent, isSubmitting: h.engine.isSubmitting,
    createOrder: h.engine.createOrder, pendingOrder: h.engine.pendingOrder, confirmOrder: h.engine.confirmOrder, clearPendingOrder: h.engine.clearPendingOrder,
    pendingCancel: h.engine.pendingCancel, confirmCancel: h.engine.confirmCancel, clearPendingCancel: h.engine.clearPendingCancel,
    cancelOrder: h.engine.cancelOrder, cancelAllOrders: h.engine.cancelAllOrders, removeOrder: h.engine.removeOrder,
  }
}
