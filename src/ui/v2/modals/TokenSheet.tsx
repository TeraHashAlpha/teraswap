'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { isNativeETH, type Token } from '@/lib/tokens'
import TokenLogo from '@/components/TokenLogo'
import { useTokenImport } from '@/hooks/useTokenImport'
import { explorerTokenUrl, isVerifiedToken } from '@/lib/chains/tokens'
import { Button, Chip, Input } from '../primitives'
import { shortAddress } from '../shell/format-address'
import { Sheet } from './Sheet'
import { useTokenList } from './use-token-list'

interface Props {
  onSelect: (token: Token) => void
  onClose: () => void
  /** The token already on the other side — v1 hides it from every list. */
  disabledAddress?: string
  /** v1's DCA spend selector hides native ETH; the swap card does not. */
  hideNativeInput?: boolean
}

function AddressLine({ token, chainId, full }: { token: Token; chainId: number; full?: boolean }) {
  const [copied, setCopied] = useState(false)
  if (isNativeETH(token)) return <span className="text-[12px] text-v2-muted">Native asset</span>
  const verified = isVerifiedToken(token.address, chainId)
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 font-v2-mono text-[12px] text-v2-muted">
      <span aria-hidden="true" className={verified ? 'text-v2-green' : 'text-v2-amber'}>
        {verified ? '✓' : '⚠'}
      </span>
      <span data-address="" title={token.address} className="break-all">
        {full ? token.address : shortAddress(token.address)}
      </span>
      <button
        type="button"
        aria-label={`Copy ${token.symbol} contract address`}
        onClick={() => {
          navigator.clipboard?.writeText(token.address).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="inline-flex min-h-[44px] items-center px-1 text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
      >
        <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
      {full && (
        <a href={explorerTokenUrl(token.address, chainId)} target="_blank" rel="noopener noreferrer" className="text-v2-cream underline underline-offset-2">
          Explorer
        </a>
      )}
    </span>
  )
}

function TokenRow({
  token,
  chainId,
  balance,
  imported,
  symbolCollision,
  onSelect,
  onRemove,
}: {
  token: Token
  chainId: number
  balance?: string
  imported: boolean
  symbolCollision: boolean
  onSelect: (t: Token) => void
  onRemove?: (address: string) => void
}) {
  const unavailable = token.unavailable === true
  return (
    <li className="ts-sheet-row py-1" data-token={token.address.toLowerCase()}>
      <button
        type="button"
        data-token-row=""
        disabled={unavailable}
        onClick={() => onSelect(token)}
        className={`ts-token-row flex min-h-[52px] w-full items-center gap-3 text-left focus-visible:outline-none ${unavailable ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <TokenLogo token={token} size={28} className="shrink-0 rounded-full" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="ts-token-sym font-v2-mono text-[15px] font-semibold text-v2-text">{token.symbol}</span>
            {imported && <span className="font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-v2-amber">Imported</span>}
          </span>
          <span className="block truncate text-[13px] text-v2-muted">{token.name}</span>
        </span>
        {balance && <span className="font-v2-mono text-[14px] tabular-nums text-v2-text">{balance}</span>}
      </button>
      <div className="flex items-center justify-between pl-[40px]">
        <div className="min-w-0">
          <AddressLine token={token} chainId={chainId} full={symbolCollision} />
          {symbolCollision && <div className="text-[12px] leading-snug text-v2-amber">Same symbol as a listed token — verify the contract address</div>}
          {unavailable && <div className="text-[12px] leading-snug text-v2-red">Unavailable — this chain no longer returns a valid ERC-20 at this address</div>}
        </div>
        {onRemove && (
          <Button variant="text" tone="danger" aria-label={`Remove ${token.symbol}`} onClick={() => onRemove(token.address)} className="shrink-0">
            Remove
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * [ADR-025] Round 7 frame 23 / m02 — the token selector as a full-bleed sheet. Data is v1's (use-token-list.ts mirrors
 * TokenSelector.tsx; useTokenImport / useImportedTokens are v1's hooks, so an import is read, sanitised, saved per chain and
 * re-validated by the same code that does it for v1). Copy is v1's verbatim; the frame's invented "All" chip and its re-worded
 * import notice are not carried over (content-map delta in the feedback file).
 */
export function TokenSheet({ onSelect, onClose, disabledAddress, hideNativeInput = false }: Props) {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { importToken, importing, error: importError } = useTokenImport()
  const list = useTokenList({ disabledAddress, hideNativeInput, search, activeCategory })

  const handleSelect = (token: Token) => {
    onSelect(token)
    onClose()
  }
  async function handleImport() {
    const token = await importToken(search.trim())
    if (token) handleSelect(token)
  }

  function rowButtons(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-token-row]:not([disabled])') ?? [])
  }
  // Arrow keys move through the rows from the search field and between rows; Home / End jump; Enter on a row selects (a button).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const rows = rowButtons()
    if (rows.length === 0) return
    const inInput = document.activeElement === searchRef.current
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (inInput && e.key !== 'ArrowDown') return
    e.preventDefault()
    let next = at
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(at + 1, rows.length - 1)
    else if (e.key === 'ArrowUp') {
      if (at <= 0) {
        searchRef.current?.focus()
        return
      }
      next = at - 1
    } else if (e.key === 'Home') next = 0
    else next = rows.length - 1
    rows[next].focus()
  }

  const renderRow = (token: Token) => {
    const addr = token.address.toLowerCase()
    const imported = list.importedAddrs.has(addr)
    return (
      <TokenRow
        key={token.address}
        token={token}
        chainId={list.chainId}
        balance={list.balanceMap.get(addr)?.formatted}
        imported={imported}
        symbolCollision={imported && list.catalogSymbols.has(token.symbol.toLowerCase())}
        onSelect={handleSelect}
        onRemove={imported ? list.removeImported : undefined}
      />
    )
  }

  const heading = (text: string, accent = false) => (
    <p className={`mt-3 font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] ${accent ? 'text-v2-cream' : 'text-v2-muted'}`}>{text}</p>
  )

  return (
    <Sheet name="token" size="md" title="Select token" onClose={onClose} closeButton initialFocusRef={searchRef}>
      {/* The sheet is one keyboard scope: arrows reach the rows from the search field. */}
      <div onKeyDown={onKeyDown}>
        <Input
          ref={searchRef}
          type="text"
          className="mt-4"
          placeholder="Search name, symbol or paste address..."
          aria-label="Search name, symbol or paste address"
          autoComplete="off"
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {list.availableCategories.length > 0 && (
          <div role="group" aria-label="Filter tokens by category" className="ts-scroll-x mt-2">
            {list.availableCategories.map((cat) => (
              <Chip key={cat} selected={activeCategory === cat} onClick={() => setActiveCategory((prev) => (prev === cat ? null : cat))} className="shrink-0">
                {cat}
              </Chip>
            ))}
          </div>
        )}

        {!list.isSearching && activeCategory === null && list.popularTokens.length > 0 && (
          <div data-popular="" className="ts-scroll-x mt-1">
            {list.popularTokens.map((token) => (
              <Chip key={token.address} onClick={() => handleSelect(token)} className="shrink-0 gap-1.5 !text-v2-text">
                <TokenLogo token={token} size={16} className="rounded-full" />
                {token.symbol}
              </Chip>
            ))}
          </div>
        )}

        <div ref={listRef} className="ts-sheet-list mt-2 ts-v2-rule-t" data-token-list="">
          {list.isSearching ? (
            <>
              {list.filtered.length > 0 && (
                <p className="mt-2 font-v2-mono text-[11px] uppercase tracking-[1.5px] text-v2-muted">
                  {list.filtered.length === list.resultLimit ? `first ${list.resultLimit} results — refine to narrow` : `${list.filtered.length} result${list.filtered.length !== 1 ? 's' : ''}`}
                </p>
              )}
              <ul>{list.normalMatches.map(renderRow)}</ul>
              {list.lowLiquidityMatches.length > 0 && (
                <div className="mt-2 ts-v2-rule-t">
                  {heading('Low liquidity / unverified')}
                  <ul>{list.lowLiquidityMatches.map(renderRow)}</ul>
                </div>
              )}
              {list.filtered.length === 0 && list.isAddressSearch && (
                <div className="py-4" data-import="">
                  <p className="text-[15px] text-v2-text">Token not in list</p>
                  <p className="mt-1 break-all font-v2-mono text-[12px] text-v2-muted">{search.trim()}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-v2-amber">
                    You are importing a token not in TeraSwap&apos;s default list. Anyone can create a token using any symbol or name. Verify the contract address matches the official source.
                  </p>
                  <Button variant="text" className="mt-2" onClick={handleImport} disabled={importing}>
                    {importing ? 'Importing...' : 'Import token'}
                  </Button>
                  {importError && <p className="mt-2 text-[12px] text-v2-red">{importError}</p>}
                </div>
              )}
              {list.filtered.length === 0 && !list.isAddressSearch && (
                <div className="py-6">
                  <p className="text-[15px] text-v2-muted">No tokens found</p>
                  <p className="mt-1 text-[12px] text-v2-dim">Paste a contract address to import any ERC-20 token</p>
                </div>
              )}
            </>
          ) : (
            <>
              {list.tokensWithBalance.length > 0 && (
                <div>
                  {heading('Your Tokens', true)}
                  <ul>{list.tokensWithBalance.map(renderRow)}</ul>
                </div>
              )}
              {list.groups?.map((group) => (
                <div key={group.label}>
                  {heading(group.label)}
                  <ul>{group.tokens.map(renderRow)}</ul>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Sheet>
  )
}
