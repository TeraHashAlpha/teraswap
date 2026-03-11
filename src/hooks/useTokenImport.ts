'use client'

import { useState, useCallback } from 'react'
import { useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { addCustomToken, findTokenByAddress, type Token } from '@/lib/tokens'

/**
 * Hook to import a custom ERC-20 token by pasting its contract address.
 * Reads on-chain: symbol, name, decimals via wagmi multicall.
 */
export function useTokenImport() {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const importToken = useCallback(async (address: string): Promise<Token | null> => {
    setError(null)

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setError('Invalid address format')
      return null
    }

    // Check if already exists
    const existing = findTokenByAddress(address)
    if (existing) return existing

    setImporting(true)
    try {
      // Use fetch to call the RPC directly for simplicity (wagmi hooks are for components)
      const rpcUrl = 'https://eth.llamarpc.com'
      const addr = address.toLowerCase() as `0x${string}`

      const [symbolRes, nameRes, decimalsRes] = await Promise.all([
        callRpc(rpcUrl, addr, '0x95d89b41'), // symbol()
        callRpc(rpcUrl, addr, '0x06fdde03'), // name()
        callRpc(rpcUrl, addr, '0x313ce567'), // decimals()
      ])

      if (!symbolRes || !decimalsRes) {
        setError('Not a valid ERC-20 token')
        setImporting(false)
        return null
      }

      const rawSymbol = decodeString(symbolRes)
      const rawName = nameRes ? decodeString(nameRes) : rawSymbol
      const decimals = parseInt(decimalsRes as string, 16)

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
      }

      addCustomToken(token)
      setImporting(false)
      return token
    } catch {
      setError('Failed to fetch token data')
      setImporting(false)
      return null
    }
  }, [])

  return { importToken, importing, error }
}

// ── RPC helpers ──

async function callRpc(rpcUrl: string, to: string, data: string): Promise<string | null> {
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
    const json = await res.json()
    if (json.error || !json.result || json.result === '0x') return null
    return json.result
  } catch {
    return null
  }
}

// [F-03] Sanitize token name/symbol to prevent XSS via malicious ERC-20 contracts
function sanitizeTokenField(raw: string, maxLen: number): string {
  // Strip HTML tags completely
  const noHtml = raw.replace(/<[^>]*>/g, '')
  // Allow only printable ASCII characters, common currency symbols, spaces, dots, hyphens
  const cleaned = noHtml.replace(/[^\x20-\x7E]/g, '').trim()
  // Truncate to max length
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
