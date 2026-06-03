/**
 * [SPRINT-9J J2] Bounded, retrying wrapper for the swap-BUILD step.
 *
 * `adapter.fetchSwapData` (the per-source calldata build) previously had no
 * timeout in `fetchSwapFromSource`. A slow upstream (notably Velora's
 * `/transactions/{chainId}` on Base) let the serverless function run past its
 * limit, so Vercel returned an HTML error page and the client threw
 * "Unexpected token '<' … not valid JSON".
 *
 * This wrapper bounds each attempt with a timeout and retries ONLY transient
 * failures. The build is idempotent — it produces calldata and never broadcasts
 * an on-chain tx (CoW order submission is a separate client-side step) — so a
 * retry can never double-submit. Deterministic failures (no route, insufficient
 * liquidity, 4xx) are surfaced immediately without a wasted retry.
 */
import { withTimeout } from './shared'
import {
  SWAP_BUILD_TIMEOUT_MS,
  SWAP_BUILD_MAX_ATTEMPTS,
  SWAP_BUILD_RETRY_BACKOFF_MS,
} from '@/lib/constants'

/**
 * A failure is transient (safe + worth retrying) when it is a timeout, a
 * network blip, an upstream 5xx, or a non-JSON/HTML body (CDN/maintenance page).
 * Deterministic outcomes (no route, insufficient liquidity, 4xx, unknown source)
 * are NOT retried — a retry can't change them and only burns the time budget.
 */
export function isTransientSwapError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('non-json') ||
    msg.includes('invalid response') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  )
}

export interface SwapBuildRetryOptions {
  timeoutMs?: number
  maxAttempts?: number
  backoffMs?: number
}

/** A fetch aborted via AbortController surfaces as a DOMException/Error named
 *  'AbortError'. Normalise it to the same 'Timeout' message the rest of the
 *  pipeline treats as a transient, retryable, user-friendly failure. */
function normalizeAbort(err: unknown): unknown {
  if (err instanceof Error && err.name === 'AbortError') return new Error('Timeout')
  return err
}

/**
 * Run `fn` with a per-attempt timeout + AbortSignal, retrying transient failures
 * up to `maxAttempts` total with a fixed backoff between tries.
 *
 * `fn` receives an AbortSignal — adapters that thread it into their fetches (e.g.
 * Velora) get the slow request CANCELLED when the timeout fires, not merely
 * abandoned. Adapters that ignore the signal are still bounded by the race.
 */
export async function withSwapBuildRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: SwapBuildRetryOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? SWAP_BUILD_TIMEOUT_MS
  const maxAttempts = opts.maxAttempts ?? SWAP_BUILD_MAX_ATTEMPTS
  const backoffMs = opts.backoffMs ?? SWAP_BUILD_RETRY_BACKOFF_MS

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    try {
      return await withTimeout(fn(controller.signal), timeoutMs, () => controller.abort())
    } catch (rawErr) {
      const err = normalizeAbort(rawErr)
      lastErr = err
      // Stop immediately on the last attempt or a deterministic (non-transient)
      // failure — retrying those only delays the clean JSON error to the client.
      if (attempt >= maxAttempts || !isTransientSwapError(err)) throw err
      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }
  throw lastErr
}
