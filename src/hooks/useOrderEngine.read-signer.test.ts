// @vitest-environment jsdom
/**
 * [A97 S-1/S-4] useOrderEngine's read-signer registration, against the shared registry in read-auth.ts:
 *   - ONE entry { address, sign } per mounted instance; unmounting removes only that instance's entry (a later-mounted
 *     instance unmounting no longer clears the signer while the first is still mounted);
 *   - no connected account = no entry (disconnect clears it; a fills 401 meanwhile records no refusal), reconnect
 *     registers again and the wallet is asked as before;
 *   - an account switch moves the entry: the old wallet has no signer, the new one has;
 *   - the signer asks wagmi for THAT account (`account`), and a signer captured before a switch refuses to sign for the
 *     wallet that is no longer connected (wagmi is never called, nothing cached, no refusal recorded).
 * Real signatures (viem local accounts) behind a wagmi mock that behaves like wagmi: it signs with the account it is
 * given, and throws ConnectorAccountNotFoundError when that account is not the connected one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret. B is generated per run.
const KEY_A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const KEY_B = privateKeyToAccount(generatePrivateKey())
const A = KEY_A.address
const B = KEY_B.address

const wallet = vi.hoisted(() => ({ connected: undefined as string | undefined }))
const wagmiSign = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>())

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
  useAccount: () => ({ address: wallet.connected }),
  useChainId: () => 1,
  useSignTypedData: () => ({ signTypedDataAsync: wagmiSign }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useReadContract: () => ({ data: 0n, isLoading: false, refetch: vi.fn().mockResolvedValue({ data: 0n }) }),
}))
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    fetchUserOrders: vi.fn().mockResolvedValue([]),
    fetchActiveOrders: vi.fn().mockResolvedValue([]),
    subscribeToOrders: vi.fn().mockReturnValue(vi.fn()),
  }
})

import { renderHook, act } from '@testing-library/react'
import { useOrderEngine, flushOrderWrites } from './useOrderEngine'
import {
  _readAuthInternal,
  ensureOrdersReadAuth,
  getCachedOrdersReadAuth,
  getOrdersReadSigner,
} from '@/lib/order-engine/read-auth'
import { fetchOrderExecutions } from '@/lib/order-engine/executions-client'

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  _readAuthInternal.reset()
  _readAuthInternal.clearSigner()
  wallet.connected = A
  wagmiSign.mockReset()
  // wagmi: signs with the account it is told to use, refuses one that is not the connected account.
  wagmiSign.mockImplementation(async (args) => {
    const account = String(args.account ?? wallet.connected)
    if (!wallet.connected || account.toLowerCase() !== wallet.connected.toLowerCase()) {
      const err = new Error(`Account "${account}" not found for connector`)
      err.name = 'ConnectorAccountNotFoundError'
      throw err
    }
    const key = account.toLowerCase() === A.toLowerCase() ? KEY_A : KEY_B
    const { account: _a, ...typed } = args
    return key.signTypedData(typed as Parameters<typeof KEY_A.signTypedData>[0])
  })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ status: 401, ok: false, json: async () => ({ code: 'READ_AUTH_REQUIRED' }) })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  await flushOrderWrites()
})

const settle = () => act(async () => { await Promise.resolve() })

describe('useOrderEngine registers one read signer per mount, for the connected account only', () => {
  it('two mounts: the later one unmounting leaves the first\'s signer; the first unmounting leaves none', async () => {
    const first = renderHook(() => useOrderEngine())
    const second = renderHook(() => useOrderEngine())
    await settle()
    expect(_readAuthInternal.signerCount()).toBe(2)
    expect(getOrdersReadSigner(A)).not.toBeNull()
    second.unmount()
    expect(_readAuthInternal.signerCount()).toBe(1)
    expect(getOrdersReadSigner(A)).not.toBeNull() // A97 S-4: on 302f9cec this cleared the shared signer
    first.unmount()
    expect(_readAuthInternal.signerCount()).toBe(0)
    expect(getOrdersReadSigner(A)).toBeNull()
  })

  it('disconnect clears it; a fills 401 meanwhile asks nobody and records no refusal; reconnect asks the wallet again', async () => {
    const view = renderHook(() => useOrderEngine())
    await settle()
    wallet.connected = undefined
    view.rerender()
    await settle()
    expect(_readAuthInternal.signerCount()).toBe(0)
    expect(getOrdersReadSigner(A)).toBeNull()

    wagmiSign.mockClear()
    expect((await fetchOrderExecutions('o-1', A, { live: true })).status).toBe(401)
    expect(wagmiSign).not.toHaveBeenCalled()
    expect(_readAuthInternal.isDenied(A)).toBe(false)

    wallet.connected = A
    view.rerender()
    await settle()
    const signer = getOrdersReadSigner(A)
    expect(signer).not.toBeNull()
    expect(await ensureOrdersReadAuth(A, signer!)).toBe('ok') // prompted, not 'denied' (A97 S-4)
    expect(wagmiSign).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('an account switch moves the entry: A has no signer once B is connected, B has one', async () => {
    const view = renderHook(() => useOrderEngine())
    await settle()
    wallet.connected = B
    view.rerender()
    await settle()
    expect(getOrdersReadSigner(A)).toBeNull()
    expect(getOrdersReadSigner(B)).not.toBeNull()
    expect(_readAuthInternal.signerCount()).toBe(1)
    view.unmount()
  })

  it('the signer names its account to wagmi, and the signature it stores recovers to that account', async () => {
    const view = renderHook(() => useOrderEngine())
    await settle()
    expect(await ensureOrdersReadAuth(A, getOrdersReadSigner(A)!)).toBe('ok')
    expect(String(wagmiSign.mock.calls[0][0].account).toLowerCase()).toBe(A.toLowerCase())
    expect(getCachedOrdersReadAuth(A)).not.toBeNull()
    view.unmount()
  })

  it('a signer captured while A was connected, called after the switch to B: wagmi is not asked, nothing cached, no refusal', async () => {
    const view = renderHook(() => useOrderEngine())
    await settle()
    const stale = getOrdersReadSigner(A)!
    wallet.connected = B
    view.rerender()
    await settle()
    wagmiSign.mockClear()
    expect(await ensureOrdersReadAuth(A, stale)).toBe('unavailable')
    expect(wagmiSign).not.toHaveBeenCalled()
    expect(getCachedOrdersReadAuth(A)).toBeNull()
    expect(_readAuthInternal.isDenied(A)).toBe(false)
    view.unmount()
  })

  it('wagmi itself refusing the account (switched in the wallet before React re-rendered) is not a refusal either', async () => {
    const view = renderHook(() => useOrderEngine())
    await settle()
    const signer = getOrdersReadSigner(A)!
    wallet.connected = B // the wallet switched; this mount has not re-rendered yet
    expect(await ensureOrdersReadAuth(A, signer)).toBe('unavailable')
    expect(wagmiSign).toHaveBeenCalledTimes(1)
    expect(getCachedOrdersReadAuth(A)).toBeNull()
    expect(_readAuthInternal.isDenied(A)).toBe(false)
    view.unmount()
  })
})
