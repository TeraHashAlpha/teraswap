import { getSupabase } from './supabase'

// ══════════════════════════════════════════════════════════
//  SERVER-SIDE WALLET ACTIVITY TRACKER
//
//  IMPORTANT: This module runs ONLY on the server (API routes).
//  Never import from client components.
//
//  All inserts are fire-and-forget (non-blocking).
//  Follows the same pattern as security-tracker.ts.
// ══════════════════════════════════════════════════════════

interface WalletActionParams {
  category: 'swap' | 'approval' | 'quote' | 'order' | 'ui' | 'error'
  action: string
  source?: string
  tokenIn?: string
  tokenOut?: string
  amountUsd?: number
  success?: boolean
  errorCode?: string
  errorMsg?: string
  txHash?: string
  orderId?: string
  durationMs?: number
  metadata?: Record<string, unknown>
}

/**
 * Fire-and-forget insert into wallet_activity (server-side only).
 * Called from API routes that already have wallet context.
 */
export function trackWalletAction(wallet: string, params: WalletActionParams): void {
  const sb = getSupabase()
  if (!sb || !wallet) return

  Promise.resolve(
    sb.from('wallet_activity').insert({
      wallet: wallet.toLowerCase(),
      session_id: null, // server-side has no session
      category: params.category,
      action: params.action,
      source: params.source ?? null,
      token_in: params.tokenIn ?? null,
      token_out: params.tokenOut ?? null,
      amount_usd: params.amountUsd ?? null,
      success: params.success ?? null,
      error_code: params.errorCode ?? null,
      error_msg: params.errorMsg ?? null,
      tx_hash: params.txHash ?? null,
      order_id: params.orderId ?? null,
      duration_ms: params.durationMs ?? null,
      metadata: params.metadata ?? {},
    })
  ).then(({ error }) => {
    if (error) console.error('[wallet-activity] Insert error:', error.message)
  }).catch(() => {
    // Silently fail — tracking should never break the main flow
  })
}
