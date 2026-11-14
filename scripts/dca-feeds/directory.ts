/**
 * [feat/dca-feed-candidates-weekly] The ONE place that knows where Chainlink's public feed directory lives.
 * Shared by batch.ts (monthly batch) and candidates.ts (weekly candidate list). READ-ONLY: one HTTPS GET.
 *
 * Host and paths are fixed here; nothing from argv, env or the network ever reaches the URL.
 * No import of the DCA config: safe to load before the config-file guards in batch.ts run.
 */

/** Chainlink's public reference-data directory. */
export const DIRECTORY_HOST = 'reference-data-directory.vercel.app'
export const DIRECTORY_PATH: Readonly<Record<number, string>> = {
  8453: '/feeds-ethereum-mainnet-base-1.json',
  42161: '/feeds-ethereum-mainnet-arbitrum-1.json',
}
export const DIRECTORY_TIMEOUT_MS = 30_000

/** The directory URL of a chain, or null when the chain has no directory file. */
export function directoryUrl(chainId: number): string | null {
  const path = DIRECTORY_PATH[chainId]
  return path ? `https://${DIRECTORY_HOST}${path}` : null
}

/**
 * Fetch and shape-check the directory of one chain. THROWS on any failure: callers must fail, never continue with an empty list.
 * Only "a non-empty JSON list" is checked here; each entry's fields are validated by the rules of batch-lib / candidates-lib.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchDirectory(chainId: number): Promise<any[]> {
  const url = directoryUrl(chainId)
  if (!url) throw new Error(`no directory file for chain ${chainId}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`directory fetch failed: HTTP ${res.status}`)
  const directory: unknown = await res.json()
  if (!Array.isArray(directory) || directory.length === 0) throw new Error('the directory answer is not a non-empty list')
  return directory
}
