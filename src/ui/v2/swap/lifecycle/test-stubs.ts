/**
 * Test seams for the B3/B4 card tests, which exercise the card's rendering with v1's quote hooks mocked at the module edge:
 * the wallet lifecycle (`useSwap` / `useSplitSwap` / `useSplitRoute`, the gates' `useDepegCheck`, the toast provider) is stubbed
 * idle so those tests stay about what they were about. The lifecycle itself is tested in `lifecycle/*.test.tsx` against the
 * real hook with v1's hooks mocked underneath.
 */
import { vi } from 'vitest'

export function idleLifecycle() {
  return {
    swap: {
      status: 'idle' as const,
      txHash: undefined,
      errorMessage: null,
      priceGuardBlocked: false,
      priceGuardDeviation: null,
      unpricedAckRequired: false,
      pendingSwap: null,
      pendingCowOrder: null,
      mevSurplusActualWei: null,
      confirmSwap: vi.fn(),
      confirmCowOrder: vi.fn(),
      reset: vi.fn(),
    },
    split: { status: 'idle' as const, plannedLegs: [], legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, unpricedAckRequired: false, confirmPlan: vi.fn(), reset: vi.fn() },
    splitRoute: { splitResult: null, analyzing: false, useSplit: false, toggleSplit: vi.fn() },
    isSplitActive: false,
    status: 'idle' as const,
    error: null,
    ackRequired: false,
    consentRequested: false,
    success: null,
    confirm: vi.fn(async () => {}),
    cancel: vi.fn(),
    resetAll: vi.fn(),
  }
}

export const OK_DEPEG = { mode: 'ok' as const, divergence: 0, symbol: '', message: null }
export const TOAST_STUB = { toast: vi.fn(() => 'toast-id'), dismiss: vi.fn(), update: vi.fn() }
