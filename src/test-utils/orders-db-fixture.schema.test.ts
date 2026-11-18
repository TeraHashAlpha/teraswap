/**
 * [A87 S-4] The fixture's ORDERS_SCHEMA must be the real `orders` table. It claimed "42 columns" after PR #707 had added
 * `basket_id`, so a `*` read in a test returned fewer columns than production does. This test reads
 * contracts/order-engine/schema.sql itself (CREATE TABLE ... orders plus every `ALTER TABLE orders ADD COLUMN`), so the next
 * column added to that file fails here until the fixture follows.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORDERS_SCHEMA } from './orders-db-fixture'
import { ORDER_READ_COLUMNS } from '@/app/api/orders/order-read-columns'

const schema = readFileSync(join(process.cwd(), 'contracts/order-engine/schema.sql'), 'utf8')
const sql = schema
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n')

/** Column names of `CREATE TABLE IF NOT EXISTS orders (...)`, in file order. */
function createTableColumns(): string[] {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS orders (')
  if (start < 0) throw new Error('CREATE TABLE IF NOT EXISTS orders not found in schema.sql')
  const body = sql.slice(start).split('\n').slice(1)
  const end = body.findIndex((l) => /^\);/.test(l))
  const names: string[] = []
  for (const line of body.slice(0, end)) {
    // A column starts at exactly two spaces; continuation lines are indented deeper, table constraints start with a keyword.
    const m = /^ {2}([a-z_][a-z0-9_]*)\s+\S/.exec(line)
    if (m && !/^(constraint|check|primary|unique|foreign)$/i.test(m[1])) names.push(m[1])
  }
  return names
}

/** Columns added later with `ALTER TABLE orders ADD COLUMN [IF NOT EXISTS] name`, in file order. */
function alterColumns(): string[] {
  return [...sql.matchAll(/ALTER TABLE\s+orders\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1])
}

describe('orders-db-fixture ORDERS_SCHEMA is the orders table of contracts/order-engine/schema.sql', () => {
  const real = [...createTableColumns(), ...alterColumns()]

  it('the parser finds the table (a sanity floor, so an empty parse cannot pass)', () => {
    expect(real.length).toBeGreaterThanOrEqual(43)
    expect(real).toContain('signature')
    expect(real).toContain('basket_id')
  })

  it('has exactly the schema file\'s columns: same count, same names, same order', () => {
    expect(ORDERS_SCHEMA.length).toBe(real.length)
    expect([...ORDERS_SCHEMA]).toEqual(real)
  })

  it('has no duplicate column', () => {
    expect(new Set(ORDERS_SCHEMA).size).toBe(ORDERS_SCHEMA.length)
  })

  it('every allow-listed read column exists in the table, and `signature` is not one of them', () => {
    for (const c of ORDER_READ_COLUMNS) expect(real).toContain(c)
    expect([...ORDER_READ_COLUMNS]).not.toContain('signature')
  })
})
