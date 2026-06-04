import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RPC_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { resolveProxyChainId } from '@/lib/rpc-proxy-chain'
import { getRpcUrlForChain } from '@/lib/adapters/shared'

/**
 * Privacy-preserving RPC proxy.
 *
 * All on-chain reads from the browser go through this endpoint instead
 * of hitting Alchemy/LlamaRPC directly. This hides the user's IP
 * address from the RPC provider — they only see Vercel's server IP.
 *
 * Policy: blacklist (BLOCKED_METHODS). We allow every JSON-RPC method by
 * default and explicitly reject only those that require the user's signing
 * keys — eth_sendTransaction, eth_sendRawTransaction, eth_sign,
 * eth_signTransaction, eth_signTypedData{,_v3,_v4}, personal_sign, and the
 * wallet_* family. Wagmi/viem call a wide and growing set of read methods
 * (eth_getBlockByNumber, eth_getStorageAt, eth_getProof, debug_*, trace_*,
 * net_version, web3_clientVersion, ...) — a whitelist devolves into
 * whack-a-mole. The proxy's job is to hide the user's IP and refuse to
 * relay transactions, not to police read methods. Rate limiting and
 * forwarding to the upstream RPC remain unchanged.
 *
 * Smoke test:
 *   curl -X POST http://localhost:3000/api/rpc \
 *     -H 'Content-Type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}'
 *   → expect HTTP 200 (not 403)
 */

const BLOCKED_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_requestPermissions',
  'wallet_watchAsset',
])

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

      if (BLOCKED_METHODS.has(rpcReq.method)) {
        return NextResponse.json(
          { jsonrpc: '2.0', id: rpcReq.id, error: { code: -32601, message: `Method ${rpcReq.method} not allowed via proxy` } },
          { status: 403 },
        )
      }
    }

    // [SPRINT-9P] Resolve the target chain. Absent chainId → mainnet, so existing
    // callers (POST /api/rpc with no param) are byte-identical. Validated against
    // the registry (supported chains only) and proxied to that chain's RPC via
    // getRpcUrlForChain — an off-mainnet read never silently hits the mainnet RPC.
    const resolved = resolveProxyChainId(req.nextUrl.searchParams.get('chainId'))
    if ('error' in resolved) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32602, message: resolved.error } },
        { status: 400 },
      )
    }
    const upstreamUrl = getRpcUrlForChain(resolved.chainId)

    // Forward to upstream RPC (without user's IP)
    const upstream = await fetch(upstreamUrl, {
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
