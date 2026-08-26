import { NextRequest, NextResponse } from 'next/server'
import { bodySizeGuard, RPC_MAX_BODY_BYTES } from '@/lib/body-limit'
import { checkRateLimit, RPC_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { resolveProxyChainId } from '@/lib/rpc-proxy-chain'
import { getRpcUrlForChain } from '@/lib/adapters/shared'
import { trustedClientIp } from '@/lib/trusted-ip'
import { isExpensiveMethod, exceedsBatchLimit, clampGetLogsRange, MAX_RPC_BATCH_SIZE } from '@/lib/rpc-cost-policy'
import { assertChainIdentity, createJsonRpcChainIdProbe } from '@/lib/rpc-chain-identity'

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
 * (eth_getBlockByNumber, eth_getStorageAt, eth_getProof, net_version,
 * web3_clientVersion, ...) — a whitelist devolves into whack-a-mole. The
 * proxy's job is to hide the user's IP and refuse to relay transactions, not
 * to police read methods.
 *
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] Cost-policy exception to that stance
 * (rpc-cost-policy.ts): `debug_*`/`trace_*` are archive-grade queries with no
 * legitimate use in this app's read surface (unlike the methods above, which
 * ARE used) — proxying them to the paid upstream on the app's dime is pure
 * amplification, so they're denied outright. An `eth_getLogs` numeric block
 * range is CLAMPED (not rejected) so the call still works, just bounded. A
 * request batch is capped at MAX_RPC_BATCH_SIZE. Rate limiting and forwarding
 * otherwise remain unchanged.
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The proxy also proves the upstream IS the chain the caller
 * asked for. `NEXT_PUBLIC_ARBITRUM_RPC_URL` held a BASE endpoint from 2026-08-05 to 2026-08-26,
 * so `?chainId=42161` answered `eth_chainId` = `0x2105` with HTTP 200 and a well-formed envelope
 * for three weeks. Nothing logged, because to every layer here it looked like a healthy answer:
 * resolveProxyChainId validated the PARAM against the registry, and nobody ever asked the
 * upstream what it was. A mismatch is now a 502 that names both chain ids and forwards nothing;
 * an unreachable upstream is an outage rather than a lie and behaves exactly as it does today.
 * The verdict is cached per (chain, upstream) for the life of the instance — see
 * rpc-chain-identity.ts — so there is no extra round-trip on a per-request basis.
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
  // [AUDIT-W6 / W6-L-01] Oversized body -> 413 (256 KB: large eth_call payloads pass).
  const tooLarge = bodySizeGuard(req, RPC_MAX_BODY_BYTES)
  if (tooLarge) return tooLarge
  // [B-06] Rate limiting by IP — persistent via Vercel KV
  // [CHORE-API-HARDENING-2 / P3a] Trusted IP — see trusted-ip.ts.
  const ip = trustedClientIp(req)
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
    let requests = Array.isArray(body) ? body : [body]

    // [CHORE-API-HARDENING-2 / P3c] Cap batch size before any per-request work.
    if (exceedsBatchLimit(requests.length)) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32005, message: `Batch too large (max ${MAX_RPC_BATCH_SIZE} requests)` } },
        { status: 400 },
      )
    }

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

      // [CHORE-API-HARDENING-2 / P3c] debug_*/trace_* archive queries — deny
      // outright (no legitimate use in this app's read surface).
      if (isExpensiveMethod(rpcReq.method)) {
        return NextResponse.json(
          { jsonrpc: '2.0', id: rpcReq.id, error: { code: -32601, message: `Method ${rpcReq.method} not allowed via proxy (archive query)` } },
          { status: 403 },
        )
      }
    }

    // [CHORE-API-HARDENING-2 / P3c] Clamp any oversized eth_getLogs block range
    // (rewrites fromBlock so the call still succeeds, just bounded).
    requests = requests.map((rpcReq: { method?: unknown; params?: unknown }) => clampGetLogsRange(rpcReq).request)

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

    // [FIX-RPC-CHAIN-IDENTITY-GUARD] Prove the upstream serves the chain we resolved BEFORE any
    // of the caller's traffic reaches it. Verified once per (chain, upstream) per instance and
    // cached, so this is not a round-trip per request.
    //
    // Only `mismatch` blocks. `unverified` means we could not get an answer at all (timeout, 5xx,
    // JSON-RPC error, garbage) — an outage proves nothing about identity, and refusing on it
    // would turn every provider blip into a hard app outage, so it falls through as it does today.
    const identity = await assertChainIdentity({
      expectedChainId: resolved.chainId,
      endpoint: upstreamUrl,
      probe: createJsonRpcChainIdProbe(upstreamUrl),
    })
    if (identity.status === 'mismatch') {
      // 502: the upstream is not what it claims. -32006 is a server-defined JSON-RPC error in the
      // reserved -32000..-32099 range, distinct from the proxy's own -32603 internal error so a
      // client (and a log search) can tell a misrouted chain from a proxy fault.
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32006, message: identity.message } },
        { status: 502, headers: { 'Cache-Control': 'no-store' } },
      )
    }

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
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal proxy error' } },
      { status: 500 },
    )
  }
}
