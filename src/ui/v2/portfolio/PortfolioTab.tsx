'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import { useActiveApprovals } from '@/hooks/useActiveApprovals'
import { useActiveChainId } from '@/hooks/useChainId'
import { usePortfolio, type PortfolioToken } from '@/hooks/usePortfolio'
import { useTokenImport } from '@/hooks/useTokenImport'
import { getChainConfig } from '@/lib/chains/registry'
import { fmtUsd } from '@/lib/format'
import type { Token } from '@/lib/tokens'
import { Button, Skeleton } from '../primitives'
import { rowNavKeyDown } from '../orders/keyboard'
import { ApprovalsPanel } from './ApprovalsPanel'
import { approvalRows, formatLastUpdated, groupPortfolio, shortenAddress } from './portfolio-model'
import './portfolio.css'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'
const DASH = '—' // v1's literal for an unpriced total / row

/** v1 `TokenAvatar`: the token logo, or its first letter on a disc when there is none / it fails to load. Decorative. */
function TokenAvatar({ token }: { token: Token }) {
  const [errored, setErrored] = useState(false)
  if (errored || !token.logoURI) {
    return (
      <span className="ts-pf-avatar" aria-hidden="true">
        {token.symbol.charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img src={token.logoURI} alt={`${token.symbol} logo`} width={32} height={32} className="ts-pf-avatar ts-pf-avatar-img" onError={() => setErrored(true)} />
  )
}

/**
 * One holding as a hairline row (round7 44 / m06): avatar · symbol / name (/ the shortened address while still un-imported) · balance / USD ·
 * Swap (curated, or imported) or Add (discovered, not yet imported). Balance text is the hook's `fmtToken`; USD is `fmtUsd(valueUsd)` — v1's.
 */
function HoldingRow({ entry, discovered, imported, onAdd, onSwap }: { entry: PortfolioToken; discovered: boolean; imported: boolean; onAdd: (t: Token) => void; onSwap: (t: Token) => void }) {
  const { token, balanceFormatted, valueUsd } = entry
  const showAdd = discovered && !imported
  return (
    <li className="ts-pf-row" data-testid="holding-row" data-token={token.address.toLowerCase()} data-discovered={showAdd ? 'true' : undefined}>
      <TokenAvatar token={token} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold text-v2-text">{token.symbol}</div>
        <div className="truncate text-[13px] text-v2-muted">{token.name}</div>
        {showAdd && (
          <div className="mt-0.5 font-v2-mono text-[12px] text-v2-dim" title={token.address}>
            {shortenAddress(token.address)}
          </div>
        )}
      </div>
      <div className="ts-pf-amount text-right">
        <div className="font-v2-mono text-[15px] font-semibold tabular-nums text-v2-text">{balanceFormatted}</div>
        <div className="font-v2-mono text-[13px] tabular-nums text-v2-muted">{valueUsd !== null ? fmtUsd(valueUsd) : DASH}</div>
      </div>
      {showAdd ? (
        <Button variant="text" onClick={() => onAdd(token)} aria-label={`Add ${token.symbol} to tokens`} data-pf-action="" data-testid="holding-add">Add</Button>
      ) : (
        <Button variant="text" onClick={() => onSwap(token)} aria-label={`Swap ${token.symbol}`} data-pf-action="" data-testid="holding-swap">Swap</Button>
      )}
    </li>
  )
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'ts-pf-spin' : ''} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

/**
 * [ADR-025 / B8] The Portfolio tab (round7 44 / 45a / 45b / m06) over v1's `usePortfolio()` — the SAME hook v1's PortfolioTab calls, unchanged:
 * the active chain's held tokens, the USD figures, the total, loading / error / availability. v1 is ONE chain at a time (the header's chain),
 * so is this tab: switching the chain re-runs the hook, and the tab never shows another chain's tokens. Every word is v1's. Nothing here signs
 * or sends except the user's own Revoke press (the Active Approvals panel, see `ApprovalsPanel`).
 */
export function PortfolioTab() {
  const { isConnected, address } = useAccount()
  const { tokens, totalValueUsd, isLoading, isError, lastUpdated, refresh, isChainSupported } = usePortfolio()
  const { importToken } = useTokenImport()
  const activeChainId = useActiveChainId()
  const router = useRouter()
  const chainDisplayName = (() => {
    try { return getChainConfig(activeChainId).name } catch { return 'this chain' }
  })()

  // v1: tokens imported from this view rejoin the curated look (solid row, Swap, no address).
  const [importedAddrs, setImportedAddrs] = useState<Set<string>>(new Set())
  const handleAdd = async (token: Token) => {
    const lower = token.address.toLowerCase()
    if (importedAddrs.has(lower)) return
    const result = await importToken(token.address)
    if (result) setImportedAddrs((prev) => new Set(prev).add(lower))
  }
  // v1: Swap → the Swap tab (`setSwapMode('instant')`; v1 does not carry the token over either).
  const handleSwap = useCallback((_token: Token) => router.push('/swap'), [router])

  // v1's once-a-second clock for "Last updated …"; idle without a timestamp.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!lastUpdated) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [lastUpdated])

  const { grouped, discovered } = useMemo(() => groupPortfolio(tokens), [tokens])

  const { approvals, markRevoked } = useActiveApprovals()
  const [revokedIds, setRevokedIds] = useState<ReadonlySet<string>>(new Set())
  const onRevoked = useCallback((id: string) => {
    markRevoked(id)
    setRevokedIds((prev) => new Set(prev).add(id))
  }, [markRevoked])
  const approvalList = approvalRows(approvals, revokedIds)
  const actionableCount = approvals.filter((a) => a.active && a.needsRevoke).length

  const rootRef = useRef<HTMLElement>(null)

  if (!isConnected) {
    return (
      <section className="ts-pf" aria-label="Portfolio" data-testid="portfolio-disconnected">
        <p className="ts-pf-empty text-[15px] text-v2-muted">Connect your wallet to view your portfolio</p>
      </section>
    )
  }

  const approvalsPanel = approvalList.length > 0 && <ApprovalsPanel rows={approvalList} count={actionableCount} address={address} onRevoked={onRevoked} />

  if (!isChainSupported) {
    return (
      <section className={`ts-pf${approvalsPanel ? ' ts-pf--aside' : ''}`} aria-label="Portfolio" data-testid="portfolio">
        <div className="ts-pf-main">
          <p className="ts-pf-empty text-[15px] text-v2-muted" data-testid="portfolio-chain-unavailable">Portfolio isn&apos;t available on {chainDisplayName} yet.</p>
        </div>
        {approvalsPanel}
      </section>
    )
  }

  const initialLoad = isLoading && tokens.length === 0 && !isError

  return (
    <section ref={rootRef} className={`ts-pf${approvalsPanel ? ' ts-pf--aside' : ''}`} aria-label="Portfolio" data-testid="portfolio" onKeyDown={rowNavKeyDown('[data-pf-action]')}>
      <div className="ts-pf-main">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`${CAPS} text-v2-muted`}>Total value</div>
            <div className="mt-2 font-v2-display text-[44px] font-bold leading-none tabular-nums text-v2-text" data-testid="portfolio-total">
              {totalValueUsd !== null ? fmtUsd(totalValueUsd) : DASH}
            </div>
            <div className="mt-2 text-[13px] text-v2-muted" data-testid="portfolio-updated">
              {lastUpdated ? `Last updated ${formatLastUpdated(lastUpdated, now)}` : 'Loading prices…'}
            </div>
          </div>
          <Button variant="icon" onClick={refresh} disabled={isLoading} aria-label="Refresh portfolio" data-testid="portfolio-refresh">
            <RefreshIcon spinning={isLoading} />
          </Button>
        </div>

        {isError && (
          <div className="ts-pf-error" role="alert" data-testid="portfolio-error">
            <span className="text-[14px] text-v2-red">Failed to load portfolio.</span>
            <Button variant="text" tone="danger" onClick={refresh}>Try again</Button>
          </div>
        )}

        {initialLoad && (
          <div aria-busy="true" data-testid="portfolio-loading">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="ts-pf-row">
                <Skeleton width={32} height={32} style={{ borderRadius: '50%' }} />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton width={96} height={14} />
                  <Skeleton width={64} height={10} />
                </div>
                <Skeleton width={72} height={14} />
              </div>
            ))}
          </div>
        )}

        {!isLoading && !isError && tokens.length === 0 && (
          <p className="ts-pf-empty text-[15px] text-v2-muted" data-testid="portfolio-empty">No tokens found in this wallet on {chainDisplayName}.</p>
        )}

        {grouped.map(([category, entries]) => (
          <section key={category} className="ts-pf-group" aria-label={category} data-testid="holdings-group" data-category={category}>
            <h3 className={`${CAPS} ts-pf-label text-v2-muted`}>{category}</h3>
            <ul role="list">
              {entries.map((entry) => (
                <HoldingRow key={entry.token.address} entry={entry} discovered={false} imported={false} onAdd={handleAdd} onSwap={handleSwap} />
              ))}
            </ul>
          </section>
        ))}

        {discovered.length > 0 && (
          <section className="ts-pf-group" aria-label="Discovered in Wallet" data-testid="holdings-discovered">
            <h3 className={`${CAPS} ts-pf-label text-v2-muted`}>Discovered in Wallet</h3>
            <ul role="list">
              {discovered.map((entry) => (
                <HoldingRow key={entry.token.address} entry={entry} discovered imported={importedAddrs.has(entry.token.address.toLowerCase())} onAdd={handleAdd} onSwap={handleSwap} />
              ))}
            </ul>
          </section>
        )}
      </div>
      {approvalsPanel}
    </section>
  )
}
