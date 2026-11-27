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

import { computeTokenAmountUsd } from '@/lib/chainlink'
import { A107_RECEIPTS, ROUND4_RECEIPTS, SWAP_RECEIPTS as R, recordedChainRead, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { trackLargeTrade, trackOracleDeviation } from '@/lib/security-tracker'
import { createFakeSwapsDb, type FakeSwapsDb } from '@/test-utils/fake-swaps-db'
import { CHAIN_SEARCH_BUDGET_MS, ORACLE_DEVIATION_WARN, confirmSwap } from './confirm'

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

describe('the oracle-deviation alert of an ETH-in router row sees both priced sides (A107 R4-1)', () => {
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'

  /** The oracle: ETH (priced as WETH) at `eth` USD, USDT at 1. Records every call the confirmation makes to the alerts. */
  function oracle(eth: number) {
    vi.mocked(computeTokenAmountUsd).mockImplementation(async (token: string, amount: string) => {
      const entry: [number, number] | null = token.toLowerCase() === WETH ? [eth, 18] : token.toLowerCase() === USDT ? [1, 6] : null
      return entry ? { usd: (Number(BigInt(amount)) / 10 ** entry[1]) * entry[0], price: entry[0], decimals: entry[1] } : null
    })
    vi.mocked(trackOracleDeviation).mockClear()
    vi.mocked(trackLargeTrade).mockClear()
  }

  async function confirmed(receipt: SwapReceiptFixture) {
    const sender = String(receipt.tx.from).toLowerCase()
    const result = await confirmSwap({ db: db.service as never, wallet: sender, txHash: receipt.hash, chainId: 1 }, { read: recordedChainRead([receipt]).read })
    expect(result).toEqual({ result: 'verified' })
    expect(db.rows()).toHaveLength(1)
    return { sender, row: db.rows()[0] }
  }

  it('the real 0x ETH -> USDT swap priced 10.80 / 10.36: the alert fires with the 4.07% between them; 10.36 is stored', async () => {
    expect(ORACLE_DEVIATION_WARN).toBe(0.02)
    oracle(1800)
    const { sender, row } = await confirmed(A107_RECEIPTS.mainnetRouterEthToUsdt)
    expect(row).toMatchObject({ verified_kind: 'router', source: '0x', token_in: NATIVE, amount_in: '6000000000000000', token_out: USDT, amount_out: '10357597', amount_in_usd: 10.36, amount_out_usd: 10.36 })
    expect(vi.mocked(trackOracleDeviation).mock.calls).toEqual([
      [{ wallet: sender, tokenIn: 'ETH', tokenOut: 'USDT', deviation: expect.closeTo((10.8 - 10.36) / 10.8, 10), amountUsd: 10.36, blocked: false }],
    ])
  })

  it('the same swap with both sides priced 10.36: no alert', async () => {
    // 0.006 ETH at 1,726.67 is 10.36002, stored as 10.36; 10.357597 USDT is 10.36.
    oracle(1726.67)
    const { row } = await confirmed(A107_RECEIPTS.mainnetRouterEthToUsdt)
    expect(row).toMatchObject({ amount_in_usd: 10.36, amount_out_usd: 10.36 })
    expect(trackOracleDeviation).not.toHaveBeenCalled()
  })

  it('the A106 half-wrap stores 34,000 and its deviation is 68,000 against 34,000; the large-trade alert is not raised', async () => {
    oracle(3400)
    const { sender, row } = await confirmed(ROUND4_RECEIPTS.mainnetHalfWrap)
    expect(row).toMatchObject({ amount_in: '20000000000000000000', amount_in_usd: 34_000, amount_out_usd: 34_000 })
    expect(vi.mocked(trackOracleDeviation).mock.calls).toEqual([
      [expect.objectContaining({ wallet: sender, deviation: (68_000 - 34_000) / 68_000, amountUsd: 34_000, blocked: false })],
    ])
    expect(trackLargeTrade).not.toHaveBeenCalled()
  })
})
