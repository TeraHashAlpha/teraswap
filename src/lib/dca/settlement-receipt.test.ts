/**
 * [FEAT-DCA-SETTLEMENT-RECEIPT] Resolver unit tests — pure math + decode against fixture receipts.
 *
 * The ACCURACY INVARIANT under test throughout: protocol fee always comes from the decoded
 * `OrderExecuted` event's `fee` field, never recomputed from amountIn/amountOut client-side.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, type Address, type Hex } from 'viem'
import {
  NETWORK_COST_LABEL,
  decodeOrderExecutedLog,
  computeEffectivePrice,
  computeNetworkCostWei,
  computeSettlementTotals,
  computeEstimateComparison,
  fetchFillReceipt,
  buildSettlementReceipt,
  _clearSettlementReceiptCache,
  computeAggregationValueRaw,
  type FillReceipt,
  type ReceiptClient,
  type FetchedReceiptLike,
} from './settlement-receipt'

const ORDER_EXECUTED_ABI = [
  {
    type: 'event',
    name: 'OrderExecuted',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'orderType', type: 'uint8', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
] as const

const EXECUTOR_ADDRESS = '0x1111111111111111111111111111111111111111' as Address
const OTHER_ADDRESS = '0x9999999999999999999999999999999999999999' as Address
const ORDER_HASH = ('0x' + 'ab'.repeat(32)) as Hex
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const TOKEN_IN = '0x3333333333333333333333333333333333333333' as Address
const TOKEN_OUT = '0x4444444444444444444444444444444444444444' as Address

function makeOrderExecutedLog(opts: {
  address?: Address
  amountIn: bigint
  amountOut: bigint
  fee: bigint
  orderType?: number
}) {
  const topics = encodeEventTopics({
    abi: ORDER_EXECUTED_ABI,
    eventName: 'OrderExecuted',
    args: { orderHash: ORDER_HASH, owner: OWNER, orderType: opts.orderType ?? 2 },
  })
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [TOKEN_IN, TOKEN_OUT, opts.amountIn, opts.amountOut, opts.fee],
  )
  return { address: opts.address ?? EXECUTOR_ADDRESS, data, topics: topics as readonly Hex[] }
}

function makeTransferLog(address: Address = TOKEN_IN): { address: string; data: Hex; topics: readonly Hex[] } {
  // A plausible ERC-20 Transfer(address,address,uint256) log — different topic0, must be skipped.
  return {
    address,
    data: ('0x' + '0'.repeat(63) + '1') as Hex,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex,
      ('0x' + '0'.repeat(24) + OWNER.slice(2)) as Hex,
      ('0x' + '0'.repeat(24) + TOKEN_IN.slice(2)) as Hex,
    ],
  }
}

describe('decodeOrderExecutedLog', () => {
  it('decodes a real OrderExecuted log, exact fee/amounts (never recomputed)', () => {
    const log = makeOrderExecutedLog({ amountIn: 1_000_000n, amountOut: 500_000n, fee: 1_000n })
    const decoded = decodeOrderExecutedLog(log)
    expect(decoded).toEqual({
      orderHash: ORDER_HASH,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
      amountOut: 500_000n,
      fee: 1_000n,
    })
  })

  it('returns null for a non-OrderExecuted log (e.g. an ERC-20 Transfer in the same tx)', () => {
    expect(decodeOrderExecutedLog(makeTransferLog())).toBeNull()
  })

  it('filters by allowed executor address — a log from an unrelated contract is skipped', () => {
    const log = makeOrderExecutedLog({ address: OTHER_ADDRESS, amountIn: 1n, amountOut: 1n, fee: 1n })
    expect(decodeOrderExecutedLog(log, [EXECUTOR_ADDRESS])).toBeNull()
    expect(decodeOrderExecutedLog(log, [OTHER_ADDRESS])).not.toBeNull()
  })

  it('with no allowedAddresses filter, decodes regardless of emitting address', () => {
    const log = makeOrderExecutedLog({ address: OTHER_ADDRESS, amountIn: 1n, amountOut: 1n, fee: 1n })
    expect(decodeOrderExecutedLog(log, [])).not.toBeNull()
  })
})

describe('computeEffectivePrice', () => {
  it('is invested-per-received, decimals adjusted (cost-basis convention, matches position-stats.ts)', () => {
    // 100 tokenIn (18 dec) -> 50 tokenOut (18 dec) => 2 tokenIn per tokenOut.
    const price = computeEffectivePrice(100_000000000000000000n, 50_000000000000000000n, 18, 18)
    expect(price).toBeCloseTo(2, 9)
  })

  it('is null when amountOut is zero (division by zero is not "free")', () => {
    expect(computeEffectivePrice(1000n, 0n, 18, 18)).toBeNull()
  })
})

describe('computeNetworkCostWei', () => {
  it('gasUsed x effectiveGasPrice, no L1 fee', () => {
    expect(computeNetworkCostWei({ gasUsed: 150_000n, effectiveGasPrice: 1_000_000_000n })).toBe(150_000_000_000_000n)
  })

  it('adds an L1 data fee when the receipt carries one (OP-stack extension)', () => {
    expect(computeNetworkCostWei({ gasUsed: 150_000n, effectiveGasPrice: 1_000_000_000n, l1Fee: 5_000_000_000_000n })).toBe(
      155_000_000_000_000n,
    )
  })

  it('ignores a non-bigint l1Fee (defensive — real receipts either have a bigint or nothing)', () => {
    expect(computeNetworkCostWei({ gasUsed: 100n, effectiveGasPrice: 10n, l1Fee: null })).toBe(1000n)
  })
})

describe('computeSettlementTotals', () => {
  const fill = (overrides: Partial<FillReceipt>): FillReceipt => ({
    executionNumber: 1,
    txHash: '0xaaa',
    txUrl: 'https://etherscan.io/tx/0xaaa',
    timestamp: 1_700_000_000_000,
    amountInRaw: '0',
    amountOutRaw: '0',
    effectivePrice: null,
    protocolFeeRaw: '0',
    networkCostWeiRaw: '0',
    nextBestOutRaw: null,
    nextBestSource: null,
    aggregationValueRaw: null,
    ...overrides,
  })

  it('sums raw BigInt amounts across fills exactly (never float-summed)', () => {
    const fills = [
      fill({ amountInRaw: '1000000', amountOutRaw: '500000', protocolFeeRaw: '1000', networkCostWeiRaw: '100000000000000' }),
      fill({ amountInRaw: '2000000', amountOutRaw: '1000000', protocolFeeRaw: '2000', networkCostWeiRaw: '200000000000000' }),
    ]
    const totals = computeSettlementTotals(fills, { tokenInDecimals: 6, tokenOutDecimals: 6 })
    expect(totals.totalInvestedRaw).toBe('3000000')
    expect(totals.totalReceivedRaw).toBe('1500000')
    expect(totals.totalProtocolFeeRaw).toBe('3000')
    expect(totals.totalNetworkCostWeiRaw).toBe('300000000000000')
    expect(totals.avgPrice).toBeCloseTo(2, 9) // 3 invested / 1.5 received
  })

  it('an empty fills array (zero-fill cancelled position) totals to all zero, avgPrice null', () => {
    const totals = computeSettlementTotals([], { tokenInDecimals: 18, tokenOutDecimals: 18 })
    expect(totals).toEqual({
      totalInvestedRaw: '0',
      totalReceivedRaw: '0',
      avgPrice: null,
      totalProtocolFeeRaw: '0',
      totalNetworkCostWeiRaw: '0',
      totalAggregationValueRaw: null,
    })
  })
})

describe('computeEstimateComparison', () => {
  it('realized fee bps = total fee / total invested, in bps', () => {
    const totals = computeSettlementTotals(
      [
        {
          executionNumber: 1,
          txHash: '0x1',
          txUrl: '',
          timestamp: null,
          amountInRaw: '1000000',
          amountOutRaw: '500000',
          effectivePrice: null,
          protocolFeeRaw: '2000', // 0.2% of 1_000_000
          networkCostWeiRaw: '0',
          nextBestOutRaw: null,
          nextBestSource: null,
          aggregationValueRaw: null,
        },
      ],
      { tokenInDecimals: 6, tokenOutDecimals: 6 },
    )
    const estimate = computeEstimateComparison(totals, { maxSlippageBps: 300 })
    expect(estimate.maxSlippageBps).toBe(300)
    expect(estimate.realizedFeeBps).toBe(20) // 2000/1000000 * 10000 = 20 bps
  })

  it('null realizedFeeBps and passthrough null maxSlippageBps when nothing was invested', () => {
    const totals = computeSettlementTotals([], { tokenInDecimals: 18, tokenOutDecimals: 18 })
    const estimate = computeEstimateComparison(totals, {})
    expect(estimate.realizedFeeBps).toBeNull()
    expect(estimate.maxSlippageBps).toBeNull()
  })
})

// ── Async orchestration — fetchFillReceipt / buildSettlementReceipt, chain client injected ──

function makeFakeClient(byTxHash: Record<string, FetchedReceiptLike>): ReceiptClient {
  return {
    getTransactionReceipt: async ({ hash }) => {
      const r = byTxHash[hash]
      if (!r) throw new Error(`no fixture receipt for ${hash}`)
      return r
    },
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  }
}

describe('fetchFillReceipt', () => {
  it('decodes the OrderExecuted log from the receipt and computes network cost + timestamp', async () => {
    const log = makeOrderExecutedLog({ amountIn: 1_000_000n, amountOut: 500_000n, fee: 1_000n })
    const client = makeFakeClient({
      '0xfill1': {
        gasUsed: 150_000n,
        effectiveGasPrice: 1_000_000_000n,
        blockNumber: 123n,
        logs: [makeTransferLog(), log],
      },
    })

    const receipt = await fetchFillReceipt(client, {
      chainId: 8453,
      txHash: '0xfill1',
      executionNumber: 1,
      tokenInDecimals: 6,
      tokenOutDecimals: 6,
      executorAddresses: [EXECUTOR_ADDRESS],
    })

    expect(receipt).not.toBeNull()
    expect(receipt!.protocolFeeRaw).toBe('1000') // exact event field, not recomputed
    expect(receipt!.amountInRaw).toBe('1000000')
    expect(receipt!.amountOutRaw).toBe('500000')
    expect(receipt!.networkCostWeiRaw).toBe((150_000n * 1_000_000_000n).toString())
    expect(receipt!.timestamp).toBe(1_700_000_000_000)
    expect(receipt!.txUrl).toContain('0xfill1')
  })

  it('returns null when the receipt has no decodable OrderExecuted log for the allowed executors', async () => {
    const client = makeFakeClient({
      '0xnotours': { gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [makeTransferLog()] },
    })
    const receipt = await fetchFillReceipt(client, {
      chainId: 8453,
      txHash: '0xnotours',
      executionNumber: 1,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      executorAddresses: [EXECUTOR_ADDRESS],
    })
    expect(receipt).toBeNull()
  })

  it('falls back to the Supabase-provided timestamp when getBlock throws', async () => {
    const log = makeOrderExecutedLog({ amountIn: 1n, amountOut: 1n, fee: 0n })
    const client: ReceiptClient = {
      getTransactionReceipt: async () => ({ gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [log] }),
      getBlock: async () => { throw new Error('rpc down') },
    }
    const receipt = await fetchFillReceipt(client, {
      chainId: 8453,
      txHash: '0xfill2',
      executionNumber: 1,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      executorAddresses: [],
      fallbackTimestampMs: 1_650_000_000_000,
    })
    expect(receipt!.timestamp).toBe(1_650_000_000_000)
  })
})

describe('buildSettlementReceipt', () => {
  beforeEach(() => _clearSettlementReceiptCache())

  it('assembles totals + estimate for a completed position (happy path)', async () => {
    const log1 = makeOrderExecutedLog({ amountIn: 1_000_000n, amountOut: 500_000n, fee: 1_000n })
    const log2 = makeOrderExecutedLog({ amountIn: 1_000_000n, amountOut: 480_000n, fee: 1_000n })
    const client = makeFakeClient({
      '0xf1': { gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 1n, logs: [log1] },
      '0xf2': { gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 2n, logs: [log2] },
    })

    const receipt = await buildSettlementReceipt({
      orderHash: '0xorder1',
      status: 'completed',
      chainId: 8453,
      tokenInSymbol: 'USDC',
      tokenOutSymbol: 'WETH',
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      maxSlippageBps: 300,
      fills: [
        { executionNumber: 1, txHash: '0xf1' },
        { executionNumber: 2, txHash: '0xf2' },
      ],
      getClient: () => client,
      executorAddresses: [EXECUTOR_ADDRESS],
    })

    expect(receipt.fills).toHaveLength(2)
    expect(receipt.totals.totalInvestedRaw).toBe('2000000')
    expect(receipt.totals.totalProtocolFeeRaw).toBe('2000')
    expect(receipt.estimate.maxSlippageBps).toBe(300)
    expect(receipt.networkCostLabel).toBe(NETWORK_COST_LABEL)
  })

  it('a cancelled position with partial fills produces a receipt over just those fills', async () => {
    const log1 = makeOrderExecutedLog({ amountIn: 1_000_000n, amountOut: 500_000n, fee: 1_000n })
    const client = makeFakeClient({
      '0xf1': { gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 1n, logs: [log1] },
    })

    const receipt = await buildSettlementReceipt({
      orderHash: '0xorder2',
      status: 'cancelled',
      chainId: 8453,
      tokenInSymbol: 'USDC',
      tokenOutSymbol: 'WETH',
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      fills: [{ executionNumber: 1, txHash: '0xf1' }],
      getClient: () => client,
      executorAddresses: [EXECUTOR_ADDRESS],
    })

    expect(receipt.status).toBe('cancelled')
    expect(receipt.fills).toHaveLength(1)
    expect(receipt.totals.totalInvestedRaw).toBe('1000000')
  })

  it('a zero-fill cancelled position (cancelled before any fill) produces an all-zero receipt', async () => {
    const receipt = await buildSettlementReceipt({
      orderHash: '0xorder3',
      status: 'cancelled',
      chainId: 8453,
      tokenInSymbol: 'USDC',
      tokenOutSymbol: 'WETH',
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      fills: [],
      getClient: () => makeFakeClient({}),
    })

    expect(receipt.fills).toHaveLength(0)
    expect(receipt.totals.totalInvestedRaw).toBe('0')
    expect(receipt.totals.avgPrice).toBeNull()
    expect(receipt.estimate.realizedFeeBps).toBeNull()
  })

  it('caches the assembled receipt per orderHash — a second call does not re-fetch', async () => {
    const log1 = makeOrderExecutedLog({ amountIn: 1n, amountOut: 1n, fee: 0n })
    let calls = 0
    const client: ReceiptClient = {
      getTransactionReceipt: async () => {
        calls++
        return { gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [log1] }
      },
      getBlock: async () => ({ timestamp: 1n }),
    }

    const params = {
      orderHash: '0xorder-cache',
      status: 'completed' as const,
      chainId: 8453,
      tokenInSymbol: 'USDC',
      tokenOutSymbol: 'WETH',
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      fills: [{ executionNumber: 1, txHash: '0xf1' }],
      getClient: () => client,
      executorAddresses: [EXECUTOR_ADDRESS],
    }

    await buildSettlementReceipt(params)
    await buildSettlementReceipt(params)
    expect(calls).toBe(1)
  })
})

// ── [CHORE-DCA-AGGREGATION-VALUE] Aggregation value: best route vs next-best source ──
describe('computeAggregationValueRaw — gross-vs-gross, always >= 0, honest on missing data', () => {
  it('is the exact difference when our output beats the runner-up', () => {
    expect(computeAggregationValueRaw('1000', '950')).toBe('50')
  })

  it('is "0" (never negative) when our output is BELOW the runner-up — clamped, not fabricated', () => {
    // The deviation guard bounds this to a small window, but nothing guarantees our committed
    // route beats every single quote every single round; clamp rather than show a demoralizing
    // (or dishonest-looking) negative "value".
    expect(computeAggregationValueRaw('900', '950')).toBe('0')
  })

  it('is "0" when exactly equal', () => {
    expect(computeAggregationValueRaw('1000', '1000')).toBe('0')
  })

  it('is null when there was no runner-up at all (single-source round) — never a fabricated number', () => {
    expect(computeAggregationValueRaw('1000', null)).toBeNull()
  })

  it('is null on malformed input (never throws)', () => {
    expect(computeAggregationValueRaw('1000', 'not-a-number')).toBeNull()
    expect(computeAggregationValueRaw('not-a-number', '950')).toBeNull()
  })
})

describe('fetchFillReceipt — threads next_best_out/source through verbatim (no on-chain derivation)', () => {
  it('carries nextBestOutRaw/nextBestSource and computes aggregationValueRaw when present', async () => {
    const log = makeOrderExecutedLog({ amountIn: 100n, amountOut: 1000n, fee: 1n })
    const client: ReceiptClient = {
      getTransactionReceipt: async () => ({ gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [log] }),
      getBlock: async () => ({ timestamp: 1n }),
    }
    const fill = await fetchFillReceipt(client, {
      chainId: 8453, txHash: '0xf1', executionNumber: 1,
      tokenInDecimals: 18, tokenOutDecimals: 18,
      executorAddresses: [EXECUTOR_ADDRESS],
      nextBestOutRaw: '900', nextBestSource: '1inch',
    })
    expect(fill?.nextBestOutRaw).toBe('900')
    expect(fill?.nextBestSource).toBe('1inch')
    expect(fill?.aggregationValueRaw).toBe('100') // 1000 - 900
  })

  it('is null/null/null when no runner-up was recorded for this fill', async () => {
    const log = makeOrderExecutedLog({ amountIn: 100n, amountOut: 1000n, fee: 1n })
    const client: ReceiptClient = {
      getTransactionReceipt: async () => ({ gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [log] }),
      getBlock: async () => ({ timestamp: 1n }),
    }
    const fill = await fetchFillReceipt(client, {
      chainId: 8453, txHash: '0xf1', executionNumber: 1,
      tokenInDecimals: 18, tokenOutDecimals: 18,
      executorAddresses: [EXECUTOR_ADDRESS],
    })
    expect(fill?.nextBestOutRaw).toBeNull()
    expect(fill?.nextBestSource).toBeNull()
    expect(fill?.aggregationValueRaw).toBeNull()
  })
})

describe('computeSettlementTotals — total aggregation value, honest when no fill has data', () => {
  const base = {
    executionNumber: 1, txHash: '0xf', txUrl: '', timestamp: null,
    amountInRaw: '100', amountOutRaw: '1000', effectivePrice: null,
    protocolFeeRaw: '1', networkCostWeiRaw: '0',
  }

  it('sums aggregation value across fills that have it, ignoring fills that don\'t', () => {
    const fills: FillReceipt[] = [
      { ...base, nextBestOutRaw: '900', nextBestSource: '1inch', aggregationValueRaw: '100' },
      { ...base, nextBestOutRaw: null, nextBestSource: null, aggregationValueRaw: null },
      { ...base, nextBestOutRaw: '950', nextBestSource: '0x', aggregationValueRaw: '50' },
    ]
    const totals = computeSettlementTotals(fills, { tokenInDecimals: 18, tokenOutDecimals: 18 })
    expect(totals.totalAggregationValueRaw).toBe('150')
  })

  it('is null (not "0") when NO fill has any comparison data — honest "—", not a fabricated zero', () => {
    const fills: FillReceipt[] = [
      { ...base, nextBestOutRaw: null, nextBestSource: null, aggregationValueRaw: null },
    ]
    const totals = computeSettlementTotals(fills, { tokenInDecimals: 18, tokenOutDecimals: 18 })
    expect(totals.totalAggregationValueRaw).toBeNull()
  })

  it('is null for an empty fills array', () => {
    const totals = computeSettlementTotals([], { tokenInDecimals: 18, tokenOutDecimals: 18 })
    expect(totals.totalAggregationValueRaw).toBeNull()
  })
})
