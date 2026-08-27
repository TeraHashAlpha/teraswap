// @vitest-environment jsdom
/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] A read failure is not a verdict about the token.
 *
 * THE BUG. `useTokenImport` collapsed every way `symbol()`/`decimals()` could come back empty into
 * one message: "Not a valid ERC-20 token". An empty result from a broken transport and an empty
 * result from a non-token were indistinguishable there — so while the Arbitrum RPC was pointed at
 * Base, we spent three weeks telling users their token was invalid when the fault was ours.
 *
 * THE RULE these tests pin: only a SUCCESSFUL read that fails the ERC-20 shape may call the token
 * invalid. A transport error, an HTTP error from our own proxy (including the new 502 the identity
 * guard returns), or a JSON-RPC error envelope must say we could not read the contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ chain: undefined }), // → DEFAULT_CHAIN_ID (mainnet)
}))

import { renderHook, act } from '@testing-library/react'
import {
  useTokenImport,
  TOKEN_READ_FAILED_MESSAGE,
  TOKEN_NOT_ERC20_MESSAGE,
} from './useTokenImport'

/**
 * A fresh address per case. `addCustomToken` appends to a MODULE-LEVEL array in lib/tokens, which
 * `localStorage.clear()` cannot reach — so reusing one address would let a successful import in
 * an earlier case short-circuit a later one via findChainToken.
 */
let addressCounter = 0
const nextAddress = (): string => `0x${(++addressCounter).toString(16).padStart(40, '0')}`

const SELECTOR = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' } as const

/** ABI-encoded dynamic string, the shape a real `symbol()` returns. */
function abiString(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex')
  return (
    '0x' +
    (32).toString(16).padStart(64, '0') +
    value.length.toString(16).padStart(64, '0') +
    hex.padEnd(64, '0')
  )
}

const abiUint = (n: number) => '0x' + n.toString(16).padStart(64, '0')

type Answer = { result?: string; error?: unknown; httpStatus?: number; reject?: boolean }

/** Stub `/api/rpc` per eth_call selector. */
function stubRpc(answers: Partial<Record<keyof typeof SELECTOR, Answer>>, fallback: Answer = { result: '0x' }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const data: string = body?.params?.[0]?.data ?? ''
    const key = (Object.keys(SELECTOR) as (keyof typeof SELECTOR)[]).find((k) => SELECTOR[k] === data)
    const answer = (key && answers[key]) || fallback

    if (answer.reject) throw new TypeError('Failed to fetch')
    if (answer.httpStatus && answer.httpStatus >= 400) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32006, message: 'RPC/chain mismatch' } }), {
        status: answer.httpStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify(answer.error ? { jsonrpc: '2.0', id: 1, error: answer.error } : { jsonrpc: '2.0', id: 1, result: answer.result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function importAndGetError(): Promise<string | null> {
  const { result } = renderHook(() => useTokenImport())
  await act(async () => {
    await result.current.importToken(nextAddress())
  })
  return result.current.error
}

const HEALTHY_ERC20 = {
  symbol: { result: abiString('TEST') },
  name: { result: abiString('Test Token') },
  decimals: { result: abiUint(18) },
} as const

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('useTokenImport — a transport failure is OUR fault, not the token’s', () => {
  it('says the contract could not be read when the request never lands', async () => {
    stubRpc({ symbol: { reject: true }, decimals: { reject: true }, name: { reject: true } })

    expect(await importAndGetError()).toBe(TOKEN_READ_FAILED_MESSAGE)
  })

  it('says the contract could not be read on a 502 from our own proxy (the identity refusal)', async () => {
    // This is exactly what /api/rpc now returns when the upstream is serving another chain.
    stubRpc({ symbol: { httpStatus: 502 }, decimals: { httpStatus: 502 }, name: { httpStatus: 502 } })

    expect(await importAndGetError()).toBe(TOKEN_READ_FAILED_MESSAGE)
  })

  it('says the contract could not be read on a JSON-RPC error envelope', async () => {
    stubRpc({
      symbol: { error: { code: -32603, message: 'internal' } },
      decimals: { error: { code: -32603, message: 'internal' } },
      name: { error: { code: -32603, message: 'internal' } },
    })

    expect(await importAndGetError()).toBe(TOKEN_READ_FAILED_MESSAGE)
  })

  it('says the contract could not be read when the rate limiter answers 429', async () => {
    stubRpc({ symbol: { httpStatus: 429 }, decimals: { httpStatus: 429 }, name: { httpStatus: 429 } })

    expect(await importAndGetError()).toBe(TOKEN_READ_FAILED_MESSAGE)
  })

  it('does not accuse the token when only PART of the read failed', async () => {
    // decimals() read fine and was empty; symbol() never got an answer. We cannot conclude
    // anything about the token from a half-broken read.
    stubRpc({ symbol: { reject: true }, decimals: { result: '0x' }, name: { result: '0x' } })

    expect(await importAndGetError()).toBe(TOKEN_READ_FAILED_MESSAGE)
  })
})

describe('useTokenImport — only a SUCCESSFUL read may call the token invalid', () => {
  it('says the token is not a valid ERC-20 when the contract answers with no data', async () => {
    // A healthy node, a clean 200, and `0x` back: an EOA or a contract with no symbol()/decimals().
    stubRpc({ symbol: { result: '0x' }, decimals: { result: '0x' }, name: { result: '0x' } })

    expect(await importAndGetError()).toBe(TOKEN_NOT_ERC20_MESSAGE)
  })
})

describe('useTokenImport — the two verdicts are distinguishable [acceptance]', () => {
  it('produces DIFFERENT user-facing messages for a read failure and a non-ERC-20', async () => {
    stubRpc({ symbol: { reject: true }, decimals: { reject: true }, name: { reject: true } })
    const readFailure = await importAndGetError()

    stubRpc({ symbol: { result: '0x' }, decimals: { result: '0x' }, name: { result: '0x' } })
    const notAToken = await importAndGetError()

    expect(readFailure).not.toBe(notAToken)
    expect(readFailure).toBe(TOKEN_READ_FAILED_MESSAGE)
    expect(notAToken).toBe(TOKEN_NOT_ERC20_MESSAGE)
    // And the read failure must not blame the token.
    expect(readFailure).not.toMatch(/not a valid/i)
  })
})

describe('useTokenImport — the happy path still imports', () => {
  it('returns the token and sets no error on a healthy read', async () => {
    stubRpc(HEALTHY_ERC20)

    const { result } = renderHook(() => useTokenImport())
    let imported: unknown
    await act(async () => {
      imported = await result.current.importToken(nextAddress())
    })

    expect(result.current.error).toBeNull()
    expect(imported).toMatchObject({ symbol: 'TEST', name: 'Test Token', decimals: 18, chainId: 1 })
  })

  it('imports even when only name() is unreadable — name falls back to the symbol', async () => {
    stubRpc({ ...HEALTHY_ERC20, name: { reject: true } })

    const { result } = renderHook(() => useTokenImport())
    let imported: unknown
    await act(async () => {
      imported = await result.current.importToken(nextAddress())
    })

    expect(result.current.error).toBeNull()
    expect(imported).toMatchObject({ symbol: 'TEST', name: 'TEST' })
  })
})
