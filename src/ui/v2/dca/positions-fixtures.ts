/**
 * [B7] Shared fixtures for the Positions / Orders / History parity tests: ONE set of order objects, fills, prices and a settlement receipt
 * that v1's components and v2's are both rendered against. Not a test file — `vi.mock` calls live in each test and read these through a
 * dynamic import. Nothing here signs, fetches or touches a wallet.
 */
import type { FillRow } from '@/hooks/useOrderExecutions'
import type { SettlementReceipt } from '@/lib/dca/settlement-receipt'
import { OrderType, PriceCondition, type AutonomousOrder, type OrderEngineEvent } from '@/lib/order-engine'

export const BASE = 8453
export const ARB = 42161
export const ETH = 1
export const OWNER = '0xd44d00000000000000000000000000000000962d'
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const WETH_BASE = '0x4200000000000000000000000000000000000006'
export const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
export const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'
export const VELORA = '0x6a000f20005980200259b80c5102003040001068'
export const FEED = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70'

/** 31 Oct 2026, 12:00 UTC — every test pins the clock here. */
export const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const H = 3_600_000
const D = 24 * H

type Over = Omit<Partial<AutonomousOrder>, 'order'> & { id: string; order?: Partial<AutonomousOrder['order']> }

export function order(over: Over): AutonomousOrder {
  const { order: o, ...rest } = over
  const base: AutonomousOrder = {
    id: over.id,
    orderHash: `0x${over.id.padEnd(64, '0')}`,
    signature: '0xsig',
    orderType: OrderType.DCA,
    chainId: BASE,
    order: {
      owner: OWNER,
      tokenIn: USDC_BASE,
      tokenOut: WETH_BASE,
      amountIn: 10_000_000n,
      minAmountOut: 1n,
      orderType: OrderType.DCA,
      condition: PriceCondition.ABOVE,
      targetPrice: 0n,
      priceFeed: '0x0000000000000000000000000000000000000000',
      expiry: BigInt(Math.floor((NOW + 26 * D) / 1000)),
      nonce: 3n,
      router: VELORA,
      routerDataHash: `0x${'0'.repeat(64)}`,
      dcaInterval: 86_400n,
      dcaTotal: 10n,
      ...(o ?? {}),
    } as unknown as AutonomousOrder['order'],
    status: 'active',
    tokenInSymbol: 'USDC',
    tokenInDecimals: 6,
    tokenOutSymbol: 'WETH',
    tokenOutDecimals: 18,
    dcaExecuted: 4,
    dcaTotal: 10,
    floorTier: null,
    createdAt: NOW - 4 * D - 14 * H - 53 * 60_000,
    executedAt: null,
    expiresAt: NOW + 26 * D,
    error: null,
    amountOut: null,
    txHash: null,
  } as AutonomousOrder
  return { ...base, ...rest }
}

function fill(orderId: string, n: number, atMs: number, over: Partial<FillRow> = {}): FillRow {
  return {
    id: `${orderId}-f${n}`,
    execution_number: n,
    tx_hash: `0x${String(n).repeat(8)}${orderId.replace(/[^0-9a-f]/g, 'f').padEnd(50, 'a')}9b1e4c02`.slice(0, 66),
    amount_in: '1000000',
    amount_out: String(402_000_000_000_000n + BigInt(n) * 1_000_000_000_000n),
    status: 'confirmed',
    created_at: new Date(atMs).toISOString(),
    ...over,
  }
}

// ── the orders ────────────────────────────────────────────────────────────────

/** Base, 4 of 10 daily buys, next buy in 9h 07m. */
export const A1 = order({ id: 'a1' })
/** Arbitrum, unpriced tier, nothing filled yet, wallet on Base → "Switch to Arbitrum One". */
export const A2 = order({ id: 'a2', chainId: ARB, floorTier: 'unpriced', tokenInSymbol: 'USDC', tokenOutSymbol: 'ARB', dcaExecuted: 0, dcaTotal: 3, createdAt: NOW - H, order: { tokenIn: USDC_ARB, tokenOut: '0x912ce59144191c1204e64559fe8253a0e49e6548', dcaInterval: 14_400n, amountIn: 3_000_000n } })
/** Being prepared (signing): no countdown, no cancel, no remove. */
export const A3 = order({ id: 'a3', status: 'signing', dcaExecuted: 0, dcaTotal: 3, createdAt: NOW - 60_000 })
/** Executing and due: "Buying now / Executing soon…"; one failed fill. */
export const A4 = order({ id: 'a4', status: 'executing', dcaExecuted: 2, dcaTotal: 5, floorTier: 'offchain-price', createdAt: NOW - 3 * D - H })
/** Live, but the keeper recorded an error: v1's failure banner replaces the ring. */
export const A5 = order({ id: 'a5', status: 'partially_filled', dcaExecuted: 1, dcaTotal: 4, error: 'Slippage exceeded on last attempt', createdAt: NOW - 2 * D })
export const ACTIVE = [A1, A2, A3, A4, A5]

/** Completed on Arbitrum One, 3 of 3, with a tx. Receipt eligible. */
export const H1 = order({ id: 'h1', chainId: ARB, status: 'filled', dcaExecuted: 3, dcaTotal: 3, txHash: `0xb404fee3${'1'.repeat(48)}77023768`, executedAt: NOW - 47 * D, createdAt: NOW - 47 * D - 2 * H, expiresAt: NOW - 46 * D, order: { tokenIn: USDC_ARB, tokenOut: WETH_ARB, amountIn: 3_444_909n, dcaTotal: 3n } })
/** Cancelled on Base, 1 of 3. Receipt eligible. */
export const H2 = order({ id: 'h2', status: 'cancelled', tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6, dcaExecuted: 1, dcaTotal: 3, order: { tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: 1_400_000_000_000_000n } })
/** Expired. No receipt. */
export const H3 = order({ id: 'h3', status: 'expired', dcaExecuted: 2, dcaTotal: 6, expiresAt: NOW - D })
/** Failed with no reason persisted: v1's generic reason. */
export const H4 = order({ id: 'h4', status: 'error', dcaExecuted: 0, dcaTotal: 2, error: null })
export const HISTORY = [H1, H2, H3, H4]

// ── fills (`/api/orders/:id/executions` rows) ─────────────────────────────────

export const FILLS: Record<string, FillRow[]> = {
  a1: [1, 2, 3, 4].map((n) => fill('a1', n, A1.createdAt + n * D)),
  a2: [],
  a3: [],
  a4: [fill('a4', 1, A4.createdAt + D), fill('a4', 2, A4.createdAt + 2 * D, { status: 'failed', error: 'execution reverted: slippage', amount_out: null, tx_hash: null })],
  a5: [fill('a5', 1, A5.createdAt + D)],
  h1: [1, 2, 3].map((n) => fill('h1', n, H1.createdAt + n * H, { amount_in: '1148303', amount_out: String(452_000_000_000_000n + (n === 1 ? 2_000_000_000_000n : 0n)) })),
  h2: [fill('h2', 1, H2.createdAt + D, { amount_in: '466666666666666', amount_out: '1150000' })],
  h3: [],
  h4: [],
}
const EMPTY: FillRow[] = []

/** v1's `useOrderExecutions` contract over the fixture: rows only while `enabled`, `lastFillAtMs` = the latest `created_at` (as v1). */
export function useOrderExecutionsFixture(orderId: string, _wallet: string | undefined, opts: { enabled?: boolean; latestEvent?: OrderEngineEvent | null } = {}) {
  const rows = opts.enabled === false ? EMPTY : (FILLS[orderId] ?? EMPTY)
  const last = rows.reduce((max, e) => {
    const t = e.created_at ? Date.parse(e.created_at) : NaN
    return Number.isFinite(t) && t > max ? t : max
  }, -Infinity)
  return { executions: rows, orderMeta: opts.enabled === false ? null : ((ORDER_META[orderId] as never) ?? null), lastFillAtMs: rows.length && last !== -Infinity ? last : null, loading: false }
}

/** `/api/portfolio/prices` answers (lower-cased address → USD). */
export const PRICES: Record<string, number> = { [USDC_BASE]: 1, [WETH_BASE]: 2489.11, [USDC_ARB]: 1, [WETH_ARB]: 2489.11, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 2489.11 }

/** The receipt `buildSettlementReceipt` "decodes" for H1 (the lib is mocked in the tests — it reads chain events). */
export const RECEIPT: SettlementReceipt = {
  orderHash: H1.orderHash,
  status: 'completed',
  chainId: ARB,
  tokenInSymbol: 'USDC',
  tokenOutSymbol: 'WETH',
  tokenInDecimals: 6,
  tokenOutDecimals: 18,
  networkCostLabel: 'Paid by the executor (L2 gas + L1 data fee)',
  totals: { totalInvestedRaw: '3444909', totalReceivedRaw: '1358000000000000', avgPrice: 2536.7518, totalProtocolFeeRaw: '3444', totalNetworkCostWeiRaw: '0', totalAggregationValueRaw: '1200000000000' },
  estimate: { maxSlippageBps: 300, realizedFeeBps: 9 },
  fills: FILLS.h1.map((f, i) => ({
    executionNumber: f.execution_number,
    txHash: f.tx_hash as string,
    txUrl: `https://arbiscan.io/tx/${f.tx_hash}`,
    timestamp: Date.parse(f.created_at as string),
    amountInRaw: f.amount_in as string,
    amountOutRaw: f.amount_out as string,
    effectivePrice: 2540 - i,
    protocolFeeRaw: '1148',
    networkCostWeiRaw: '0',
    nextBestOutRaw: i === 0 ? null : '451000000000000',
    nextBestSource: i === 0 ? null : 'KyberSwap',
    aggregationValueRaw: i === 0 ? null : '1000000000000',
  })),
}

// ── [B7 C2] the Orders tab: every type v1 lists ────────────────────────────────

/** Limit, Base, active: `@ $2 400.00`, live price from the feed. */
export const L1 = order({ id: 'l1', orderType: OrderType.LIMIT, dcaExecuted: 0, dcaTotal: 1, createdAt: NOW - 2 * H, expiresAt: NOW + 6 * D + 5 * H, order: { orderType: OrderType.LIMIT, condition: PriceCondition.BELOW, targetPrice: 240_000_000_000n, priceFeed: FEED, amountIn: 250_000_000n, dcaInterval: 0n, dcaTotal: 1n } })
/** Take Profit (STOP_LOSS + ABOVE), Base, active, under an hour left. */
export const T1 = order({ id: 't1', orderType: OrderType.STOP_LOSS, tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6, dcaExecuted: 0, dcaTotal: 1, createdAt: NOW - D, expiresAt: NOW + 42 * 60_000, order: { orderType: OrderType.STOP_LOSS, condition: PriceCondition.ABOVE, targetPrice: 300_000_000_000n, priceFeed: FEED, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: 500_000_000_000_000_000n, dcaInterval: 0n, dcaTotal: 1n } })
/** Stop Loss (STOP_LOSS + BELOW), Base, active, 5 h left (v1 lists it even though creation is deferred to v4). */
export const S1 = order({ id: 's1', orderType: OrderType.STOP_LOSS, tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6, dcaExecuted: 0, dcaTotal: 1, createdAt: NOW - D, expiresAt: NOW + 5 * H + 10 * 60_000, order: { orderType: OrderType.STOP_LOSS, condition: PriceCondition.BELOW, targetPrice: 200_000_000_000n, priceFeed: FEED, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: 500_000_000_000_000_000n, dcaInterval: 0n, dcaTotal: 1n } })
/** Limit, Base, filled: Executed + Received + tx, and NO per-fill rows → v1's synthetic execution entry from the order's own columns. */
export const L2 = order({ id: 'l2', orderType: OrderType.LIMIT, status: 'filled', dcaExecuted: 0, dcaTotal: 1, createdAt: NOW - 9 * D, executedAt: NOW - 8 * D, expiresAt: NOW - 2 * D, amountOut: '101000000000000000', txHash: `0x5d0a3c19${'2'.repeat(48)}b81e42c7`, order: { orderType: OrderType.LIMIT, condition: PriceCondition.BELOW, targetPrice: 245_000_000_000n, priceFeed: FEED, amountIn: 250_000_000n, dcaInterval: 0n, dcaTotal: 1n } })
/** A legacy Ethereum DCA (v2 executor), active, wallet on Base → "Switch to Ethereum". */
export const E1 = order({ id: 'e1', chainId: ETH, dcaExecuted: 1, dcaTotal: 4, order: { tokenIn: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenOut: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', router: '0x111111125421ca6dc452d289314280a0f8842a65', amountIn: 400_000_000n } })
FILLS.e1 = [fill('e1', 1, E1.createdAt + D, { amount_in: '100000000', amount_out: '40100000000000000', price_at_execution: '249000000000', gas_used: '1200000000000000' })]
FILLS.l1 = []
FILLS.t1 = []
FILLS.s1 = []
FILLS.l2 = []

/** `/api/orders/:id/executions` → `order` (v1 ExecutionTimeline's OrderMeta): the parent order's columns. */
export const ORDER_META: Record<string, Record<string, unknown>> = {
  l2: { tx_hash: L2.txHash, amount_out: L2.amountOut, gas_used: '210000000000000', executed_at: new Date(L2.executedAt as number).toISOString(), executed_price: '244800000000', dca_total: 1, dca_executed: 0 },
}

/** Every order the Orders tab lists, v1's engine order (newest last is irrelevant: the tab keeps the engine's order). */
export const ALL_ORDERS = [A1, L1, T1, S1, E1, A3, H1, L2, H2, H3, H4]
