// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let row: unknown = null
let throws = false
const eq = vi.fn(() => ({ maybeSingle: async () => { if (throws) throw new Error('db'); return { data: row } } }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t: string) => ({ select: () => { expect(t).toBe('keeper_runtime_config'); return { eq } } }) }) }))
import { GET } from './route'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD as MAX } from '@/lib/order-engine/dca-floor-tier'

const call = async (q: string) => { const r = await GET(new NextRequest(`http://localhost/api/dca-floor-cap${q}`)); return { status: r.status, json: await r.json() } }
beforeEach(() => { row = null; throws = false; process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k' })

describe('GET /api/dca-floor-cap', () => {
  it('rejects a bad chainId', async () => { expect((await call('?chainId=abc')).status).toBe(400) })
  it('no row -> the ceiling', async () => { expect((await call('?chainId=8453')).json).toEqual({ maxUsd: MAX, effectiveUsd: MAX }) })
  it('row below MAX -> min(row, MAX)', async () => { row = { no_price_fill_cap_usd: '75' }; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(75) })
  it('row above MAX -> clamped to MAX', async () => { row = { no_price_fill_cap_usd: 5000 }; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(MAX) })
  it('db failure -> the ceiling', async () => { throws = true; expect((await call('?chainId=8453')).json.effectiveUsd).toBe(MAX) })
})
