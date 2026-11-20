// @vitest-environment jsdom
/**
 * [A100 R2-1] The History tab's read, v1 (WalletHistory) and v2 (HistoryTab → useWalletHistory), with the REAL read-auth
 * module: `GET /api/history?wallet=` carries the session's orders read signature only when the cached entry is the
 * connected wallet's OWN. A foreign entry (another account's signature cached under this wallet) is dropped and never sent:
 * the request goes out without the two headers (instant swaps only, as with nothing cached), on connect and on Refresh.
 * history.test.tsx mocks the helper to compare v1 and v2; here nothing of read-auth is mocked.
 *
 * Real signatures (viem local accounts); wagmi and the API are mocked. No signature is printed.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret. B is generated per run.
const A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const B = privateKeyToAccount(generatePrivateKey())
const WALLET = A.address

vi.mock('wagmi', () => ({ useAccount: () => ({ address: WALLET, isConnected: true }) }))

import WalletHistory from '@/components/WalletHistory'
import { HistoryTab } from './HistoryTab'
import {
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  _readAuthInternal,
  buildOrdersReadTypedData,
  getCachedOrdersReadAuth,
  storeOrdersReadAuth,
} from '@/lib/order-engine/read-auth'

const URL = `/api/history?wallet=${WALLET}&limit=50`
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ swaps: [], total: 0 }) }) as Response)
const calls = () => fetchMock.mock.calls.map(([u, i]) => [u, i?.headers])

async function plant(signer: typeof A) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const entry = { issuedAt, signature: await signer.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)) }
  storeOrdersReadAuth(WALLET, entry)
  return entry
}

beforeEach(() => {
  sessionStorage.clear()
  _readAuthInternal.reset()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SURFACES = [
  ['v1 WalletHistory', () => render(<WalletHistory />)],
  ['v2 HistoryTab', () => render(<HistoryTab />)],
] as const

describe.each(SURFACES)('[A100 R2-1] %s: the history read sends only the wallet\'s own cached read signature', (_name, mount) => {
  it('a foreign entry (B\'s signature under A): the request on connect AND the one on Refresh carry no read headers; the entry is removed', async () => {
    await plant(B)
    const view = mount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    await plant(B) // planted again: Refresh must not send it either
    await waitFor(() => expect(within(view.container).getByText('Refresh')).toBeTruthy())
    fireEvent.click(within(view.container).getByText('Refresh'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls()).toEqual([[URL, undefined], [URL, undefined]])
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('the wallet\'s OWN entry rides the request (the server then merges its DCA fills), and stays cached', async () => {
    const own = await plant(A)
    mount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(calls()).toEqual([[URL, { [ORDERS_READ_HEADER_ISSUED]: String(own.issuedAt), [ORDERS_READ_HEADER_SIGNATURE]: own.signature }]])
    expect(getCachedOrdersReadAuth(WALLET)?.signature).toBe(own.signature)
  })

  it('nothing cached: no read headers (as before)', async () => {
    mount()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(calls()).toEqual([[URL, undefined]])
  })
})
