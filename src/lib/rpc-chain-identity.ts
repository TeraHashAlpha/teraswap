/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] Prove an RPC endpoint IS the chain its config claims.
 *
 * THE INCIDENT. `NEXT_PUBLIC_ARBITRUM_RPC_URL` held a BASE endpoint from 2026-08-05 to
 * 2026-08-26. `/api/rpc?chainId=42161` answered `eth_chainId` = `0x2105` (Base) with HTTP 200 and
 * a well-formed JSON-RPC envelope. Every Arbitrum read — the Chainlink feed hook in the browser,
 * the token-import path on the server — was answered by a different chain, silently, for three
 * weeks. Nothing logged an error, because nothing WAS an error: every layer below saw a healthy
 * 200 with valid hex in it.
 *
 * A stale RPC is an outage and shouts. A misidentified RPC is a lie and does not. We fall through
 * outages; we must never fall through a lie. So this module draws exactly one line:
 *
 *   • MISMATCH   — the endpoint answered, and it is provably NOT the chain we asked for.
 *                  FAIL CLOSED, loudly, naming both chain ids. The response is never passed
 *                  through. This is the one case that must never degrade quietly.
 *   • UNVERIFIED — we could not get an answer at all: timeout, 5xx, JSON-RPC error, garbage.
 *                  That is an OUTAGE, not a lie. It proves nothing about identity, so the caller
 *                  keeps today's behaviour and falls through to its configured fallback.
 *
 * Malformed answers land in UNVERIFIED deliberately. A refusal must name both ids, and "garbage"
 * is not an id — a node that cannot answer `eth_chainId` has not proven it is a different chain,
 * only that it is unhealthy, which is the outage case. See docs/feedback for the write-up.
 *
 * SHAPE. This follows the keeper's boot gate (contracts/order-engine/executor/chain-verify.js)
 * rather than inventing a second dialect: the same `eth_chainId`-vs-configured-id check, the same
 * injected-probe port so the verification is testable without mocking a transport, the same
 * bounded timeout, and the same refusal-names-both-values message style. It deliberately does NOT
 * copy the keeper's fail-closed-on-everything stance: the keeper is a one-shot boot gate for a
 * fund-moving process, this runs on a read path that already has a fallback ladder, and the goal
 * here is to separate the lie from the outage rather than to refuse both.
 *
 * COST. `assertChainIdentity` verifies ONCE per (chain, endpoint) per process and caches the
 * verdict — there is never a round-trip on a per-request basis. Concurrent callers share a single
 * in-flight probe. See the TTL constants below for the re-verification intervals and why.
 */
import { sanitizeUpstreamError } from '@/lib/sanitize-error'

/**
 * How long a VERIFIED verdict stands before we ask again. 30 minutes.
 *
 * What can invalidate it: an ops edit to an RPC env var (on Vercel that ships a new deployment,
 * i.e. a new process, which re-verifies from cold regardless), or a provider silently re-pointing
 * a URL at another chain — which is what happened here, and is the only case a TTL can catch.
 * 30 minutes bounds that exposure to minutes instead of the three WEEKS the incident ran, while
 * costing one extra round-trip per chain per half hour on a warm instance — nothing measurable
 * against the request volume it covers.
 */
export const CHAIN_IDENTITY_VERIFIED_TTL_MS = 30 * 60_000

/**
 * How long a MISMATCH verdict stands before we ask again. 60 seconds.
 *
 * SHORTER than the verified TTL, and that asymmetry is the point: while it stands we refuse from
 * cache (fail closed with no round-trip, so a lying endpoint cannot be turned into a request
 * amplifier), but once ops corrects the endpoint the app recovers within a minute on its own. A
 * sticky refusal would need a redeploy to clear, which is a second outage bolted onto the first.
 */
export const CHAIN_IDENTITY_MISMATCH_TTL_MS = 60_000

/**
 * How long an UNVERIFIED verdict stands before we ask again. 30 seconds.
 *
 * Short, because this is the one verdict that lets traffic through unproven — we want to be back
 * asking soon. Not zero, because re-probing on every request during a provider outage would put
 * exactly the per-request round-trip this module promises to avoid onto the hot path, at the
 * worst possible moment.
 */
export const CHAIN_IDENTITY_UNVERIFIED_TTL_MS = 30_000

/** Bounded wait for a single probe. An endpoint that accepts and then goes silent must not hang. */
export const CHAIN_IDENTITY_PROBE_TIMEOUT_MS = 6_000

export type ChainIdentityVerdict =
  | { status: 'verified'; expectedChainId: number; reportedChainId: number }
  | { status: 'mismatch'; expectedChainId: number; reportedChainId: number; message: string }
  | { status: 'unverified'; expectedChainId: number; reason: string }

/** Thrown by callers that must fail closed (the guarded viem transport). Never thrown from here. */
export class ChainIdentityError extends Error {
  readonly expectedChainId: number
  readonly reportedChainId: number

  constructor(expectedChainId: number, reportedChainId: number, message?: string) {
    super(message ?? chainIdentityMismatchMessage(expectedChainId, reportedChainId))
    this.name = 'ChainIdentityError'
    this.expectedChainId = expectedChainId
    this.reportedChainId = reportedChainId
  }
}

/**
 * The refusal line, in the keeper's style: name both values, say what to do, say what we refused.
 *
 * The endpoint URL is DELIBERATELY absent. RPC URLs routinely carry the provider key in the path
 * (`…/v2/<key>`) or the userinfo (`https://ops:<key>@host`), and this string reaches both a server
 * log and a client-facing JSON body. The two chain ids are the whole diagnosis; the URL is the one
 * thing an operator already has in front of them.
 */
export function chainIdentityMismatchMessage(
  expectedChainId: number,
  reportedChainId: number,
): string {
  return (
    `RPC/chain mismatch — the RPC configured for chain ${expectedChainId} reports chain ` +
    `${reportedChainId}. Refusing to use it: an endpoint that answers for another chain returns ` +
    `wrong balances, wrong prices and wrong token metadata with no error at all. Point the ` +
    `chain-${expectedChainId} RPC URL at chain ${expectedChainId}.`
  )
}

/**
 * Only a positive, safe-integer chain id is an id. `eth_chainId` over JSON-RPC answers with a hex
 * string (`0x2105`); viem's `getChainId` action answers with a number; a raw client can answer
 * with a bigint. Everything else — `0x`, `0`, a float, an object — is not an id, and the caller
 * must treat it as "no answer", never as a different chain.
 */
export function normalizeChainId(raw: unknown): number | null {
  if (typeof raw === 'bigint') {
    return raw > 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : null
  }
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const parsed = /^0x[0-9a-fA-F]+$/.test(trimmed)
      ? Number.parseInt(trimmed, 16)
      : /^\d+$/.test(trimmed)
        ? Number.parseInt(trimmed, 10)
        : Number.NaN
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/** The injected port: resolve with whatever the endpoint says `eth_chainId` is, or reject. */
export type ChainIdProbe = () => Promise<unknown>

const errText = (err: unknown): string =>
  sanitizeUpstreamError(err instanceof Error ? err.message : String(err))

/**
 * [CodeQL js/log-injection] The barrier this file's two `console.*` sinks read through.
 *
 * `verdict.reason` (the unverified path) is genuinely upstream — it can carry the endpoint URL
 * verbatim (a JSON-RPC error envelope's `message`, a transport rejection's `.message`), and that
 * URL can carry a provider key in its path or query. `errText` above already runs it through
 * `sanitizeUpstreamError` (secrets: URL path/query, Bearer tokens, key/secret/token/password
 * assignments) before it is stored on the verdict — but that redaction does not touch `\r`/`\n`,
 * because it was written for a CLIENT-facing error body (sanitize-error.ts is shared and
 * read-only here), where a literal newline is cosmetic, not a forged log line. A raw newline
 * surviving into a `console.*` call is exactly what CodeQL's log-injection query is right to flag
 * regardless: upstream text with an embedded `\n[chain-identity] fake verdict` could otherwise
 * masquerade as a second, independent log entry. So every upstream-derived string is routed
 * through sanitizeUpstreamError AGAIN (idempotent — it already was, once) immediately adjacent to
 * its `console.*` call, then has any `\r`/`\n` neutralized, right here at the sink.
 *
 * `verdict.message` (the mismatch path) is composed by US, not upstream — it is routed through
 * this same barrier so the scanner sees one consistent pattern at both sinks, but by construction
 * it contains no URL, no Bearer token, no key/secret/token/password/authorization assignment, and
 * no newline, so this is a no-op on it: pinned byte-for-byte by a test.
 */
const forLog = (text: string): string => sanitizeUpstreamError(text).replace(/[\r\n]/g, ' ')

/** Reject if `run()` has not settled within `timeoutMs` — an accepted-then-silent endpoint. */
function withProbeTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve().then(run)
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chain-identity probe timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Ask an endpoint which chain it serves and compare. Pure: no cache, no logging, never throws —
 * it always returns a verdict, so a caller cannot accidentally collapse the lie into the outage
 * by catching one error type and not the other.
 */
export async function verifyChainIdentity({
  expectedChainId,
  probe,
  timeoutMs = CHAIN_IDENTITY_PROBE_TIMEOUT_MS,
}: {
  expectedChainId: number
  probe: ChainIdProbe
  timeoutMs?: number
}): Promise<ChainIdentityVerdict> {
  let raw: unknown
  try {
    raw = await withProbeTimeout(probe, timeoutMs)
  } catch (err) {
    return { status: 'unverified', expectedChainId, reason: errText(err) }
  }

  const reportedChainId = normalizeChainId(raw)
  if (reportedChainId === null) {
    // Garbage is not a chain id. It proves the endpoint is unhealthy, not that it is another
    // chain — and a refusal we cannot substantiate with a second number is not a refusal.
    return {
      status: 'unverified',
      expectedChainId,
      reason: 'the endpoint returned a malformed eth_chainId',
    }
  }

  if (reportedChainId !== expectedChainId) {
    return {
      status: 'mismatch',
      expectedChainId,
      reportedChainId,
      message: chainIdentityMismatchMessage(expectedChainId, reportedChainId),
    }
  }

  return { status: 'verified', expectedChainId, reportedChainId }
}

// ── Verdict cache: once per (chain, endpoint) per process ────────────────────────────────────
interface CacheEntry {
  verdict: ChainIdentityVerdict
  expiresAt: number
}

/**
 * A Map (never a plain object) so an endpoint string can't reach a prototype property, and keyed
 * by chain AND endpoint so re-pointing a URL is a cache MISS rather than a stale pass.
 */
const verdictCache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ChainIdentityVerdict>>()

function ttlFor(status: ChainIdentityVerdict['status']): number {
  if (status === 'verified') return CHAIN_IDENTITY_VERIFIED_TTL_MS
  if (status === 'mismatch') return CHAIN_IDENTITY_MISMATCH_TTL_MS
  return CHAIN_IDENTITY_UNVERIFIED_TTL_MS
}

/** Test-only: drop every cached verdict so cases cannot leak into one another. */
export function __resetChainIdentityCache(): void {
  verdictCache.clear()
  inFlight.clear()
}

/**
 * The cached guard. Verify this (chain, endpoint) pair if we have no fresh verdict for it, then
 * answer from cache. Never throws — the caller decides what to do with each verdict, because the
 * right action differs by call site (the proxy returns 502; the transport refuses and lets the
 * fallback ladder advance).
 *
 * A fresh MISMATCH shouts on `console.error`. The incident was invisible precisely because
 * nothing logged, and a verdict-level log fires at most once per mismatch TTL, so it can neither
 * be missed nor flood.
 */
export async function assertChainIdentity({
  expectedChainId,
  endpoint,
  probe,
  timeoutMs = CHAIN_IDENTITY_PROBE_TIMEOUT_MS,
  now = Date.now,
}: {
  expectedChainId: number
  endpoint: string
  probe: ChainIdProbe
  timeoutMs?: number
  now?: () => number
}): Promise<ChainIdentityVerdict> {
  const key = `${expectedChainId}|${endpoint}`

  const cached = verdictCache.get(key)
  if (cached && cached.expiresAt > now()) return cached.verdict

  const pending = inFlight.get(key)
  if (pending) return pending

  const run = (async () => {
    const verdict = await verifyChainIdentity({ expectedChainId, probe, timeoutMs })
    verdictCache.set(key, { verdict, expiresAt: now() + ttlFor(verdict.status) })
    if (verdict.status === 'mismatch') {
      console.error(`[chain-identity] ${forLog(verdict.message)}`)
    } else if (verdict.status === 'unverified') {
      // Not a refusal — an outage. Warn so it is visible, and carry on falling through.
      console.warn(
        `[chain-identity] could not verify the RPC for chain ${expectedChainId}: ${forLog(verdict.reason)} ` +
          '— treating as an outage and falling through',
      )
    }
    return verdict
  })().finally(() => {
    inFlight.delete(key)
  })

  inFlight.set(key, run)
  return run
}

/**
 * A probe that speaks plain JSON-RPC over `fetch`. Used by the `/api/rpc` proxy, which resolves an
 * upstream URL rather than a viem transport.
 *
 * EVERY failure here — transport reject, non-2xx, JSON-RPC error envelope, unparseable body —
 * rejects, and therefore lands in UNVERIFIED. That is correct: none of them produced a chain id,
 * so none of them can prove a lie. Only a 200 carrying a usable `result` can.
 */
export function createJsonRpcChainIdProbe(
  url: string,
  {
    fetchImpl,
    timeoutMs = CHAIN_IDENTITY_PROBE_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): ChainIdProbe {
  return async () => {
    const doFetch = fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`eth_chainId probe returned HTTP ${res.status}`)
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } } | null
      if (json?.error) {
        throw new Error(`eth_chainId probe returned a JSON-RPC error: ${json.error.message ?? 'unknown'}`)
      }
      return json?.result
    } finally {
      clearTimeout(timer)
    }
  }
}
