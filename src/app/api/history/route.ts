import { NextResponse, type NextRequest } from 'next/server'
import { getSupabase } from '@/lib/supabase'

/**
 * GET /api/history?wallet=0x...&limit=50
 *
 * Fetch swap history for a specific wallet.
 */
export async function GET(req: NextRequest) {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ swaps: [], total: 0 })
  }

  const { searchParams } = req.nextUrl
  const wallet = searchParams.get('wallet')?.toLowerCase()
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100)
  const offset = Number(searchParams.get('offset') ?? '0')

  if (!wallet) {
    return NextResponse.json(
      { error: 'Missing required param: wallet' },
      { status: 400 },
    )
  }

  try {
    const { data, error, count } = await supabase
      .from('swaps')
      .select('*', { count: 'exact' })
      .eq('wallet', wallet)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error('[history] Supabase error:', error.message)
      return NextResponse.json({ swaps: [], total: 0 })
    }

    return NextResponse.json({
      swaps: data ?? [],
      total: count ?? 0,
    })
  } catch (err) {
    console.error('[history] Error:', err)
    return NextResponse.json({ swaps: [], total: 0 })
  }
}
