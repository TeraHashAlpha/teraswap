/**
 * [AUDIT-W6 / W6-L-01] Shared request body-size guard.
 *
 * Extracted from the swap route's content-length cap so every body route can
 * refuse oversized payloads app-side (413 JSON) instead of relying on the
 * platform default (~4 MB).
 *
 * [SEC-8, fix/log-routes-bounded-input] The cap used to be read from the
 * Content-Length header only, so a chunked body (no header) or a header smaller
 * than the body was read in full: a 778 KB body was accepted (audit
 * 2026-11-17). The guard still answers 413 at once when the header declares too
 * much, and otherwise puts a byte-capped reader on the request: every later read
 * (`req.json()`, `text()`, `arrayBuffer()`, `blob()`, `bytes()`, `formData()`,
 * `req.body`) stops once more than `maxBytes` have arrived, whatever the headers
 * say, and fails with BodyTooLargeError. Routes answer that with 413
 * (`bodyTooLargeFrom(err)`). A body within the cap reads exactly as before.
 * Owner answer 2026-11-17: the function keeps its synchronous signature so no
 * call site changes; routes this branch may not touch (orders/**, log-swap) stop
 * reading at the cap too and answer their own error.
 */
import { NextResponse } from 'next/server'
import { clientIpKey } from './client-ip-key'

/** Default cap for JSON API bodies — matches the swap route's 10 KB. */
export const DEFAULT_MAX_BODY_BYTES = 10_000

/** The RPC proxy forwards eth_call simulations whose calldata can be large
 *  (the app itself allows up to ~200 KB of swap calldata) — cap generously
 *  but finitely. */
export const RPC_MAX_BODY_BYTES = 262_144 // 256 KB

/** Per-client bucket name shared by rate-limit call sites.
 *  [CHORE-API-HARDENING-2 / P3a] Derived from trustedClientIp — the left-most
 *  x-forwarded-for token is attacker-controlled on Vercel; see trusted-ip.ts.
 *  [fix/user-ip-privacy] Returns the KEYED HASH of that IP (client-ip-key.ts), never the address:
 *  every caller only builds a rate-limit key from it, and the raw IP used to end up in Upstash and,
 *  on a Redis outage, in the function logs. The name is kept so the call sites do not change. */
export function clientIp(req: Request): string {
  return clientIpKey(req)
}

/** A read of a request body went past the cap bodySizeGuard put on it. */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`Request body too large (more than ${maxBytes} bytes)`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

function tooLargeResponse(headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: 'Request body too large' }, { status: 413, headers })
}

/** The 413 bodySizeGuard answers, when `err` is a BodyTooLargeError; else null (handle `err` as before). */
export function bodyTooLargeFrom(err: unknown, headers?: Record<string, string>): NextResponse | null {
  return err instanceof BodyTooLargeError ? tooLargeResponse(headers) : null
}

const BODY_CAP = Symbol.for('teraswap.body-limit.cap')

/** `source`, ending in BodyTooLargeError once more than `maxBytes` have arrived. Reads nothing ahead (high-water mark
 *  0): at most one chunk past the cap is ever taken from the source, and it is discarded, not passed on. */
function cappedStream(source: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let received = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        received += value.byteLength
        if (received > maxBytes) {
          onOverflow()
          controller.error(new BodyTooLargeError(maxBytes))
          await reader.cancel().catch(() => {})
          return
        }
        controller.enqueue(value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/**
 * Puts the byte-capped reader on `req` (see the module doc). Idempotent; a request without a body is left alone.
 * The body methods read through `new Response(capped stream)`, so a body within the cap parses with the same
 * semantics and errors as the request's own methods.
 */
function capRequestBody(req: Request, maxBytes: number): void {
  const holder = req as unknown as Record<symbol, unknown>
  if (holder[BODY_CAP] !== undefined) return
  const source = req.body
  if (!source) return

  let overflowed = false
  let capped: ReadableStream<Uint8Array> | null = null
  const stream = () => (capped ??= cappedStream(source, maxBytes, () => { overflowed = true }))
  const contentType = req.headers.get('content-type')
  const through = <T>(read: (res: Response) => Promise<T>) => async (): Promise<T> => {
    try {
      return await read(new Response(stream(), contentType ? { headers: { 'content-type': contentType } } : undefined))
    } catch (err) {
      if (overflowed) throw new BodyTooLargeError(maxBytes)
      throw err
    }
  }

  Object.defineProperties(req, {
    [BODY_CAP]: { value: maxBytes },
    body: { get: stream, configurable: true },
    arrayBuffer: { value: through((r) => r.arrayBuffer()), configurable: true },
    blob: { value: through((r) => r.blob()), configurable: true },
    bytes: { value: through((r) => r.arrayBuffer().then((b) => new Uint8Array(b))), configurable: true },
    formData: { value: through((r) => r.formData()), configurable: true },
    json: { value: through((r) => r.json()), configurable: true },
    text: { value: through((r) => r.text()), configurable: true },
  })
}

/**
 * Returns a 413 JSON response when the declared content-length exceeds
 * `maxBytes`, else null (proceed) after putting the byte-capped reader on the
 * request (see the module doc). Pass `headers` to keep CORS on the refusal for
 * browser-facing telemetry routes.
 */
export function bodySizeGuard(
  req: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  headers?: Record<string, string>,
): NextResponse | null {
  const declared = Number.parseInt(req.headers.get('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return tooLargeResponse(headers)
  }
  capRequestBody(req, maxBytes)
  return null
}
