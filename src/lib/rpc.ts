import { createPublicClient, http, custom, type PublicClient, type EIP1193RequestFn } from 'viem'
import { mainnet } from 'viem/chains'

/**
 * Privacy-preserving RPC client.
 *
 * All on-chain reads go through /api/rpc (our server-side proxy)
 * so the user's real IP is never exposed to Alchemy/LlamaRPC.
 *
 * In server-side context (SSR / API routes), calls go direct to RPC_URL
 * since there's no user IP to protect.
 */

const isServer = typeof window === 'undefined'

/** Server-side RPC URL — only used in API routes / SSR */
const DIRECT_RPC_URL = process.env.RPC_URL
  || process.env.NEXT_PUBLIC_RPC_URL
  || 'https://eth.llamarpc.com'

/**
 * Custom EIP-1193 transport that routes requests through /api/rpc.
 * Falls back to direct RPC if the proxy is unreachable.
 */
function proxyTransport() {
  return custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })

      if (!res.ok) {
        // Fallback to direct RPC if proxy fails (e.g. rate limited)
        const fallback = await fetch(DIRECT_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        const fallbackData = await fallback.json()
        if (fallbackData.error) throw new Error(fallbackData.error.message)
        return fallbackData.result
      }

      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      return data.result
    },
  } as { request: EIP1193RequestFn })
}

/**
 * Get a privacy-preserving viem PublicClient.
 *
 * - Browser: routes through /api/rpc proxy (user IP hidden)
 * - Server: calls RPC directly (no user IP to hide)
 */
export function getPrivateClient(): PublicClient {
  if (isServer) {
    return createPublicClient({
      chain: mainnet,
      transport: http(DIRECT_RPC_URL),
    })
  }

  return createPublicClient({
    chain: mainnet,
    transport: proxyTransport(),
  })
}

/**
 * Get the RPC URL for proxy-aware use.
 * In browser context, returns /api/rpc.
 * In server context, returns the direct RPC URL.
 */
export function getRpcUrl(): string {
  if (isServer) return DIRECT_RPC_URL
  return '/api/rpc'
}
