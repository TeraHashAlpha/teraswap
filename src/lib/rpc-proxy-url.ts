/**
 * [fix/user-ip-privacy] The one address the BROWSER uses for on-chain reads: our own `/api/rpc` proxy.
 *
 * Every chain goes through it, so an RPC provider only ever sees our server's IP. Mainnet keeps the
 * bare `/api/rpc` it has always used (an absent `chainId` means mainnet to the route); every other
 * chain is `/api/rpc?chainId=<id>`.
 *
 * ABSOLUTE in the browser, on purpose. wagmi's WalletConnect connector builds the provider's `rpcMap`
 * from these transport URLs, and WalletConnect's `HttpConnection` throws
 * `Provided URL is not compatible with HTTP connection: /api/rpc` on a URL without `http(s):`. That
 * throw happens while the EVM provider is created for a freshly approved session, so with a relative
 * URL the wallet shows "connected" and the site never does. `window.location.origin + path` is the
 * same request a relative URL makes, and one WalletConnect accepts.
 *
 * Without a `window` (SSR, tests in a node environment) there is no origin to prepend and the path is
 * returned as is; server code never dials the proxy anyway (see rpc-env.ts `serverRpcUrl`).
 */
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'

/** `/api/rpc` for mainnet, `/api/rpc?chainId=<id>` for every other chain. */
export function proxyRpcPath(chainId: number = DEFAULT_CHAIN_ID): string {
  return chainId === DEFAULT_CHAIN_ID ? '/api/rpc' : `/api/rpc?chainId=${chainId}`
}

/** The proxy URL for `chainId` as the browser must address it (absolute, same origin). */
export function proxyRpcUrl(chainId: number = DEFAULT_CHAIN_ID): string {
  const path = proxyRpcPath(chainId)
  const origin = typeof window !== 'undefined' ? window.location?.origin : undefined
  // An opaque origin serialises as the string "null": nothing usable to prepend.
  return origin && origin !== 'null' ? `${origin}${path}` : path
}
