// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, SEC-8] bodySizeGuard caps what a request body read can take, whatever the headers say.
 *
 * The cap used to come from Content-Length only: a chunked body (no header) or a header smaller than the body was read
 * in full (778 KB accepted in the audit of 2026-11-17). Now a declared over-cap body is still refused at once (413), and
 * any other body is read through a byte-capped reader that fails with BodyTooLargeError past the cap and takes at most
 * one chunk beyond it. A body within the cap reads exactly as it did. The route-level tests, one per route that uses
 * the guard, are in app/api/body-limit.routes.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { bodySizeGuard, bodyTooLargeFrom, BodyTooLargeError, DEFAULT_MAX_BODY_BYTES } from './body-limit'

const CAP = DEFAULT_MAX_BODY_BYTES
const CHUNK = 1000

/** A body served `chunk` bytes at a time, only when asked (so `taken()` is what the reader took). */
function chunked(bytes: Uint8Array, chunk = CHUNK) {
  let taken = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (taken >= bytes.length) return controller.close()
        const part = bytes.subarray(taken, taken + chunk)
        taken += part.length
        controller.enqueue(part)
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, taken: () => taken }
}

function request(body: BodyInit | null, headers: Record<string, string> = {}, method = 'POST') {
  return new NextRequest('http://localhost/api/anything', {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as unknown as ConstructorParameters<typeof NextRequest>[1])
}

const ascii = (n: number) => new TextEncoder().encode('a'.repeat(n))

describe('bodySizeGuard: reads stop at the cap whatever the headers say', () => {
  it('chunked, no Content-Length, 778 KB: the read fails with BodyTooLargeError after at most one chunk past the cap', async () => {
    const { stream, taken } = chunked(ascii(778 * 1024))
    const req = request(stream)
    expect(req.headers.get('content-length')).toBeNull()
    expect(bodySizeGuard(req)).toBeNull()
    await expect(req.text()).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(taken()).toBeLessThanOrEqual(CAP + CHUNK)
  })

  it('no Content-Length, plain body over the cap: json() fails with BodyTooLargeError', async () => {
    const req = request(JSON.stringify({ pad: 'x'.repeat(CAP) }))
    expect(req.headers.get('content-length')).toBeNull()
    expect(bodySizeGuard(req)).toBeNull()
    await expect(req.json()).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('Content-Length smaller than the body: the header is not believed', async () => {
    const { stream, taken } = chunked(ascii(50_000))
    const req = request(stream, { 'content-length': '100' })
    expect(bodySizeGuard(req)).toBeNull()
    await expect(req.arrayBuffer()).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(taken()).toBeLessThanOrEqual(CAP + CHUNK)
  })

  it('exactly at the cap: read in full', async () => {
    const { stream } = chunked(ascii(CAP))
    const req = request(stream)
    expect(bodySizeGuard(req)).toBeNull()
    expect((await req.text()).length).toBe(CAP)
  })

  it('one byte over the cap: refused', async () => {
    const { stream } = chunked(ascii(CAP + 1))
    const req = request(stream)
    expect(bodySizeGuard(req)).toBeNull()
    await expect(req.text()).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('one byte over the cap in a single chunk: refused', async () => {
    const { stream } = chunked(ascii(CAP + 1), CAP + 1)
    const req = request(stream)
    expect(bodySizeGuard(req)).toBeNull()
    await expect(req.json()).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('reading req.body directly stops at the cap too', async () => {
    const { stream, taken } = chunked(ascii(100_000))
    const req = request(stream)
    expect(bodySizeGuard(req)).toBeNull()
    const reader = req.body!.getReader()
    await expect((async () => { for (;;) if ((await reader.read()).done) return })()).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(taken()).toBeLessThanOrEqual(CAP + CHUNK)
  })

  it('a declared Content-Length over the cap still answers 413 at once, without reading', async () => {
    const { stream, taken } = chunked(ascii(CAP + 1))
    const res = bodySizeGuard(request(stream, { 'content-length': String(CAP + 1) }))
    expect(res?.status).toBe(413)
    expect(await res!.json()).toEqual({ error: 'Request body too large' })
    expect(taken()).toBe(0)
  })

  it('honours a per-route cap', async () => {
    const { stream } = chunked(ascii(CAP * 3))
    const req = request(stream)
    expect(bodySizeGuard(req, CAP * 3)).toBeNull()
    expect((await req.text()).length).toBe(CAP * 3)
  })
})

describe('bodySizeGuard: a body within the cap reads exactly as before', () => {
  const bodies: Array<[string, string]> = [
    ['valid JSON', JSON.stringify({ a: 1, b: ['x', 'y'], c: 'é€😀' })],
    ['invalid JSON', '{"a": 1,'],
    ['empty', ''],
    ['multi-byte text split across chunks', '€'.repeat(2000)],
  ]

  async function settle<T>(p: Promise<T>) {
    try {
      return { ok: true as const, value: await p }
    } catch (err) {
      return { ok: false as const, type: (err as Error).constructor.name, message: (err as Error).message }
    }
  }

  it.each(bodies)('%s: json(), text(), arrayBuffer() give the same result or the same error', async (_label, text) => {
    const bytes = new TextEncoder().encode(text)
    for (const read of ['json', 'text', 'arrayBuffer'] as const) {
      const plain = request(chunked(bytes, 7).stream)
      const guarded = request(chunked(bytes, 7).stream)
      expect(bodySizeGuard(guarded)).toBeNull()
      const a = await settle(plain[read]() as Promise<unknown>)
      const b = await settle(guarded[read]() as Promise<unknown>)
      if (read === 'arrayBuffer' && a.ok && b.ok) {
        expect(new Uint8Array(b.value as ArrayBuffer)).toEqual(new Uint8Array(a.value as ArrayBuffer))
      } else {
        expect(b).toEqual(a)
      }
    }
  })

  it('formData() and blob() read the same as before', async () => {
    const form = 'a=1&b=two'
    const headers = { 'content-type': 'application/x-www-form-urlencoded' }
    const guarded = request(form, headers)
    expect(bodySizeGuard(guarded)).toBeNull()
    expect([...(await guarded.formData()).entries()]).toEqual([...(await request(form, headers).formData()).entries()])
    const guardedBlob = request('blob body')
    bodySizeGuard(guardedBlob)
    expect(await (await guardedBlob.blob()).text()).toBe('blob body')
  })

  it('a second read fails as it does on a plain request', async () => {
    const plain = request('{}')
    await plain.json()
    await expect(plain.json()).rejects.toBeInstanceOf(TypeError)
    const guarded = request('{}')
    bodySizeGuard(guarded)
    await guarded.json()
    await expect(guarded.json()).rejects.toBeInstanceOf(TypeError)
  })

  it('a request without a body is left alone, and a second guard call changes nothing', async () => {
    const get = request(null, {}, 'GET')
    expect(bodySizeGuard(get)).toBeNull()
    expect(get.body).toBeNull()
    expect(Object.getOwnPropertyNames(get)).not.toContain('json')
    const post = request('{"a":1}')
    bodySizeGuard(post)
    bodySizeGuard(post, 1) // already capped: the first cap stays
    expect(await post.json()).toEqual({ a: 1 })
  })
})

describe('bodyTooLargeFrom', () => {
  it('answers 413 for a BodyTooLargeError (with the given headers) and null for anything else', async () => {
    const res = bodyTooLargeFrom(new BodyTooLargeError(CAP), { 'Access-Control-Allow-Origin': 'https://teraswap.app' })
    expect(res?.status).toBe(413)
    expect(res?.headers.get('access-control-allow-origin')).toBe('https://teraswap.app')
    expect(await res!.json()).toEqual({ error: 'Request body too large' })
    expect(bodyTooLargeFrom(new SyntaxError('x'))).toBeNull()
    expect(bodyTooLargeFrom(undefined)).toBeNull()
  })
})
