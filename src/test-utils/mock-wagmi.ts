/**
 * [P115/M-01] Wagmi hook stubs for vitest.
 *
 * Each helper returns a vi.fn() so individual tests can mutate the
 * return value per case. The base `installWagmiMocks(overrides)` lets
 * a test override exactly what it needs; everything else defaults to
 * a sensible "connected to mainnet, no pending tx" stub.
 *
 * Use sparingly — hooks tests should prefer `vi.mock('wagmi', …)` at
 * the top of the file (mocks must be hoisted before the import that
 * uses them); this module bundles the canonical mock shape.
 */

import { vi } from 'vitest'

export const MOCK_MAINNET_ID = 1
export const MOCK_USER_ADDRESS = '0x1111111111111111111111111111111111111111'

export interface WagmiMockOverrides {
  address?: `0x${string}` | undefined
  isConnected?: boolean
  chainId?: number
  /** Used by useBalance — defaults to a generous 1 ETH balance. */
  balanceWei?: bigint
}

export interface WagmiMockBundle {
  useAccount: ReturnType<typeof vi.fn>
  useChainId: ReturnType<typeof vi.fn>
  useBalance: ReturnType<typeof vi.fn>
  useSendTransaction: ReturnType<typeof vi.fn>
  useWaitForTransactionReceipt: ReturnType<typeof vi.fn>
  useReadContract: ReturnType<typeof vi.fn>
  useEstimateFeesPerGas: ReturnType<typeof vi.fn>
  usePublicClient: ReturnType<typeof vi.fn>
  useSignTypedData: ReturnType<typeof vi.fn>
}

/**
 * Build a fresh bundle of wagmi mock fns. Callers pass this into
 * `vi.mock('wagmi', () => bundle)` (note: vi.mock factory hoists, so
 * the bundle has to be constructed inside the factory closure).
 */
export function makeWagmiMocks(overrides: WagmiMockOverrides = {}): WagmiMockBundle {
  const o: Required<WagmiMockOverrides> = {
    address: MOCK_USER_ADDRESS,
    isConnected: true,
    chainId: MOCK_MAINNET_ID,
    balanceWei: 10n ** 18n, // 1 ETH
    ...overrides,
  }

  return {
    useAccount: vi.fn(() => ({
      address: o.address,
      isConnected: o.isConnected,
      chain: { id: o.chainId, name: 'mainnet' },
    })),
    useChainId: vi.fn(() => o.chainId),
    useBalance: vi.fn(() => ({
      data: { value: o.balanceWei, decimals: 18, symbol: 'ETH', formatted: '1.0' },
      isLoading: false,
      isError: false,
    })),
    useSendTransaction: vi.fn(() => ({
      sendTransaction: vi.fn(),
      data: undefined,
      error: null,
      reset: vi.fn(),
    })),
    useWaitForTransactionReceipt: vi.fn(() => ({
      data: undefined,
      isSuccess: false,
      isError: false,
    })),
    useReadContract: vi.fn(() => ({ data: undefined, isLoading: false })),
    useEstimateFeesPerGas: vi.fn(() => ({
      data: { maxFeePerGas: 20n * 10n ** 9n }, // 20 gwei
    })),
    usePublicClient: vi.fn(() => ({
      readContract: vi.fn(),
      call: vi.fn(),
    })),
    useSignTypedData: vi.fn(() => ({
      signTypedDataAsync: vi.fn(),
    })),
  }
}
