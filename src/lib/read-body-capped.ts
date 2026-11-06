/**
 * Read an upstream response body incrementally and give up as soon as it exceeds `max` bytes.
 *
 * Shared by the server-side proxies (/api/token-logo + /api/proxy/logo via logo-proxy.ts, /api/cow/*, /api/rpc):
 * `await res.json()` / `res.text()` buffer the WHOLE body before anything can look at its size, so a hostile or
 * broken upstream could make a function hold an arbitrarily large answer in memory. A declared `content-length`
 * over the cap is refused before the first read; an undeclared (chunked) body is cut off at the first chunk that
 * crosses it, and the stream is cancelled so the connection is not drained.
 *
 * Returns the bytes, or null when the body is over the cap or absent. Never throws on size; a network error while
 * reading propagates to the caller (which already handles fetch failures).
 */
export async function readBodyCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers?.get?.('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Outcome of {@link readJsonCapped}. */
export type CappedJson = { ok: true; json: unknown } | { ok: false; reason: 'too_large' | 'invalid_json' }

/** {@link readBodyCapped}, then UTF-8 decode and JSON.parse. An empty body is `invalid_json`. */
export async function readJsonCapped(res: Response, max: number): Promise<CappedJson> {
  const bytes = await readBodyCapped(res, max)
  if (bytes === null) return res.body ? { ok: false, reason: 'too_large' } : { ok: false, reason: 'invalid_json' }
  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}
