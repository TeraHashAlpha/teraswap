'use client'

import { useState, useCallback } from 'react'
import { getAddress } from 'viem'
import { addCustomToken, type Token } from '@/lib/tokens'
import { findChainToken } from '@/lib/chains/tokens'
import { useActiveChainId } from '@/hooks/useChainId'

/** The token answered, and what it answered is not ERC-20 shaped. A verdict about the TOKEN. */
export const TOKEN_NOT_ERC20_MESSAGE = 'Not a valid ERC-20 token'

/**
 * We never got an answer to read. A statement about OUR read path — the transport failed, the
 * proxy refused (including the 502 the chain-identity guard returns for a misrouted upstream),
 * we were rate limited, or the node returned a JSON-RPC error. Says nothing about the token.
 */
export const TOKEN_READ_FAILED_MESSAGE =
  'Network error — could not read this contract. Please try again.'

/**
 * Hook to import a custom ERC-20 token by pasting its contract address.
 * Reads on-chain: symbol, name, decimals via wagmi multicall.
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] A read failure is NOT a verdict about the token. This hook used
 * to collapse every way `symbol()`/`decimals()` could come back empty into one message — "Not a
 * valid ERC-20 token" — so an empty result from a broken transport and an empty result from a
 * non-token were indistinguishable. While NEXT_PUBLIC_ARBITRUM_RPC_URL held a Base endpoint we
 * spent three weeks telling users their token was invalid when the fault was ours.
 *
 * `callRpc` now reports WHICH of the two happened, and only a SUCCESSFUL read that fails the
 * ERC-20 shape may call the token invalid.
 */
export function useTokenImport() {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // [SPRINT-9P] Import against the ACTIVE chain — a Base address must be read on
  // Base, not the mainnet proxy (which returned 0x → "Not a valid ERC-20 token").
  const chainId = useActiveChainId()

  const importToken = useCallback(async (address: string): Promise<Token | null> => {
    setError(null)

    // Q16: Validate and normalize address with EIP-55 checksum via viem
    let checksumAddr: string
    try {
      checksumAddr = getAddress(address)
    } catch {
      setError('Invalid Ethereum address')
      return null
    }

    // Check if already exists — chain-scoped so a colliding mainnet address
    // can't short-circuit a genuine Base import (and vice-versa).
    const existing = findChainToken(checksumAddr, chainId)
    if (existing) return existing

    setImporting(true)
    try {
      // Use fetch to call our RPC proxy for privacy (hides user IP from RPC provider).
      // [SPRINT-9P] Pass the active chain so the proxy reads the right chain's RPC.
      const rpcUrl = `/api/rpc?chainId=${chainId}`
      const addr = address.toLowerCase() as `0x${string}`

      const [symbolRes, nameRes, decimalsRes] = await Promise.all([
        callRpc(rpcUrl, addr, '0x95d89b41'), // symbol()
        callRpc(rpcUrl, addr, '0x06fdde03'), // name()
        callRpc(rpcUrl, addr, '0x313ce567'), // decimals()
      ])

      // ① Did the read even land? If ANY required call failed to produce an answer we cannot
      //    conclude anything about the token — not even from the calls that DID answer. Blaming
      //    the token on a half-broken read is exactly the bug this branch exists to prevent.
      if (unreadable(symbolRes) || unreadable(decimalsRes)) {
        setError(TOKEN_READ_FAILED_MESSAGE)
        setImporting(false)
        return null
      }

      // ② The read succeeded and the contract returned nothing for symbol()/decimals(): an EOA,
      //    or a contract that is not ERC-20. Only HERE have we earned the right to say so.
      if (!symbolRes.ok || !decimalsRes.ok) {
        setError(TOKEN_NOT_ERC20_MESSAGE)
        setImporting(false)
        return null
      }

      const rawSymbol = decodeString(symbolRes.value)
      // name() is optional — an unreadable or empty name falls back to the symbol, as before.
      const rawName = nameRes.ok ? decodeString(nameRes.value) : rawSymbol
      const decimals = parseInt(decimalsRes.value, 16)

      if (!rawSymbol || isNaN(decimals)) {
        setError('Could not read token data')
        setImporting(false)
        return null
      }

      // [F-03] Sanitize symbol/name — strip HTML/script tags, limit length, alphanumeric only
      const symbol = sanitizeTokenField(rawSymbol, 20)
      const name = sanitizeTokenField(rawName, 64)

      if (!symbol) {
        setError('Token symbol contains invalid characters')
        setImporting(false)
        return null
      }

      const token: Token = {
        address: address as `0x${string}`,
        symbol,
        name,
        decimals,
        logoURI: `https://tokens.1inch.io/${address.toLowerCase()}.png`,
        category: 'Imported',
        chainId, // [SPRINT-9P] tag the import so the store/lookups stay chain-scoped
      }

      addCustomToken(token)
      setImporting(false)
      return token
    } catch {
      setError('Failed to fetch token data')
      setImporting(false)
      return null
    }
  }, [chainId])

  return { importToken, importing, error }
}

// ── RPC helpers ──

/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The result of one eth_call, with the two failure modes kept
 * APART rather than both collapsing to `null`:
 *
 *   • 'empty'      — the call SUCCEEDED and the contract returned no data (`0x`). Evidence about
 *                    the token: it is an EOA, or has no such method.
 *   • 'unreadable' — we never got a usable answer: the transport threw, our own proxy returned a
 *                    non-2xx (429 rate limit, or the 502 the chain-identity guard returns for an
 *                    upstream serving another chain), the body would not parse, or the node
 *                    answered with a JSON-RPC error. Evidence about US, not about the token.
 *
 * A JSON-RPC error counts as 'unreadable' deliberately, even though a revert can mean the
 * contract lacks the method: an error envelope is not a successful read, and the rule is that
 * only a successful read may condemn a token. Over-reporting "we could not read it" costs a
 * retry; under-reporting it calls a user's token fake because our RPC was broken.
 */
type RpcRead = { ok: true; value: string } | { ok: false; reason: 'empty' | 'unreadable' }

const unreadable = (read: RpcRead): boolean => !read.ok && read.reason === 'unreadable'

async function callRpc(rpcUrl: string, to: string, data: string): Promise<RpcRead> {
  let json: { result?: unknown; error?: unknown }
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    })
    if (!res.ok) return { ok: false, reason: 'unreadable' }
    json = await res.json()
  } catch {
    // Network failure, abort, or an unparseable body — no read happened.
    return { ok: false, reason: 'unreadable' }
  }
  if (json?.error) return { ok: false, reason: 'unreadable' }
  if (typeof json?.result !== 'string') return { ok: false, reason: 'unreadable' }
  if (json.result === '0x') return { ok: false, reason: 'empty' }
  return { ok: true, value: json.result }
}

// [F-03 / CQL-03] Sanitize token name/symbol to prevent XSS via malicious ERC-20
// contracts. Strip every `<` and `>` rather than relying on /<[^>]*>/g, which
// fails on malformed tags (e.g. `<img src=x onerror=alert(1)` with no closing
// bracket) and on encoded/nested constructs. No legitimate token name contains
// angle brackets, so this is strictly stronger with zero false positives.
export function sanitizeTokenField(raw: string, maxLen: number): string {
  const noAngles = raw.replace(/[<>]/g, '')
  const cleaned = noAngles.replace(/[^\x20-\x7E]/g, '').trim()
  return cleaned.slice(0, maxLen)
}

function decodeString(hex: string): string {
  try {
    // Remove 0x prefix
    const data = hex.slice(2)
    if (data.length < 128) {
      // Might be a bytes32 response (some tokens like MKR)
      const cleaned = data.replace(/00+$/, '')
      const bytes = []
      for (let i = 0; i < cleaned.length; i += 2) {
        const byte = parseInt(cleaned.slice(i, i + 2), 16)
        if (byte > 0) bytes.push(byte)
      }
      return new TextDecoder().decode(new Uint8Array(bytes)).trim()
    }
    // Standard ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
    const length = parseInt(data.slice(64, 128), 16)
    const strHex = data.slice(128, 128 + length * 2)
    const bytes = []
    for (let i = 0; i < strHex.length; i += 2) {
      bytes.push(parseInt(strHex.slice(i, i + 2), 16))
    }
    return new TextDecoder().decode(new Uint8Array(bytes)).trim()
  } catch {
    return ''
  }
}
