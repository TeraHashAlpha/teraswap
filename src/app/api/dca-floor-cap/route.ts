/**
 * GET /api/dca-floor-cap?chainId=N — the effective per-buy USD cap for a no-price DCA fill.
 * min(keeper_runtime_config.no_price_fill_cap_usd for that chain, DCA_NO_PRICE_FILL_CAP_MAX_USD);
 * the ceiling when there is no row or the read fails. Read-only: the web app never writes the table.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD, effectiveNoPriceCapUsd } from '@/lib/order-engine/dca-floor-tier'

export async function GET(req: NextRequest) {
  const chainId = Number(req.nextUrl.searchParams.get('chainId'))
  const ceiling = { maxUsd: DCA_NO_PRICE_FILL_CAP_MAX_USD }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: 'Invalid chainId' }, { status: 400 })
  }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ ...ceiling, effectiveUsd: ceiling.maxUsd })
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await supabase
      .from('keeper_runtime_config')
      .select('no_price_fill_cap_usd')
      .eq('chain_id', chainId)
      .maybeSingle()
    return NextResponse.json({ ...ceiling, effectiveUsd: effectiveNoPriceCapUsd(data?.no_price_fill_cap_usd) })
  } catch {
    return NextResponse.json({ ...ceiling, effectiveUsd: ceiling.maxUsd })
  }
}
