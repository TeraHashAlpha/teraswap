/**
 * [ADR-029] The two chain reads of a swap verification, server-only.
 *
 * - The URL comes from `serverOnlyRpcUrl` (rpc-env): `RPC_URL_<id>`, never a `NEXT_PUBLIC_*` value.
 * - The endpoint must have PROVED it serves the row's chain (`eth_chainId`, cached per endpoint by
 *   rpc-chain-identity). Anything but `verified` refuses the read: here an outage is not allowed to
 *   fall through, because the answer decides whether a row becomes public.
 * - Every attempt has an explicit timeout, and there is one retry at most, whatever the first attempt ended with:
 *   an error (retried at once), or `null` (asked once more after a short pause). `null` right after a transaction
 *   confirmed is what a provider's node answers when it has not caught up with the node the browser read from; the
 *   browser sends its confirmation once, and a row left pending has no hash to find it by later. A second `null` is
 *   the answer.
 * - An error never carries the URL (provider keys live in URL paths): callers get a short code.
 */
import { assertChainIdentity, createJsonRpcChainIdProbe } from '@/lib/rpc-chain-identity'
import { serverOnlyRpcUrl } from '@/lib/rpc-env'

/** Timeout of one attempt. */
export const SWAP_VERIFY_RPC_TIMEOUT_MS = 4_000
/** Attempts per read: the first one and one retry at most. */
export const SWAP_VERIFY_RPC_ATTEMPTS = 2
/** The pause before the one retry of a read that answered `null`. */
export const SWAP_VERIFY_MISSING_RETRY_DELAY_MS = 1_500

/**
 * The pause, in milliseconds. `SWAP_VERIFY_MISSING_RETRY_MS` shortens it (the tests set 0); it can never lengthen it
 * past the default, and anything that is not a whole number of milliseconds is ignored.
 */
function missingRetryDelayMs(): number {
  const raw = process.env.SWAP_VERIFY_MISSING_RETRY_MS
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return SWAP_VERIFY_MISSING_RETRY_DELAY_MS
  return Math.min(Number(raw), SWAP_VERIFY_MISSING_RETRY_DELAY_MS)
}

export type ChainReadMethod = 'eth_getTransactionByHash' | 'eth_getTransactionReceipt'

export type ChainReadFailure = 'rpc_error' | 'rpc_wrong_chain' | 'rpc_unverified'

/** A read that produced no usable answer. `code` is one of three fixed words; there is no URL in it. */
export class ChainReadError extends Error {
  readonly code: ChainReadFailure
  constructor(code: ChainReadFailure) {
    super(code)
    this.name = 'ChainReadError'
    this.code = code
  }
}

/** Resolves with the JSON-RPC `result` (which may be `null`), or rejects with a ChainReadError. */
export type ChainRead = (chainId: number, method: ChainReadMethod, params: readonly unknown[]) => Promise<unknown>

async function postJsonRpc(url: string, method: ChainReadMethod, params: readonly unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(SWAP_VERIFY_RPC_TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!res.ok) throw new ChainReadError('rpc_error')
  const json: unknown = await res.json()
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ChainReadError('rpc_error')
  const body = json as { result?: unknown; error?: unknown }
  if (body.error !== undefined && body.error !== null) throw new ChainReadError('rpc_error')
  if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw new ChainReadError('rpc_error')
  return body.result
}

export const readChain: ChainRead = async (chainId, method, params) => {
  let url: string
  try {
    url = serverOnlyRpcUrl(chainId)
  } catch {
    throw new ChainReadError('rpc_error')
  }

  const verdict = await assertChainIdentity({
    expectedChainId: chainId,
    endpoint: url,
    probe: createJsonRpcChainIdProbe(url, { timeoutMs: SWAP_VERIFY_RPC_TIMEOUT_MS }),
    timeoutMs: SWAP_VERIFY_RPC_TIMEOUT_MS,
  })
  if (verdict.status === 'mismatch') throw new ChainReadError('rpc_wrong_chain')
  if (verdict.status !== 'verified') throw new ChainReadError('rpc_unverified')

  for (let attempt = 1; attempt <= SWAP_VERIFY_RPC_ATTEMPTS; attempt++) {
    const last = attempt === SWAP_VERIFY_RPC_ATTEMPTS
    let result: unknown
    try {
      result = await postJsonRpc(url, method, params)
    } catch {
      // Timeout, transport error, HTTP error, JSON-RPC error envelope or an unparseable body: one retry, then give up.
      if (last) break
      continue
    }
    if (result !== null || last) return result
    // "Not there (yet)": the one retry, after a pause.
    const pause = missingRetryDelayMs()
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
  }
  throw new ChainReadError('rpc_error')
}
