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
 * BROWSER order is unchanged: `NEXT_PUBLIC_*` -> the public default.
 *
 * Every env read below is a LITERAL `process.env.NAME` (see `readEnv`). Next inlines
 * `NEXT_PUBLIC_*` into the client bundle only for literal member access; a computed
 * `process.env[name]` would come back `undefined` in the browser.
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

/** Literal env reads only — see the header note on NEXT_PUBLIC inlining. */
function readEnv(name: string): string | undefined {
  switch (name) {
    case 'RPC_URL_1': return process.env.RPC_URL_1
    case 'RPC_URL_8453': return process.env.RPC_URL_8453
    case 'RPC_URL_42161': return process.env.RPC_URL_42161
    case 'RPC_URL': return process.env.RPC_URL
    case 'NEXT_PUBLIC_RPC_URL': return process.env.NEXT_PUBLIC_RPC_URL
    case 'NEXT_PUBLIC_BASE_RPC_URL': return process.env.NEXT_PUBLIC_BASE_RPC_URL
    case 'NEXT_PUBLIC_ARBITRUM_RPC_URL': return process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL
    default: return undefined
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
  if (typeof window !== 'undefined' || loggedChains.has(chainId)) return
  loggedChains.add(chainId)
  console.info(`rpc: chain=${chainId} source=${rpcEnvSource(chainId)}`)
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

/** The URL the BROWSER env holds for `chainId`, or `undefined` when unset. */
export function browserRpcEnvUrl(chainId: number): string | undefined {
  const name = BROWSER_NAMES[chainId]
  return name ? readEnv(name) || undefined : undefined
}

/** Browser RPC URL for `chainId`: `NEXT_PUBLIC_*`, else the public default. Throws on an unknown chain. */
export function browserRpcUrl(chainId: number): string {
  const url = browserRpcEnvUrl(chainId) ?? PUBLIC_DEFAULT[chainId]
  if (!url) throw new Error(`rpc-env: no RPC resolver for chain ${chainId}`)
  return url
}
