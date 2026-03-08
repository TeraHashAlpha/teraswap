import { NextResponse, type NextRequest } from 'next/server'
import { getSupabase } from '@/lib/supabase'

/**
 * POST /api/log-swap
 *
 * Fire-and-forget endpoint to log swap executions to Supabase.
 * If Supabase is not configured, returns 200 silently.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase()
    if (!supabase) {
      console.warn('[log-swap] Supabase not configured — swap NOT logged. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.')
      return NextResponse.json({ ok: false, skipped: true, reason: 'supabase_not_configured' })
    }

    const body = await req.json()

    const {
      wallet,
      txHash,
      chainId = 1,
      source,
      tokenIn,
      tokenInSymbol,
      tokenOut,
      tokenOutSymbol,
      amountIn,
      amountOut,
      amountInUsd,
      amountOutUsd,
      slippage = 0.5,
      mevProtected = false,
      feeCollected = false,
      feeAmount,
      status = 'pending',
    } = body

    if (!wallet || !source || !tokenIn || !tokenOut || !amountIn || !amountOut) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      )
    }

    const { error } = await supabase.from('swaps').insert({
      wallet: wallet.toLowerCase(),
      tx_hash: txHash ?? null,
      chain_id: chainId,
      source,
      token_in: tokenIn.toLowerCase(),
      token_in_symbol: tokenInSymbol,
      token_out: tokenOut.toLowerCase(),
      token_out_symbol: tokenOutSymbol,
      amount_in: amountIn,
      amount_out: amountOut,
      amount_in_usd: amountInUsd ?? null,
      amount_out_usd: amountOutUsd ?? null,
      slippage,
      mev_protected: mevProtected,
      fee_collected: feeCollected,
      fee_amount: feeAmount ?? null,
      status,
    })

    if (error) {
      console.error('[log-swap] Supabase insert error:', error.message, error.details, error.hint)
      return NextResponse.json({ ok: false, error: error.message })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[log-swap] Error:', err)
    return NextResponse.json({ ok: false, error: String(err) })
  }
}

/**
 * PATCH /api/log-swap
 *
 * Update a swap record after tx confirmation (add tx_hash, gas, status).
 */
export async function PATCH(req: NextRequest) {
  try {
    const supabase = getSupabase()
    if (!supabase) {
      console.warn('[log-swap] PATCH skipped — Supabase not configured')
      return NextResponse.json({ ok: false, skipped: true, reason: 'supabase_not_configured' })
    }

    const body = await req.json()
    const { txHash, status, gasUsed, gasPrice, wallet } = body

    if (!txHash) {
      return NextResponse.json(
        { error: 'txHash is required' },
        { status: 400 },
      )
    }

    const update: Record<string, unknown> = { status, tx_hash: txHash }
    if (gasUsed) update.gas_used = gasUsed
    if (gasPrice) update.gas_price = gasPrice

    // Try 1: Match by tx_hash (row already has the hash)
    const { data: matched, error: err1 } = await supabase
      .from('swaps')
      .update(update)
      .eq('tx_hash', txHash)
      .select('id')

    if (err1) {
      console.error('[log-swap] PATCH by tx_hash error:', err1.message)
    }

    // Try 2: If no row matched (initial log had tx_hash=null), find latest pending for this wallet
    if ((!matched || matched.length === 0) && wallet) {
      const { error: err2 } = await supabase
        .from('swaps')
        .update(update)
        .eq('wallet', wallet.toLowerCase())
        .eq('status', 'pending')
        .is('tx_hash', null)
        .order('created_at', { ascending: false })
        .limit(1)

      if (err2) {
        console.error('[log-swap] PATCH by wallet fallback error:', err2.message)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[log-swap] PATCH Error:', err)
    return NextResponse.json({ ok: true })
  }
}
