/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] One resolver for "which RPC URL does this code use", per chain,
 * with the server and the browser asking for different things.
 *
 * WHY. Server code (API routes, monitor tick, adapters, chain-verify) used to resolve its RPC
 * from the BROWSER envs (`NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_BASE_RPC_URL` /
 * `NEXT_PUBLIC_ARBITRUM_RPC_URL`). The browser key is getting an Alchemy domain allowlist, which
 * rejects origin-less server requests ("Unspecified origin not on whitelist", seen 29-30 Oct), so
 * the server needs its own key.
 *
 * SERVER order, per chain (first non-empty wins):
 *   1. `RPC_URL_<chainId>`   — RPC_URL_1 / RPC_URL_8453 / RPC_URL_42161
 *   2. `RPC_URL`             — LEGACY server name, mainnet ONLY. It has always meant "the mainnet
 *                              RPC"; letting it answer for Base/Arbitrum would point those chains
 *                              at mainnet (the exact silent-lie class rpc-chain-identity guards).
 *   3. `NEXT_PUBLIC_*`       — the old browser env, kept as a fallback so an unset RPC_URL_<id>
 *                              behaves byte-identically to before this change.
 *   4. the public default the callers already use (mainnet: llamarpc; Base/Arbitrum: the registry
 *      fallbacks — see `serverRpcUrl`).
 *
 * BROWSER: [fix/user-ip-privacy] the browser no longer dials a provider on any chain — every read
 * goes to our own `/api/rpc` proxy (rpc-proxy-url.ts). `browserRpcEnvUrl` / `browserRpcUrl` remain
 * for the server-side diagnostics that report which legacy names are still set.
 *
 * `NEXT_PUBLIC_BASE_RPC_URL` and `NEXT_PUBLIC_ARBITRUM_RPC_URL` are DEPRECATED: the names are kept
 * as the step-3 server fallback only, and they are read through `readServerOnly` — a COMPUTED
 * `process.env[name]`. Next inlines `NEXT_PUBLIC_*` into the client bundle only for a literal member
 * access, so a literal read here shipped the provider URL (and the key in its path) to every visitor.
 * The computed read is never inlined: the value stays on the server, and in the browser it is simply
 * `undefined`. Set `RPC_URL_8453` / `RPC_URL_42161` and delete the two NEXT_PUBLIC names.
 *
 * Every other env read below is a LITERAL `process.env.NAME` (see `readEnv`).
 *
 * Names only: this module never logs, returns or throws a URL value (provider keys live in the
 * URL path). `rpcEnvSource` and the `rpc: chain=<id> source=<NAME>` line carry the NAME.
 */

/** Public endpoint used when nothing is configured (matches what callers fell back to before). */
const PUBLIC_DEFAULT: Readonly<Record<number, string>> = {
  1: 'https://eth.llamarpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
}

const SERVER_NAMES: Readonly<Record<number, readonly string[]>> = {
  1: ['RPC_URL_1', 'RPC_URL', 'NEXT_PUBLIC_RPC_URL'],
  8453: ['RPC_URL_8453', 'NEXT_PUBLIC_BASE_RPC_URL'],
  42161: ['RPC_URL_42161', 'NEXT_PUBLIC_ARBITRUM_RPC_URL'],
}

const BROWSER_NAMES: Readonly<Record<number, string>> = {
  1: 'NEXT_PUBLIC_RPC_URL',
  8453: 'NEXT_PUBLIC_BASE_RPC_URL',
  42161: 'NEXT_PUBLIC_ARBITRUM_RPC_URL',
}

/** Source label when no env var is set and the public default answers. */
export const RPC_SOURCE_DEFAULT = 'public-default'

/** The server-only env name for a chain (`RPC_URL_<id>`), for docs / validation. */
export function serverRpcEnvName(chainId: number): string {
  return `RPC_URL_${chainId}`
}

/** Chains this resolver knows about. */
export const RPC_ENV_CHAIN_IDS: readonly number[] = [1, 8453, 42161]

/** Deprecated L2 browser env names — kept as a SERVER fallback, never inlined into a client chunk. */
const DEPRECATED_L2_PUBLIC_NAMES: readonly string[] = ['NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_ARBITRUM_RPC_URL']

/**
 * Server-only read of a deprecated L2 name. The member access is COMPUTED on purpose (see the header):
 * the bundler cannot inline it, so no client chunk carries the value. `name` only ever comes from the
 * static list above.
 */
function readServerOnly(name: string): string | undefined {
  if (typeof window !== 'undefined') return undefined
  return DEPRECATED_L2_PUBLIC_NAMES.includes(name) ? process.env[name] : undefined
}

/** Literal env reads, except the two deprecated L2 names — see the header note on NEXT_PUBLIC inlining. */
function readEnv(name: string): string | undefined {
  switch (name) {
    case 'RPC_URL_1': return process.env.RPC_URL_1
    case 'RPC_URL_8453': return process.env.RPC_URL_8453
    case 'RPC_URL_42161': return process.env.RPC_URL_42161
    case 'RPC_URL': return process.env.RPC_URL
    case 'NEXT_PUBLIC_RPC_URL': return process.env.NEXT_PUBLIC_RPC_URL
    default: return readServerOnly(name)
  }
}

/** Name of the first set (non-empty) env var in `names`, or undefined. `||` semantics, as before. */
function firstSet(names: readonly string[] | undefined): string | undefined {
  return names?.find((n) => !!readEnv(n))
}

/** Which env NAME the SERVER uses for `chainId`, or `public-default` when none is set. */
export function rpcEnvSource(chainId: number): string {
  return firstSet(SERVER_NAMES[chainId]) ?? RPC_SOURCE_DEFAULT
}

// One `rpc: chain=<id> source=<NAME>` line per chain per process (first server resolution).
const loggedChains = new Set<number>()

function logSourceOnce(chainId: number): void {
  if (typeof window !== 'undefined') return
  // [CodeQL js/log-injection] Never log the caller's value: resolve it to the matching entry of the
  // static supported-chain list (1 / 8453 / 42161). An unsupported or hostile id finds nothing and
  // is dropped, so only a static literal reaches the logger, the source NAME comes from the static
  // SERVER_NAMES table, and `loggedChains` can never hold more than RPC_ENV_CHAIN_IDS.length ids.
  const known = RPC_ENV_CHAIN_IDS.find((id) => id === chainId)
  if (known === undefined || loggedChains.has(known)) return
  loggedChains.add(known)
  console.info(`rpc: chain=${known} source=${rpcEnvSource(known)}`)
}

/** Test-only: forget which chains already logged their source. */
export function _resetRpcSourceLog(): void {
  loggedChains.clear()
}

/**
 * The URL the SERVER has configured for `chainId` (see order above), or `undefined` when no env
 * var is set — callers then keep their own public default, which is what makes "all unset"
 * byte-identical to the pre-split behaviour.
 */
export function serverRpcEnvUrl(chainId: number): string | undefined {
  logSourceOnce(chainId)
  const name = firstSet(SERVER_NAMES[chainId])
  return name ? readEnv(name) : undefined
}

/** Server RPC URL for `chainId`: configured env, else the public default. Throws on an unknown chain. */
export function serverRpcUrl(chainId: number): string {
  const url = serverRpcEnvUrl(chainId) ?? PUBLIC_DEFAULT[chainId]
  if (!url) throw new Error(`rpc-env: no RPC resolver for chain ${chainId}`)
  return url
}

/**
 * The value of the legacy `NEXT_PUBLIC_*` name for `chainId`, or `undefined` when unset. Mainnet's is
 * still inlined (the server-side wagmi transport reads it); the two L2 names resolve on the server only
 * and are `undefined` in the browser (see the header). Used by server diagnostics, not to pick a transport.
 */
export function browserRpcEnvUrl(chainId: number): string | undefined {
  const name = BROWSER_NAMES[chainId]
  return name ? readEnv(name) || undefined : undefined
}

/** Legacy `NEXT_PUBLIC_*` value for `chainId`, else the public default. Throws on an unknown chain.
 *  The browser itself reads through `/api/rpc` (rpc-proxy-url.ts), not through this. */
export function browserRpcUrl(chainId: number): string {
  const url = browserRpcEnvUrl(chainId) ?? PUBLIC_DEFAULT[chainId]
  if (!url) throw new Error(`rpc-env: no RPC resolver for chain ${chainId}`)
  return url
}
