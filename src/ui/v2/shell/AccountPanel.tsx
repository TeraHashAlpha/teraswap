'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useBalance, useDisconnect, useEnsAvatar, useEnsName } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { getChainConfig } from '@/lib/chains/registry'
import { fmtToken } from '@/lib/format'
import { useQuoteChainId } from '@/hooks/useChainId'
import { Button } from '../primitives'
import { shortAddress } from './format-address'

/**
 * [ADR-025] Connected-account popover. Mirrors every element of v1's WalletModal (ENS name/avatar, address + copy,
 * balance, network, "Connected via", Explorer / DeBank / Copy, Disconnect) with v2 tokens. The network line shows
 * the SELECTED chain (v1's modal hardcodes "Ethereum Mainnet").
 */
export function AccountPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { address, connector } = useAccount()
  const chainId = useQuoteChainId()
  const { data: balance } = useBalance({ address })
  const { data: ensName } = useEnsName({ address, chainId: mainnet.id })
  const { data: ensAvatar } = useEnsAvatar({ name: ensName ?? undefined, chainId: mainnet.id })
  const { disconnect } = useDisconnect()
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const copy = useCallback(() => {
    if (!address) return
    void navigator.clipboard?.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [address])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Deferred like v1 so the click that opened the panel does not close it.
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 50)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, onClose])

  if (!open || !address) return null

  const chain = getChainConfig(chainId)
  const action =
    'flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-v2-control border border-v2-border bg-v2-surface2 px-2 py-2 text-[11px] text-v2-muted hover:text-v2-text'

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Account"
      className="absolute right-0 top-full z-50 mt-2 w-[320px] max-w-[calc(100vw-2rem)] rounded-v2-card border border-v2-border bg-v2-surface p-4 shadow-2xl shadow-black/40"
    >
      <div className="flex flex-col items-center gap-2 pb-3 text-center">
        {ensAvatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ensAvatar} alt="ENS avatar" className="h-14 w-14 rounded-full border border-v2-border object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-full border border-v2-border bg-v2-surface2 font-v2-mono text-sm text-v2-muted"
          >
            0x
          </span>
        )}
        {ensName ? <span className="font-v2-display text-lg uppercase text-v2-text">{ensName}</span> : null}
        <button type="button" onClick={copy} className="inline-flex min-h-[44px] items-center gap-2 font-v2-mono text-sm text-v2-text">
          {shortAddress(address)}
          <span aria-hidden="true" className="text-v2-muted">
            {copied ? '✓' : '⧉'}
          </span>
        </button>
        <div className="flex items-baseline gap-1.5 font-v2-mono text-v2-text">
          <span className="text-xl">{balance ? fmtToken(balance.formatted) : '—'}</span>
          <span className="text-sm text-v2-muted">{balance?.symbol ?? chain.nativeCurrency.symbol}</span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-v2-surface2 px-2.5 py-1 font-v2-mono text-[10px] uppercase tracking-wider text-v2-muted">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-v2-green" />
          {chain.name}
        </span>
      </div>

      <div className="flex items-center justify-between border-y border-v2-border py-2 text-xs">
        <span className="text-v2-dim">Connected via</span>
        <span className="text-v2-muted">{connector?.name ?? 'Wallet'}</span>
      </div>

      <div className="grid grid-cols-3 gap-2 py-3">
        <a href={`${chain.blockExplorer}/address/${address}`} target="_blank" rel="noopener noreferrer" className={action}>
          Explorer
        </a>
        <a href={`https://debank.com/profile/${address}`} target="_blank" rel="noopener noreferrer" className={action}>
          DeBank
        </a>
        <button type="button" onClick={copy} className={action}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <Button
        variant="secondary"
        className="w-full text-v2-red"
        onClick={() => {
          disconnect()
          onClose()
        }}
      >
        Disconnect
      </Button>
    </div>
  )
}
