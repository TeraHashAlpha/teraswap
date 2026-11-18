/**
 * [fix/order-signature-not-returned] Tables for driving the order read routes through `fake-postgrest.ts`.
 *
 * ORDERS_SCHEMA is every column of `orders` in contracts/order-engine/schema.sql (CREATE TABLE + its ALTER TABLE ADD COLUMN
 * lines; orders-db-fixture.schema.test.ts reads that file and fails if this list drifts from it), so `select('*')` returns what production returns, `signature` included. Stored signatures here are
 * signature-SHAPED random hex (0x + 130), never a real signature.
 */
import { createFakePostgrest, type Row } from './fake-postgrest'

/** contracts/order-engine/schema.sql in file order: CREATE TABLE :18-106 (42 columns), then `basket_id` (ALTER TABLE :451, PR #707): 43. */
export const ORDERS_SCHEMA = [
  'id', 'created_at', 'updated_at', 'wallet', 'order_type', 'status',
  'token_in', 'token_in_symbol', 'token_out', 'token_out_symbol', 'amount_in', 'min_amount_out',
  'target_price', 'price_feed', 'price_condition', 'current_price', 'expiry', 'nonce',
  'signature', 'order_hash', 'dca_interval', 'dca_total', 'dca_executed', 'dca_last_exec',
  'tx_hash', 'amount_out', 'fee_amount', 'gas_used', 'executed_at', 'executed_price',
  'order_data', 'token_in_decimals', 'token_out_decimals', 'error',
  'consecutive_failures', 'last_attempt_at', 'last_infra_miss_at', 'last_infra_miss_reason',
  'floor_tier', 'floor_ack_at', 'router', 'chain_id', 'basket_id',
] as const

/** contracts/order-engine/schema.sql:118-137. */
export const EXECUTIONS_SCHEMA = [
  'id', 'order_id', 'created_at', 'execution_number', 'tx_hash', 'amount_in', 'amount_out', 'fee_amount',
  'gas_used', 'price_at_execution', 'next_best_out', 'next_best_source', 'status',
] as const

/** The `swaps` columns the history and analytics routes read (the fake only needs what `*` returns). */
export const SWAPS_SCHEMA = [
  'id', 'created_at', 'wallet', 'tx_hash', 'source', 'token_in', 'token_in_symbol', 'token_out', 'token_out_symbol',
  'amount_in', 'amount_out', 'amount_in_usd', 'fee_collected', 'fee_amount', 'status', 'chain_id',
] as const

/** The six statuses the `orders.status` CHECK allows (schema.sql:28-29). */
export const DB_ORDER_STATUSES = ['active', 'executing', 'executed', 'cancelled', 'expired', 'failed'] as const

/** Mulberry32: a tiny seeded PRNG, so every random case can be replayed from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomHex(rand: () => number, bytes: number): string {
  let s = '0x'
  for (let i = 0; i < bytes; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, '0')
  return s
}

function fakeUuid(rand: () => number): string {
  const h = randomHex(rand, 16).slice(2)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** One `orders` row with EVERY schema column set (so a `*` read would carry all of them). */
export function makeOrderRow(rand: () => number, over: Partial<Row> & { wallet: string; status: string }): Row {
  const created = new Date(Date.UTC(2026, 9, 1) + Math.floor(rand() * 40 * 86_400_000)).toISOString()
  const orderType = (['limit', 'stop_loss', 'dca'] as const)[Math.floor(rand() * 3)]
  const row: Row = {
    id: fakeUuid(rand),
    created_at: created,
    updated_at: created,
    order_type: orderType,
    token_in: randomHex(rand, 20),
    token_in_symbol: 'USDC',
    token_out: randomHex(rand, 20),
    token_out_symbol: 'WETH',
    amount_in: String(1_000_000 + Math.floor(rand() * 1e9)),
    min_amount_out: String(Math.floor(rand() * 1e15)),
    target_price: String(Math.floor(rand() * 4e11)),
    price_feed: orderType === 'dca' ? '' : randomHex(rand, 20),
    price_condition: rand() < 0.5 ? 'above' : 'below',
    current_price: String(Math.floor(rand() * 4e11)),
    expiry: 1_800_000_000 + Math.floor(rand() * 1e6),
    nonce: Math.floor(rand() * 10),
    signature: randomHex(rand, 65),
    order_hash: randomHex(rand, 32),
    dca_interval: orderType === 'dca' ? 3600 : 0,
    dca_total: orderType === 'dca' ? 5 : 1,
    dca_executed: 0,
    dca_last_exec: null,
    tx_hash: null,
    amount_out: null,
    fee_amount: null,
    gas_used: null,
    executed_at: null,
    executed_price: null,
    order_data: { owner: over.wallet, nonce: '0', orderType: orderType === 'dca' ? 2 : 0 },
    token_in_decimals: 6,
    token_out_decimals: 18,
    error: null,
    consecutive_failures: 0,
    last_attempt_at: null,
    last_infra_miss_at: null,
    last_infra_miss_reason: null,
    floor_tier: orderType === 'dca' ? 'offchain-price' : null,
    floor_ack_at: orderType === 'dca' ? created : null,
    router: randomHex(rand, 20),
    chain_id: [1, 8453, 42161][Math.floor(rand() * 3)],
    basket_id: null,
    ...over,
  }
  if (row.status === 'executed') {
    row.tx_hash = randomHex(rand, 32)
    row.amount_out = String(Math.floor(rand() * 1e15))
    row.executed_at = created
  }
  if (row.status === 'failed') row.error = 'SWAP_REVERTED'
  return row
}

export function makeExecutionRow(rand: () => number, order: Row, n: number): Row {
  return {
    id: fakeUuid(rand),
    order_id: order.id,
    created_at: order.created_at,
    execution_number: n,
    tx_hash: randomHex(rand, 32),
    amount_in: String(order.amount_in),
    amount_out: String(Math.floor(rand() * 1e15)),
    fee_amount: '0',
    gas_used: '210000',
    price_at_execution: String(order.target_price),
    next_best_out: null,
    next_best_source: null,
    status: 'confirmed',
  }
}

export function makeSwapRow(rand: () => number, wallet: string): Row {
  return {
    id: fakeUuid(rand),
    created_at: new Date(Date.UTC(2026, 9, 1) + Math.floor(rand() * 40 * 86_400_000)).toISOString(),
    wallet,
    tx_hash: randomHex(rand, 32),
    source: '1inch',
    token_in: randomHex(rand, 20),
    token_in_symbol: 'USDC',
    token_out: randomHex(rand, 20),
    token_out_symbol: 'WETH',
    amount_in: '100',
    amount_out: '0.03',
    amount_in_usd: 100,
    fee_collected: true,
    fee_amount: '0.1',
    status: 'confirmed',
    chain_id: 1,
  }
}

/** A fake database holding these tables; `missingOrderColumns` models a migration not applied. */
export function makeOrdersDb(
  tables: { orders: Row[]; order_executions?: Row[]; swaps?: Row[] },
  missingOrderColumns: readonly string[] = [],
) {
  return createFakePostgrest({
    tables: { orders: tables.orders, order_executions: tables.order_executions ?? [], swaps: tables.swaps ?? [] },
    schema: {
      orders: ORDERS_SCHEMA.filter((c) => !missingOrderColumns.includes(c)),
      order_executions: EXECUTIONS_SCHEMA,
      swaps: SWAPS_SCHEMA,
    },
    relations: { 'order_executions.orders': { table: 'orders', localKey: 'order_id', foreignKey: 'id' } },
  })
}
