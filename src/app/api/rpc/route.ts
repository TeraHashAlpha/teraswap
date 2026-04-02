import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RPC_RATE_LIMIT } from '@/lib/kv-rate-limiter'

/**
 * Privacy-preserving RPC proxy.
 *
 * All on-chain reads from the browser go through this endpoint instead
 * of hitting Alchemy/LlamaRPC directly.  This hides the user's IP
 * address from the RPC provider — they only see Vercel's server IP.
 *
 * Allowed methods (read-only): eth_call, eth_getTransactionReceipt,
 * eth_getBalance, eth_blockNumber, eth_chainId.
 * Write methods (eth_sendRawTransaction) are blocked — wallets handle those.
 */

const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_chainId',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getLogs',
])

const RPC_URL = process.env.RPC_URL
  || process.env.NEXT_PUBLIC_RPC_URL
  || 'https://eth.llamarpc.com'

export async function POST(req: NextRequest) {
  // [B-06] Rate limiting by IP — persistent via Vercel KV
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await checkRateLimit(`rpc:${ip}`, RPC_RATE_LIMIT.limit, RPC_RATE_LIMIT.windowMs)
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  try {

    const body = await req.json()

    // Support single and batch requests
    const requests = Array.isArray(body) ? body : [body]

    // Validate all methods
    for (const rpcReq of requests) {
      if (!rpcReq.method || typeof rpcReq.method !== 'string') {
        return NextResponse.json(
          { jsonrpc: '2.0', id: rpcReq?.id ?? null, error: { code: -32600, message: 'Invalid request' } },
          { status: 400 },
        )
      }

      if (!ALLOWED_METHODS.has(rpcReq.method)) {
        return NextResponse.json(
          { jsonrpc: '2.0', id: rpcReq.id, error: { code: -32601, message: `Method ${rpcReq.method} not allowed` } },
          { status: 403 },
        )
      }
    }

    // Forward to upstream RPC (without user's IP)
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(body) ? requests : requests[0]),
    })

    const data = await upstream.json()

    return NextResponse.json(data, {
      status: upstream.status,
      headers: {
        'Cache-Control': 'no-store',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal proxy error' } },
      { status: 500 },
    )
  }
}
