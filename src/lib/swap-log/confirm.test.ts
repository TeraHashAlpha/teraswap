// @vitest-environment node
/**
 * [goal 133b H.5, I.4] confirmSwap directly: which chains a confirmation asks, and the time budget of a search that names
 * no chain (CHAIN_SEARCH_BUDGET_MS), so a claim is stored well inside the route's maxDuration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
})
vi.mock('@/lib/chainlink', () => ({ computeTokenAmountUsd: vi.fn(async () => null) }))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({ trackLargeTrade: vi.fn(), trackSwapFailed: vi.fn(), trackOracleDeviation: vi.fn(), trackOracleUnavailable: vi.fn() }))

import { SWAP_RECEIPTS as R, recordedChainRead } from '@/lib/__fixtures__/swap-receipts'
import { createFakeSwapsDb, type FakeSwapsDb } from '@/test-utils/fake-swaps-db'
import { CHAIN_SEARCH_BUDGET_MS, confirmSwap } from './confirm'

const f = R.arbitrumFcTokenToEth
const wallet = String(f.tx.from).toLowerCase()
let db: FakeSwapsDb

beforeEach(() => {
  db = createFakeSwapsDb()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the chains a confirmation asks (H.5)', () => {
  it('no chain named and no pending row: the app\'s chains in the registry\'s order, stopping at the one that has it', async () => {
    const chain = recordedChainRead()
    const result = await confirmSwap({ db: db.service as never, wallet, txHash: f.hash, chainId: null }, { read: chain.read })
    expect(result).toEqual({ result: 'verified' })
    expect(chain.calls.map((c) => `${c.chainId}:${c.method}`)).toEqual([
      '1:eth_getTransactionByHash', '8453:eth_getTransactionByHash', '42161:eth_getTransactionByHash', '42161:eth_getTransactionReceipt',
    ])
  })

  it('the chain named is the only one asked, whatever the time', async () => {
    const chain = recordedChainRead()
    const result = await confirmSwap({ db: db.service as never, wallet, txHash: f.hash, chainId: 42161 }, { read: chain.read, elapsedMs: () => 10 * CHAIN_SEARCH_BUDGET_MS })
    expect(result).toEqual({ result: 'verified' })
    expect(new Set(chain.calls.map((c) => c.chainId))).toEqual(new Set([42161]))
  })

  it(`a search that names no chain starts no new chain after ${CHAIN_SEARCH_BUDGET_MS} ms: the hash is kept, with no chain`, async () => {
    expect(CHAIN_SEARCH_BUDGET_MS).toBe(20_000)
    const chain = recordedChainRead()
    let asked = 0
    const elapsedMs = () => (asked++ === 0 ? CHAIN_SEARCH_BUDGET_MS - 1 : CHAIN_SEARCH_BUDGET_MS)
    const result = await confirmSwap({ db: db.service as never, wallet, txHash: f.hash, chainId: null }, { read: chain.read, elapsedMs })
    expect(result).toEqual({ result: 'not_found', reason: 'tx_missing', claimed: true })
    // Ethereum, then Base (started inside the budget), and not Arbitrum (the budget was spent).
    expect(chain.calls.map((c) => c.chainId)).toEqual([1, 8453])
    expect(db.rows()).toEqual([expect.objectContaining({ wallet, status: 'pending', claimed_tx_hash: f.hash.toLowerCase(), claimed_chain_id: null, token_in: null })])
    // The client asks again (or the script does): found on Arbitrum, the claim row becomes the swap's row.
    const again = await confirmSwap({ db: db.service as never, wallet, txHash: f.hash, chainId: null }, { read: recordedChainRead().read })
    expect(again).toEqual({ result: 'verified' })
    expect(db.rows()).toEqual([expect.objectContaining({ chain_id: 42161, verified_kind: 'fee_collector', claimed_tx_hash: null })])
  })
})
