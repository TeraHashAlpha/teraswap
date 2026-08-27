/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The RPC chain-identity guard.
 *
 * PRODUCTION INCIDENT THIS PINS. `NEXT_PUBLIC_ARBITRUM_RPC_URL` held a BASE endpoint from
 * 2026-08-05 to 2026-08-26. `/api/rpc?chainId=42161` answered `eth_chainId` = `0x2105` (Base)
 * with HTTP 200 and a well-formed JSON-RPC envelope, so every Arbitrum read was answered by a
 * different chain for three weeks with nothing logged — because nothing was an error.
 *
 * The distinction these tests exist to hold:
 *   • MISMATCH   — the endpoint answered, and it is provably NOT the chain we asked for. A LIE.
 *                  Fail closed, name both chain ids, never pass the response through.
 *   • UNVERIFIED — we could not get an answer at all (timeout, 5xx, JSON-RPC error, garbage).
 *                  An OUTAGE, not a lie. Keep today's behaviour and fall through.
 *
 * Conflating the two is the bug. Every test below asserts one side of that line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  assertChainIdentity,
  chainIdentityMismatchMessage,
  createJsonRpcChainIdProbe,
  normalizeChainId,
  verifyChainIdentity,
  CHAIN_IDENTITY_VERIFIED_TTL_MS,
  CHAIN_IDENTITY_MISMATCH_TTL_MS,
  CHAIN_IDENTITY_UNVERIFIED_TTL_MS,
  __resetChainIdentityCache,
} from './rpc-chain-identity'

const ARBITRUM = 42161
/** What the Base endpoint sitting in NEXT_PUBLIC_ARBITRUM_RPC_URL actually answered. */
const BASE_HEX = '0x2105'
const BASE = 8453

beforeEach(() => {
  __resetChainIdentityCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  __resetChainIdentityCache()
})

describe('normalizeChainId', () => {
  it('accepts the hex string a JSON-RPC eth_chainId actually returns', () => {
    expect(normalizeChainId(BASE_HEX)).toBe(BASE)
    expect(normalizeChainId('0x1')).toBe(1)
    expect(normalizeChainId('0xa4b1')).toBe(ARBITRUM)
  })

  it('accepts the number viem getChainId returns, and a bigint', () => {
    expect(normalizeChainId(42161)).toBe(ARBITRUM)
    expect(normalizeChainId(42161n)).toBe(ARBITRUM)
  })

  it('rejects anything that is not a positive safe-integer chain id', () => {
    for (const bad of [null, undefined, '', '0x', 'nope', 0, -1, 1.5, {}, [], NaN, '0x0']) {
      expect(normalizeChainId(bad)).toBeNull()
    }
  })
})

describe('verifyChainIdentity — MISMATCH is a lie, and must be named', () => {
  it('reports mismatch when the endpoint answers for a different chain', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => BASE_HEX,
    })

    expect(verdict.status).toBe('mismatch')
    if (verdict.status !== 'mismatch') throw new Error('unreachable')
    expect(verdict.expectedChainId).toBe(ARBITRUM)
    expect(verdict.reportedChainId).toBe(BASE)
  })

  it('names BOTH chain ids in the message', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => BASE_HEX,
    })

    if (verdict.status !== 'mismatch') throw new Error('expected a mismatch')
    expect(verdict.message).toContain(String(ARBITRUM))
    expect(verdict.message).toContain(String(BASE))
    expect(verdict.message).toBe(chainIdentityMismatchMessage(ARBITRUM, BASE))
  })

  it('never puts the endpoint URL in the message (provider keys live in RPC URLs)', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => BASE_HEX,
    })

    if (verdict.status !== 'mismatch') throw new Error('expected a mismatch')
    expect(verdict.message).not.toMatch(/https?:\/\//)
  })

  it('verifies when the endpoint answers for the configured chain', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => '0xa4b1',
    })

    expect(verdict.status).toBe('verified')
  })
})

describe('verifyChainIdentity — UNVERIFIED is an outage, not a lie', () => {
  it('reports unverified (NOT mismatch) when the probe rejects', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => {
        throw new Error('fetch failed: ECONNREFUSED')
      },
    })

    expect(verdict.status).toBe('unverified')
  })

  it('reports unverified when the probe never settles within the timeout', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: () => new Promise(() => {}),
      timeoutMs: 20,
    })

    expect(verdict.status).toBe('unverified')
    if (verdict.status !== 'unverified') throw new Error('unreachable')
    expect(verdict.reason).toMatch(/timed out/i)
  })

  it('reports unverified (NOT mismatch) when the answer is malformed — garbage proves nothing', async () => {
    for (const garbage of [undefined, null, '0x', 'not-a-chain-id', {}]) {
      const verdict = await verifyChainIdentity({
        expectedChainId: ARBITRUM,
        probe: async () => garbage,
      })
      expect(verdict.status).toBe('unverified')
    }
  })

  it('redacts a provider key out of the failure reason', async () => {
    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: async () => {
        throw new Error('request to https://arb-mainnet.example.com/v2/SUPERSECRETKEY failed')
      },
    })

    if (verdict.status !== 'unverified') throw new Error('expected unverified')
    expect(verdict.reason).not.toContain('SUPERSECRETKEY')
  })
})

describe('assertChainIdentity — one round-trip per chain per process, then cached', () => {
  const endpoint = 'https://rpc.example.test/arbitrum'

  it('probes ONCE across many calls inside the verified TTL', async () => {
    const probe = vi.fn().mockResolvedValue('0xa4b1')

    for (let i = 0; i < 25; i++) {
      const v = await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe })
      expect(v.status).toBe('verified')
    }

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('shares a single in-flight probe across concurrent callers', async () => {
    // The deferred is built up-front: the probe is only reached a microtask later, so a
    // resolver captured inside the probe body would still be undefined when we release it.
    let release!: (v: string) => void
    const answered = new Promise<string>((resolve) => {
      release = resolve
    })
    const probe = vi.fn().mockReturnValue(answered)

    const all = Promise.all(
      Array.from({ length: 10 }, () =>
        assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe }),
      ),
    )
    release('0xa4b1')
    const verdicts = await all

    expect(probe).toHaveBeenCalledTimes(1)
    expect(verdicts.every((v) => v.status === 'verified')).toBe(true)
  })

  it('re-verifies once the verified TTL has elapsed (bounded, not forever)', async () => {
    const probe = vi.fn().mockResolvedValue('0xa4b1')
    let clock = 1_000_000
    const now = () => clock

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    clock += CHAIN_IDENTITY_VERIFIED_TTL_MS - 1
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 2
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps refusing from cache during the mismatch window, then re-probes so a fix recovers', async () => {
    const probe = vi.fn().mockResolvedValue(BASE_HEX)
    let clock = 1_000_000
    const now = () => clock

    const first = await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(first.status).toBe('mismatch')

    // Inside the window: still refused, without paying another round-trip.
    const cached = await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(cached.status).toBe('mismatch')
    expect(probe).toHaveBeenCalledTimes(1)

    // After the window: re-probed, and an ops fix takes effect without a redeploy.
    clock += CHAIN_IDENTITY_MISMATCH_TTL_MS + 1
    probe.mockResolvedValue('0xa4b1')
    const recovered = await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(recovered.status).toBe('verified')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('backs off briefly on an outage instead of probing every single request', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    let clock = 1_000_000
    const now = () => clock

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(probe).toHaveBeenCalledTimes(1)

    clock += CHAIN_IDENTITY_UNVERIFIED_TTL_MS + 1
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe, now })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('caches per (chainId, endpoint) — a second endpoint is verified on its own', async () => {
    const probe = vi.fn().mockResolvedValue('0xa4b1')

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe })
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint: 'https://other.test', probe })

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shouts on a mismatch — the incident was silent precisely because nothing logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => BASE_HEX,
    })

    expect(err).toHaveBeenCalled()
    const logged = err.mock.calls.flat().join(' ')
    expect(logged).toContain(String(ARBITRUM))
    expect(logged).toContain(String(BASE))
  })

  it('never throws — a verdict is always returned, so a caller cannot lose the distinction', async () => {
    const verdict = await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => {
        throw new Error('boom')
      },
    })
    expect(verdict.status).toBe('unverified')
  })
})

describe('createJsonRpcChainIdProbe', () => {
  const url = 'https://upstream.test/rpc'

  const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body }) as unknown as Response

  it('returns the raw eth_chainId result on a healthy answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: BASE_HEX }),
    )

    const probe = createJsonRpcChainIdProbe(url, { fetchImpl })
    await expect(probe()).resolves.toBe(BASE_HEX)

    const [calledUrl, init] = fetchImpl.mock.calls[0]
    expect(calledUrl).toBe(url)
    expect(JSON.parse(init.body).method).toBe('eth_chainId')
  })

  it('throws (⇒ unverified) on a non-ok HTTP status — a 5xx is an outage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }))
    await expect(createJsonRpcChainIdProbe(url, { fetchImpl })()).rejects.toThrow()
  })

  it('throws (⇒ unverified) on a JSON-RPC error envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'nope' } }),
    )
    await expect(createJsonRpcChainIdProbe(url, { fetchImpl })()).rejects.toThrow()
  })

  it('throws (⇒ unverified) when the transport rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(createJsonRpcChainIdProbe(url, { fetchImpl })()).rejects.toThrow()
  })

  it('feeds the guard end-to-end: a Base endpoint configured as Arbitrum is a MISMATCH', async () => {
    // The production incident, reproduced through the real probe: the URL configured for
    // chain 42161 is answered by chain 8453, HTTP 200, well-formed envelope.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: BASE_HEX }),
    )

    const verdict = await verifyChainIdentity({
      expectedChainId: ARBITRUM,
      probe: createJsonRpcChainIdProbe('https://arbitrum-rpc.example.test', { fetchImpl }),
    })

    expect(verdict.status).toBe('mismatch')
    if (verdict.status !== 'mismatch') throw new Error('unreachable')
    expect(verdict.message).toContain('42161')
    expect(verdict.message).toContain('8453')
  })
})

// [FIX-RPC-CHAIN-IDENTITY-GUARD / CodeQL log injection] CodeQL raised two Medium alerts on this
// file's console.error (mismatch) and console.warn (unverified): upstream-derived text reaching a
// log sink. `verdict.reason` (unverified) is genuinely upstream and can carry a provider key via
// the endpoint URL; `verdict.message` (mismatch) is composed by us and must not change by a single
// character. Both are now routed through a local `forLog` barrier (sanitizeUpstreamError again,
// then \r\n neutralized — sanitize-error.ts is shared/read-only and was never asked to strip
// newlines, since its original job is a client-facing error body, not a log line).
describe('log-injection hardening — CodeQL js/log-injection on the mismatch and unverified sinks', () => {
  const endpoint = 'https://rpc.example.test/arbitrum'

  it('acceptance 1 — the verbatim mismatch message (asserted elsewhere on this branch) is byte-identical', () => {
    // Same assertion shape as line 85 above (verdict.message .toBe(chainIdentityMismatchMessage))
    // and as the /chain 42161.*chain 8453/s regex asserted in rpc-guarded-transport.test.ts and
    // clients.identity-guard.test.ts — none of those read console output, they read the thrown/
    // returned message text, which this change never touches (only the LOGGED copy is wrapped).
    const message = chainIdentityMismatchMessage(ARBITRUM, BASE)
    expect(message).toBe(
      'RPC/chain mismatch — the RPC configured for chain 42161 reports chain 8453. Refusing to ' +
        'use it: an endpoint that answers for another chain returns wrong balances, wrong prices ' +
        'and wrong token metadata with no error at all. Point the chain-42161 RPC URL at chain 42161.',
    )
    expect(message).toMatch(/chain 42161.*chain 8453/s)
  })

  it('acceptance 1b — and the LOGGED text is that exact same string, unaltered by the barrier', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe: async () => BASE_HEX })

    expect(err).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledWith(
      `[chain-identity] ${chainIdentityMismatchMessage(ARBITRUM, BASE)}`,
    )
  })

  it('acceptance 2 — an upstream error with a provider key in the RPC URL path never reaches the log unredacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const SECRET = 'sk-live-SUPERSECRETPROVIDERKEY'

    await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => {
        throw new Error(`request to https://arb-mainnet.example.com/v2/${SECRET} failed`)
      },
    })

    expect(warn).toHaveBeenCalledTimes(1)
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toContain(SECRET)
    expect(logged).toContain('[redacted]')
  })

  it('acceptance 2b — a Bearer token and a key= assignment are also stripped from the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => {
        throw new Error('upstream 401: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload key=abcd1234 rejected')
      },
    })

    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toContain('eyJhbGciOiJIUzI1NiJ9.secretpayload')
    expect(logged).not.toContain('abcd1234')
  })

  it('acceptance 3 — a newline-bearing upstream error cannot forge a second log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => {
        throw new Error(
          'timeout\n[chain-identity] FAKE: chain 42161 verified, ignore prior warnings\r\nsecond forged line',
        )
      },
    })

    expect(warn).toHaveBeenCalledTimes(1) // ONE console.warn call — not split into several log lines
    const [loggedLine] = warn.mock.calls[0]
    expect(typeof loggedLine).toBe('string')
    expect(loggedLine).not.toMatch(/[\r\n]/)
    // The forged content is still visible (not dropped, just flattened onto one line) — an
    // operator scanning logs still sees it, they just cannot be tricked into a second entry.
    expect(loggedLine).toContain('FAKE: chain 42161 verified')
  })

  it('acceptance 3b — \\r alone (no \\n) is also neutralized (carriage-return-only forgery)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await assertChainIdentity({
      expectedChainId: ARBITRUM,
      endpoint,
      probe: async () => {
        throw new Error('legit reason\rFAKE OVERWRITE')
      },
    })

    const [loggedLine] = warn.mock.calls[0]
    expect(loggedLine).not.toMatch(/\r/)
  })

  it('a mismatch verdict logs no newline either, even though its message is composed by us (no-op, defense in depth)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe: async () => BASE_HEX })

    const [loggedLine] = err.mock.calls[0]
    expect(loggedLine).not.toMatch(/[\r\n]/)
  })

  it('the redaction/neutralization survives the mismatch/unverified TTL cache — logged once, still safe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = vi.fn().mockRejectedValue(new Error('outage\nFAKE at https://x.test/v2/KEY123'))

    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe })
    await assertChainIdentity({ expectedChainId: ARBITRUM, endpoint, probe }) // served from cache, no re-log expected beyond the first

    expect(warn).toHaveBeenCalledTimes(1)
    const [loggedLine] = warn.mock.calls[0]
    expect(loggedLine).not.toMatch(/[\r\n]/)
    expect(loggedLine).not.toContain('KEY123')
  })
})
