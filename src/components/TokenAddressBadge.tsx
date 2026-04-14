'use client'

import { useState, useCallback } from 'react'
import { NATIVE_ETH } from '@/lib/constants'
import { findTokenByAddress } from '@/lib/tokens'

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

interface Props {
  address: `0x${string}`
  isNative?: boolean
  isVerified?: boolean
  size?: 'sm' | 'md'
  showExplorerLink?: boolean
}

export default function TokenAddressBadge({
  address,
  isNative,
  isVerified,
  size = 'sm',
  showExplorerLink = true,
}: Props) {
  const [copied, setCopied] = useState(false)

  // Auto-detect native if not explicitly set
  const native = isNative ?? address.toLowerCase() === NATIVE_ETH.toLowerCase()

  // Auto-detect verified if not explicitly set
  const verified = isVerified ?? !!findTokenByAddress(address)

  const handleCopy = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    e.preventDefault()
    navigator.clipboard.writeText(address).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [address])

  if (native) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-cream-30">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Native asset
      </span>
    )
  }

  const isMd = size === 'md'

  return (
    <span className="inline-flex items-center gap-1">
      {/* Verified / Imported indicator */}
      {verified ? (
        <span title="Listed in TeraSwap default tokens" className="text-cream-gold">
          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-2.108-2.751 3 3 0 00-3.75-3.75 3 3 0 00-5.304 0 3 3 0 00-2.751 2.108 3 3 0 00-3.75 3.75 3 3 0 000 5.304 3 3 0 002.108 2.751 3 3 0 003.75 3.75 3 3 0 005.304 0 3 3 0 002.751-2.108 3 3 0 003.75-3.75zm-2.442-4.691a.75.75 0 00-1.06-1.06L8.5 11.302 6.1 8.9a.75.75 0 00-1.06 1.06l3 3a.75.75 0 001.06 0l5-5z" clipRule="evenodd" />
          </svg>
        </span>
      ) : (
        <span title="Imported token — verify the address before trading" className="text-amber-400">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </span>
      )}

      {/* Truncated address */}
      <span className={`font-mono ${isMd ? 'text-[11px]' : 'text-[10px]'} text-cream-30`}>
        {truncateAddr(address)}
      </span>

      {/* Copy button */}
      <button
        onClick={handleCopy}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy(e) }}
        aria-label="Copy contract address"
        className="inline-flex items-center gap-0.5 text-cream-20 transition hover:text-cream-50"
        title={copied ? 'Copied!' : 'Copy address'}
      >
        {copied ? (
          <svg className="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
        {isMd && <span className="text-[10px]">{copied ? 'Copied!' : 'Copy'}</span>}
      </button>

      {/* Explorer link */}
      {showExplorerLink && (
        <a
          href={`https://etherscan.io/token/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="View on Etherscan"
          className="inline-flex text-cream-20 transition hover:text-cream-50"
          title="View on Etherscan"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
    </span>
  )
}
