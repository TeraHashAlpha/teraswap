/**
 * [fix/server-builds-order-data] An in-memory `orders` table for POST /api/orders tests, standing in for
 * @supabase/supabase-js at the network edge (use: vi.mock('@supabase/supabase-js', () => import('@/test-utils/orders-memory-db'))).
 *
 * It answers exactly the calls the route makes, and refuses any other shape:
 *   rpc('check_order_rate_limit')                                       → true
 *   from('orders').select('id').eq('wallet', w).or('signature.ilike.<t>,…').limit(n).abortSignal(s)
 *                                                                       → rows with wallet === w AND any ilike term
 *   from('orders').insert(row).select().single()                        → UNIQUE (order_hash) as schema.sql:114
 */
export const db = {
  rows: [] as Record<string, unknown>[],
  /** Every lookup the route sent: its `or` filter, its wallet, how many rows it found. */
  lookups: [] as { filter: string; wallet: string; found: number }[],
  lookupError: null as null | { message: string },
  reset() {
    this.rows.length = 0
    this.lookups.length = 0
    this.lookupError = null
  },
}

/** PostgREST `ilike`: case-insensitive, whole value; `%` and `*` match any run, `_` one character. */
function ilike(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${re}$`, 'is').test(value)
}

export function createClient() {
  return {
    rpc: async (fn: string) => {
      if (fn !== 'check_order_rate_limit') throw new Error(`unexpected rpc ${fn}`)
      return { data: true, error: null }
    },
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select: (cols: string) => ({
          eq: (column: string, wallet: string) => ({
            or: (filter: string) => ({
              limit: (n: number) => ({
                abortSignal: async (signal: AbortSignal) => {
                  if (cols !== 'id' || column !== 'wallet') throw new Error(`unexpected lookup ${cols} / ${column}`)
                  if (!(signal instanceof AbortSignal)) throw new Error('the lookup must carry an AbortSignal')
                  const terms = filter.split(',').map((term) => {
                    const m = /^signature\.ilike\.(.*)$/s.exec(term)
                    if (!m) throw new Error(`unexpected filter term ${term}`)
                    return m[1]
                  })
                  if (db.lookupError) return { data: null, error: db.lookupError }
                  const hits = db.rows.filter((r) => r.wallet === wallet && terms.some((t) => ilike(r.signature, t)))
                  db.lookups.push({ filter, wallet, found: hits.length })
                  return { data: hits.slice(0, n).map((r) => ({ id: r.id })), error: null }
                },
              }),
            }),
          }),
        }),
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (db.rows.some((r) => r.order_hash === row.order_hash)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "unique_order_hash"' } }
              }
              // A JSONB round trip, as PostgREST stores and returns it.
              const stored = JSON.parse(JSON.stringify({ id: `row-${db.rows.length + 1}`, ...row })) as Record<string, unknown>
              db.rows.push(stored)
              return { data: stored, error: null }
            },
          }),
        }),
      }
    },
  }
}
