/**
 * POST /api/monitor/validate-execution — Post-execution balance validation.
 *
 * Called after a swap is confirmed on-chain to verify the user received
 * the expected output amount. Reads the TX receipt, extracts Transfer
 * events, and compares actual vs expected.
 *
 * Auth: Bearer EXECUTOR_VALIDATION_SECRET (constant-time via shared auth helper).
 *
 * Request body:
 *   txHash            — 0x-prefixed transaction hash
 *   source            — aggregator name (e.g. '1inch', 'uniswap')
 *   recipient         — user wallet address
 *   tokenOut          — output token contract address
 *   tokenOutDecimals  — output token decimals
 *   expectedMinOutput — expected minimum output in raw token units
 *   preSwapBalance?   — optional pre-swap balance for balanceOf fallback
 *
 * Returns the validation result including severity (ok/warning/critical/unknown),
 * actual output, shortfall percentage, and extraction method.
 *
 * Critical results auto-disable the source and emit a P0 alert.
 *
 * @internal — authenticated endpoint for the executor/monitoring pipeline.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyBearerToken } from '@/lib/auth'
import { validateExecution, type ValidateExecutionParams, type ExecutionValidation } from '@/lib/post-execution-validator'
import { getSupabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 15 // Receipt fetch + RPC calls

// ── Input validation ─────────────────────────────────────

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function validateBody(body: unknown): { valid: true; params: ValidateExecutionParams } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' }
  }

  const b = body as Record<string, unknown>

  // Required fields
  if (typeof b.txHash !== 'string' || !TX_HASH_RE.test(b.txHash)) {
    return { valid: false, error: 'txHash must be a 0x-prefixed 64-char hex string' }
  }
  if (typeof b.source !== 'string' || b.source.length === 0 || b.source.length > 50) {
    return { valid: false, error: 'source must be a non-empty string (max 50 chars)' }
  }
  if (typeof b.recipient !== 'string' || !ADDRESS_RE.test(b.recipient)) {
    return { valid: false, error: 'recipient must be a valid 0x address' }
  }
  if (typeof b.tokenOut !== 'string' || !ADDRESS_RE.test(b.tokenOut)) {
    return { valid: false, error: 'tokenOut must be a valid 0x address' }
  }
  if (typeof b.tokenOutDecimals !== 'number' || !Number.isInteger(b.tokenOutDecimals) || b.tokenOutDecimals < 0 || b.tokenOutDecimals > 18) {
    return { valid: false, error: 'tokenOutDecimals must be an integer 0–18' }
  }
  if (typeof b.expectedMinOutput !== 'string' || !/^\d+$/.test(b.expectedMinOutput)) {
    return { valid: false, error: 'expectedMinOutput must be a numeric string (raw token units)' }
  }

  // Optional fields
  if (b.preSwapBalance !== undefined && (typeof b.preSwapBalance !== 'string' || !/^\d+$/.test(b.preSwapBalance))) {
    return { valid: false, error: 'preSwapBalance must be a numeric string if provided' }
  }

  return {
    valid: true,
    params: {
      txHash: b.txHash as string,
      source: b.source as string,
      recipient: b.recipient as string,
      tokenOut: b.tokenOut as string,
      tokenOutDecimals: b.tokenOutDecimals as number,
      expectedMinOutput: b.expectedMinOutput as string,
      preSwapBalance: b.preSwapBalance as string | undefined,
    },
  }
}

// ── Side-effect: persist surplus to Supabase ─────────────

async function persistSurplus(txHash: string, surplusWei: string): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) return
  try {
    const { error } = await supabase
      .from('swaps')
      .update({ mev_savings_actual: surplusWei })
      .eq('tx_hash', txHash)
    if (error) {
      // codeql[js/log-injection] Server-side log only (Vercel Function logs). txHash is a 0x-prefixed hex string validated by isValidTxHash() before reaching this code path; error.message is a Supabase client error description. Neither is rendered to a browser or downstream system that could interpret line breaks as a forged log entry.
      console.warn(`[VALIDATE-EXECUTION] surplus persist failed for ${txHash}: ${error.message}`)
    }
  } catch (err) {
    console.warn(
      `[VALIDATE-EXECUTION] surplus persist threw for ${txHash}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ── Route handler ────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<ExecutionValidation | { error: string }>> {
  // Auth: require EXECUTOR_VALIDATION_SECRET
  const secret = process.env.EXECUTOR_VALIDATION_SECRET
  if (!secret) {
    console.error('[VALIDATE-EXECUTION] EXECUTOR_VALIDATION_SECRET not configured')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Parse and validate request body
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validation = validateBody(body)
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  // Execute validation
  try {
    const result = await validateExecution(validation.params)

    // Log critical/warning results server-side for observability
    if (result.severity === 'critical') {
      console.error(`[VALIDATE-EXECUTION] CRITICAL: ${result.source} tx=${result.txHash} — ${result.reason}`)
    } else if (result.severity === 'warning') {
      // codeql[js/log-injection] Server-side log only. result.source is a known aggregator id from a closed-set enum (AggregatorName), result.txHash was validated at the request boundary, result.reason is an internal validator message — none are rendered to a browser or interpreted as commands downstream.
      console.warn(`[VALIDATE-EXECUTION] WARNING: ${result.source} tx=${result.txHash} — ${result.reason}`)
    }

    // [P117/Sprint 16B] Persist surplus to swaps.mev_savings_actual for ALL
    // sources. The PATCH endpoint at /api/log-swap already accepts this field
    // for the CoW path; we mirror the write here so non-CoW routes also get
    // surplus recorded. Fire-and-forget — never delays or fails the response.
    if (result.surplusWei) {
      void persistSurplus(result.txHash, result.surplusWei)
    }

    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    // validateExecution should never throw, but safety net
    console.error('[VALIDATE-EXECUTION] Unexpected error:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Internal validation error' },
      { status: 500 },
    )
  }
}
