'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useBalance, useDisconnect, useEnsName, useEnsAvatar } from 'wagmi'
import { mainnet } from 'wagmi/chains'

interface Props {
  open: boolean
  onClose: () => void
}

/* ── Deterministic color from address ── */
function addressToGradient(address: string): [string, string] {
  const seed = parseInt(address.slice(2, 10), 16)
  const h1 = seed % 360
  const h2 = (h1 + 40 + (seed % 60)) % 360
  return [
    `hsl(${h1}, 55%, 45%)`,
    `hsl(${h2}, 65%, 55%)`,
  ]
}

/* ── Blocky identicon ring segments (purely cosmetic) ── */
function IdenticonRing({ address }: { address: string }) {
  const segments = 12
  const seed = parseInt(address.slice(2, 14), 16)
  const [c1, c2] = addressToGradient(address)

  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full animate-spin-slow">
      {Array.from({ length: segments }).map((_, i) => {
        const active = ((seed >> (i % 30)) & 1) === 1
        const angle = (i * 360) / segments
        const rads = (angle * Math.PI) / 180
        const rads2 = ((angle + 360 / segments - 2) * Math.PI) / 180
        const r = 48
        const x1 = 50 + r * Math.cos(rads)
        const y1 = 50 + r * Math.sin(rads)
        const x2 = 50 + r * Math.cos(rads2)
        const y2 = 50 + r * Math.sin(rads2)
        return (
          <path
            key={i}
            d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}
            fill="none"
            stroke={active ? c1 : c2}
            strokeWidth={active ? 2.5 : 1}
            opacity={active ? 0.7 : 0.2}
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

export default function WalletModal({ open, onClose }: Props) {
  const { address, connector } = useAccount()
  const { data: balance } = useBalance({ address })
  const { data: ensName } = useEnsName({ address, chainId: mainnet.id })
  const { data: ensAvatar } = useEnsAvatar({ name: ensName ?? undefined, chainId: mainnet.id })
  const { disconnect } = useDisconnect()
  const [copied, setCopied] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const shortAddr = address
    ? `${address.slice(0, 6)}···${address.slice(-4)}`
    : ''

  const balFormatted = balance
    ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}`
    : '—'

  const [grad1, grad2] = address ? addressToGradient(address) : ['#C8B89A', '#A89878']

  // Copy address
  const handleCopy = useCallback(() => {
    if (!address) return
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [address])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay listener to avoid immediate close from the same click
    const timer = setTimeout(() => document.addEventListener('mousedown', onClick), 50)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open, onClose])

  if (!open || !address) return null

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-[100] flex items-start justify-end pt-[72px] pr-4 md:pr-8">
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Modal */}
      <div
        ref={modalRef}
        className="relative z-10 w-[320px] animate-fade-slide-in overflow-hidden rounded-2xl border border-cream-15 bg-surface shadow-2xl shadow-black/40"
      >
        {/* ── Top gradient accent ── */}
        <div
          className="h-1"
          style={{
            background: `linear-gradient(90deg, ${grad1}, #C8B89A, ${grad2})`,
          }}
        />

        {/* ── Identity section ── */}
        <div className="flex flex-col items-center px-6 pt-6 pb-4">
          {/* Avatar */}
          <div className="relative mb-4 h-20 w-20">
            {/* Rotating ring */}
            <IdenticonRing address={address} />
            {/* Inner circle */}
            <div className="absolute inset-2 overflow-hidden rounded-full border-2 border-surface-tertiary">
              {ensAvatar ? (
                <img src={ensAvatar} alt="ENS" className="h-full w-full object-cover" />
              ) : (
                <div
                  className="h-full w-full"
                  style={{
                    background: `linear-gradient(135deg, ${grad1}, ${grad2})`,
                  }}
                />
              )}
            </div>
          </div>

          {/* Name / address */}
          {ensName ? (
            <>
              <span className="font-display text-lg font-bold tracking-wide text-cream">
                {ensName}
              </span>
              <button
                onClick={handleCopy}
                className="mt-1 flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-mono text-cream-50 transition-colors hover:bg-cream-08 hover:text-cream-80"
              >
                {shortAddr}
                <CopyIcon copied={copied} />
              </button>
            </>
          ) : (
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-full px-3 py-1 font-mono text-sm font-medium text-cream transition-colors hover:bg-cream-08"
            >
              {shortAddr}
              <CopyIcon copied={copied} />
            </button>
          )}

          {/* Balance */}
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="font-display text-2xl font-bold text-cream">
              {balance ? parseFloat(balance.formatted).toFixed(4) : '—'}
            </span>
            <span className="text-sm font-medium text-cream-50">
              {balance?.symbol ?? 'ETH'}
            </span>
          </div>

          {/* Network badge */}
          <div className="mt-2 flex items-center gap-1.5 rounded-full bg-cream-04 px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-slow" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-cream-50">
              Ethereum Mainnet
            </span>
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="mx-4 h-px bg-cream-08" />

        {/* ── Wallet info ── */}
        <div className="px-6 py-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-cream-35">Connected via</span>
            <span className="font-medium text-cream-65">{connector?.name ?? 'Wallet'}</span>
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="mx-4 h-px bg-cream-08" />

        {/* ── Actions ── */}
        <div className="grid grid-cols-3 gap-2 p-4">
          {/* View on Etherscan */}
          <a
            href={`https://etherscan.io/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-cream-08 bg-cream-04 px-2 py-2.5 text-[10px] font-medium text-cream-65 transition-all hover:border-cream-15 hover:bg-cream-08 hover:text-cream"
          >
            <EtherscanIcon />
            Etherscan
          </a>

          {/* View on DeBank */}
          <a
            href={`https://debank.com/profile/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-cream-08 bg-cream-04 px-2 py-2.5 text-[10px] font-medium text-cream-65 transition-all hover:border-cream-15 hover:bg-cream-08 hover:text-cream"
          >
            <DeBankIcon />
            DeBank
          </a>

          {/* Copy address */}
          <button
            onClick={handleCopy}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-cream-08 bg-cream-04 px-2 py-2.5 text-[10px] font-medium text-cream-65 transition-all hover:border-cream-15 hover:bg-cream-08 hover:text-cream"
          >
            <CopySmallIcon />
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* ── Disconnect ── */}
        <div className="px-4 pb-4">
          <button
            onClick={() => { disconnect(); onClose() }}
            className="group flex w-full items-center justify-center gap-2 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2.5 text-xs font-semibold text-danger/70 transition-all hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
          >
            <DisconnectIcon />
            Disconnect
          </button>
        </div>

        {/* ── Bottom brand ── */}
        <div className="flex items-center justify-center border-t border-cream-04 py-2.5">
          <span className="font-display text-[9px] font-bold uppercase tracking-[3px] text-cream-20">
            TeraSwap
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── Icons ── */
function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg className="h-3.5 w-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    )
  }
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

function CopySmallIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

function EtherscanIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline strokeLinecap="round" strokeLinejoin="round" points="15 3 21 3 21 9" />
      <line strokeLinecap="round" x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

function DeBankIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 4h8.5a8.5 8.5 0 010 17H3V4zm4 3.5v10h4.5a5 5 0 000-10H7z" />
    </svg>
  )
}

function DisconnectIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline strokeLinecap="round" strokeLinejoin="round" points="16 17 21 12 16 7" />
      <line strokeLinecap="round" x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}
