// @vitest-environment node
/**
 * [ADR-029, details E] The migration text, its mirror in supabase/schema.sql, and the fake database the route tests
 * run on, all read from the SQL files themselves, so the three can not drift apart:
 *   - every statement of the migration is in schema.sql, in the same order;
 *   - the migration is additive: it rewrites, deletes and drops nothing, and has the pieces details E names;
 *   - the fake's column and NOT NULL lists are the `swaps` table those files describe.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SWAPS_CLAIM_COLUMNS, SWAPS_COLUMNS_AFTER, SWAPS_COLUMNS_BEFORE, SWAPS_NOT_NULL_AFTER, SWAPS_NOT_NULL_BEFORE, SWAPS_SIDE_COLUMNS } from './fake-swaps-db'

const ROOT = process.cwd()
const MIGRATION = 'supabase/migrations/20261125120000_swaps_verified.sql'
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** The SQL of a file without its comments (whole lines and the `-- ...` tail of a line), whitespace collapsed. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('--')
      return comment === -1 ? line : line.slice(0, comment)
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

const migration = read(MIGRATION)
const migrationCode = code(migration)
const schema = read('supabase/schema.sql')
const schemaCode = code(schema)

describe('the migration is mirrored in schema.sql', () => {
  it('every statement of the migration is in schema.sql, verbatim and in order', () => {
    expect(migrationCode.length).toBeGreaterThan(400)
    expect(schemaCode).toContain(migrationCode)
  })

  it('the mirror comes after the CREATE TABLE it alters', () => {
    expect(schemaCode.indexOf('CREATE TABLE IF NOT EXISTS swaps (')).toBeGreaterThanOrEqual(0)
    expect(schemaCode.indexOf(migrationCode)).toBeGreaterThan(schemaCode.indexOf('CREATE TABLE IF NOT EXISTS swaps ('))
  })
})

describe('the migration is what details E asks for', () => {
  it('nullable columns, added only if absent: the two of details E and the three claim columns of 133b K', () => {
    expect(migrationCode).toContain('ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;')
    expect(migrationCode).toContain('ALTER TABLE swaps ADD COLUMN IF NOT EXISTS verified_kind TEXT;')
    expect(migrationCode).toContain('ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_tx_hash TEXT;')
    expect(migrationCode).toContain('ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_chain_id INTEGER;')
    expect(migrationCode).toContain('ALTER TABLE swaps ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;')
    // CHANGED (133b K): exactly five ADD COLUMN, was two.
    expect([...migrationCode.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1])).toEqual([
      'verified_at', 'verified_kind', ...SWAPS_CLAIM_COLUMNS,
    ])
    expect(migrationCode).not.toMatch(/ADD COLUMN[^;]*NOT NULL/)
    expect(migrationCode).not.toMatch(/ADD COLUMN[^;]*DEFAULT/)
  })

  it('a CHECK on exactly the three kinds, NULL allowed', () => {
    expect(migrationCode).toContain("CHECK (verified_kind IS NULL OR verified_kind IN ('fee_collector', 'router', 'cow')) NOT VALID;")
    expect(migrationCode).toContain('ALTER TABLE swaps VALIDATE CONSTRAINT swaps_verified_kind_check;')
  })

  it('a partial unique index on (chain_id, lower(tx_hash), lower(wallet)) where verified_at is not null', () => {
    // CHANGED (133b K, ADR-029 7.4): the key now includes lower(wallet); it was (chain_id, lower(tx_hash)).
    expect(migrationCode).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_swaps_verified_tx ON swaps (chain_id, lower(tx_hash), lower(wallet)) WHERE verified_at IS NOT NULL;')
    expect([...migrationCode.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(1)
  })

  it('NOT NULL dropped on the six side columns and on nothing else', () => {
    const dropped = [...migrationCode.matchAll(/ALTER COLUMN ([a-z_]+) DROP NOT NULL/g)].map((m) => m[1])
    expect(dropped).toEqual([...SWAPS_SIDE_COLUMNS])
  })

  it('no existing row is rewritten: no UPDATE, DELETE, TRUNCATE, DROP or data-changing statement in it', () => {
    for (const forbidden of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /\bDROP TABLE\b/i, /\bDROP COLUMN\b/i, /\bINSERT\b/i, /\bSET NOT NULL\b/i, /\bUSING\b/i, /\bPOLICY\b/i, /\bGRANT\b/i, /\bREVOKE\b/i]) {
      expect(migrationCode, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('the lock wait is bounded, and a rollback is written out', () => {
    expect(migrationCode).toContain("SET lock_timeout = '5s';")
    expect(migrationCode).toContain('RESET lock_timeout;')
    expect(migration).toMatch(/-- ROLLBACK/)
    expect(migration).toMatch(/NOT run against any database/)
  })
})

describe('the fake database is the `swaps` table of the SQL files', () => {
  const files = ['supabase/schema.sql', 'supabase/improvements.sql', ...readdirSync(join(ROOT, 'supabase/migrations')).sort().map((f) => `supabase/migrations/${f}`)]
  const all = files.map((f) => code(read(f)))

  /** Column names and NOT NULL of `CREATE TABLE IF NOT EXISTS swaps (...)`. */
  function createTable(): Array<{ name: string; notNull: boolean }> {
    const lines = schema.split('\n')
    const start = lines.findIndex((l) => l.startsWith('CREATE TABLE IF NOT EXISTS swaps ('))
    const end = lines.findIndex((l, i) => i > start && /^\);/.test(l))
    const out: Array<{ name: string; notNull: boolean }> = []
    for (const line of lines.slice(start + 1, end)) {
      const m = /^ {2}([a-z_][a-z0-9_]*)\s+\S/.exec(line)
      if (m) out.push({ name: m[1], notNull: /NOT NULL|PRIMARY KEY/.test(line.split('--')[0]) })
    }
    return out
  }

  /** Columns later added to swaps with ADD COLUMN, across every SQL file, with their NOT NULL. */
  function added(): Array<{ name: string; notNull: boolean }> {
    const out: Array<{ name: string; notNull: boolean }> = []
    for (const sql of all) {
      for (const statement of sql.split(';').filter((s) => /ALTER TABLE swaps\b/.test(s))) {
        // One clause per ADD COLUMN: its text runs to the next ADD COLUMN (a type such as NUMERIC(12,4) has a comma).
        for (const clause of statement.split(/ADD COLUMN /).slice(1)) {
          const m = /^(?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)(.*)$/.exec(clause)
          if (m && !out.some((c) => c.name === m[1])) out.push({ name: m[1], notNull: /NOT NULL/.test(m[2]) })
        }
      }
    }
    return out
  }

  it('columns after the migration', () => {
    const real = [...createTable(), ...added()].map((c) => c.name)
    expect(real.length).toBeGreaterThanOrEqual(26)
    expect([...SWAPS_COLUMNS_AFTER].sort()).toEqual([...real].sort())
  })

  it('columns before the migration: the same without the five new ones', () => {
    // CHANGED (133b K): five new columns, was two.
    const added = new Set<string>(['verified_at', 'verified_kind', ...SWAPS_CLAIM_COLUMNS])
    expect([...SWAPS_COLUMNS_BEFORE].sort()).toEqual(SWAPS_COLUMNS_AFTER.filter((c) => !added.has(c)).sort())
  })

  it('NOT NULL before and after', () => {
    const before = [...createTable(), ...added()].filter((c) => c.notNull).map((c) => c.name)
    expect([...SWAPS_NOT_NULL_BEFORE].sort()).toEqual([...before].sort())
    expect([...SWAPS_NOT_NULL_AFTER].sort()).toEqual(before.filter((c) => !(SWAPS_SIDE_COLUMNS as readonly string[]).includes(c)).sort())
  })
})
