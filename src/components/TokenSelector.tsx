'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_TOKENS, getAllTokens, CATEGORY_DISPLAY_ORDER, type Token } from '@/lib/tokens'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import TokenAddressBadge from './TokenAddressBadge'
import { useTokenImport } from '@/hooks/useTokenImport'
import { useActiveChainId } from '@/hooks/useChainId'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { getChainTokenList, getPopularTokens } from '@/lib/chains/tokens'

// ── Popular tokens shown as quick-select chips ────────────
const POPULAR_SYMBOLS = ['ETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'WETH', 'LINK', 'UNI']


interface Props {
  selected: Token | null
  onSelect: (token: Token) => void
  disabledAddress?: string
}

export default function TokenSelector({ selected, onSelect, disabledAddress }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { importToken, importing, error: importError } = useTokenImport()
  const balanceMap = useTokenBalances()
  // [P221] Per-chain token catalog. Mainnet keeps the full DEFAULT_TOKENS list
  // (categories + balances) exactly as before; other chains browse their own
  // catalog. Memoised so the dependent lists below stay referentially stable.
  const activeChainId = useActiveChainId()
  const isMainnet = activeChainId === DEFAULT_CHAIN_ID
  const catalog = useMemo(
    () => (isMainnet ? DEFAULT_TOKENS : getChainTokenList(activeChainId)),
    [isMainnet, activeChainId],
  )

  // Focus input when modal opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  const isSearching = search.length > 0
  const q = search.toLowerCase()

  // Check if search looks like an address
  const isAddressSearch = /^0x[a-fA-F0-9]{40}$/.test(search.trim())

  const filtered = useMemo(() => {
    const all = isMainnet ? getAllTokens() : catalog
    return all.filter(
      (t) =>
        t.address.toLowerCase() !== disabledAddress?.toLowerCase() &&
        (t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q)),
    )
  }, [search, disabledAddress, isMainnet, catalog])

  // Tokens with balance — sorted highest first, shown above categories
  const tokensWithBalance = useMemo(() => {
    const disabled = disabledAddress?.toLowerCase()
    return catalog
      .filter((t) => {
        const addr = t.address.toLowerCase()
        return addr !== disabled && balanceMap.has(addr)
      })
      .sort((a, b) => {
        const balA = balanceMap.get(a.address.toLowerCase())?.raw ?? 0n
        const balB = balanceMap.get(b.address.toLowerCase())?.raw ?? 0n
        // Sort by USD-approximate value: raw * rough price factor
        // For simplicity, sort by raw amount (tokens with balance first)
        if (balB > balA) return 1
        if (balA > balB) return -1
        return 0
      })
  }, [disabledAddress, balanceMap, catalog])

  // Build category groups (only when not searching), excluding tokens already shown in "Your tokens"
  const groups = useMemo(() => {
    if (isSearching) return null
    const disabled = disabledAddress?.toLowerCase()
    const balanceAddrs = new Set(tokensWithBalance.map((t) => t.address.toLowerCase()))
    const categoryMap = new Map<string, Token[]>()
    for (const token of catalog) {
      const addr = token.address.toLowerCase()
      if (addr === disabled || balanceAddrs.has(addr)) continue
      const cat = token.category || 'Other'
      if (!categoryMap.has(cat)) categoryMap.set(cat, [])
      categoryMap.get(cat)!.push(token)
    }
    return CATEGORY_DISPLAY_ORDER
      .filter((cat) => categoryMap.has(cat))
      .map((cat) => ({ label: cat, tokens: categoryMap.get(cat)! }))
  }, [disabledAddress, isSearching, tokensWithBalance, catalog])

  const popularTokens = useMemo(() => {
    const disabled = disabledAddress?.toLowerCase()
    if (!isMainnet) {
      // [P221] Non-mainnet: the chain catalog's popular tokens.
      const popularAddrs = new Set(getPopularTokens(activeChainId).map((t) => t.address.toLowerCase()))
      return catalog.filter(
        (t) => popularAddrs.has(t.address.toLowerCase()) && t.address.toLowerCase() !== disabled,
      )
    }
    return POPULAR_SYMBOLS.map((sym) =>
      DEFAULT_TOKENS.find(
        (t) => t.symbol === sym && t.address.toLowerCase() !== disabled,
      ),
    ).filter(Boolean) as Token[]
  }, [disabledAddress, isMainnet, activeChainId, catalog])

  function handleSelect(token: Token) {
    onSelect(token)
    setOpen(false)
    setSearch('')
  }

  async function handleImportToken() {
    const token = await importToken(search.trim())
    if (token) {
      handleSelect(token)
    }
  }

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-cream-15 bg-surface-hover px-3 py-1.5 text-sm font-semibold text-cream-95 transition hover:border-cream-35 hover:bg-cream-05"
      >
        {selected ? (
          <>
            <img src={selected.logoURI} alt="" className="h-5 w-5 rounded-full" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            {selected.symbol}
          </>
        ) : (
          <span className="text-cream-65">Select</span>
        )}
        <span className="text-cream-50">&#9662;</span>
      </button>

      {/* Modal — rendered via Portal to escape backdrop-filter containing block */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-[#080B10] sm:items-start sm:pt-[15vh]"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-cream-08 bg-[#0F1318] p-4 shadow-2xl shadow-black/60 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-cream">Select token</h3>
              <button onClick={() => { setOpen(false); setSearch('') }} className="text-cream-35 transition hover:text-cream">&#10005;</button>
            </div>

            {/* Search input */}
            <input
              ref={inputRef}
              type="text"
              placeholder="Search name, symbol or paste address..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-3 w-full rounded-xl border border-cream-08 bg-surface-tertiary px-3 py-2.5 text-sm text-cream placeholder:text-cream-35 outline-none focus:border-cream-35 transition-colors"
            />

            {/* Popular tokens — quick select chips */}
            {!isSearching && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {popularTokens.map((token) => (
                  <button
                    key={token.address}
                    onClick={() => handleSelect(token)}
                    className="flex items-center gap-1.5 rounded-full border border-cream-08 bg-surface-tertiary px-2.5 py-1 text-xs font-medium text-cream-80 transition hover:border-cream-35 hover:bg-cream-05 hover:text-cream"
                  >
                    <img src={token.logoURI} alt="" className="h-4 w-4 rounded-full" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    {token.symbol}
                  </button>
                ))}
              </div>
            )}

            {/* Divider */}
            <div className="mb-2 border-t border-cream-08" />

            {/* Token list */}
            <div className="max-h-[50vh] overflow-y-auto bg-[#0F1318] scrollbar-thin sm:max-h-72">
              {isSearching ? (
                /* Flat search results */
                <>
                  {filtered.length > 0 && (
                    <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-cream-35">
                      {filtered.length} result{filtered.length !== 1 ? 's' : ''}
                    </p>
                  )}
                  {filtered.map((token) => (
                    <TokenRow key={token.address} token={token} onSelect={handleSelect} balance={balanceMap.get(token.address.toLowerCase())?.formatted} />
                  ))}

                  {/* Import custom token by address */}
                  {filtered.length === 0 && isAddressSearch && (
                    <div className="py-4 text-center">
                      <p className="mb-2 text-sm text-cream-50">Token not in list</p>
                      <div className="mb-2">
                        <TokenAddressBadge address={search.trim() as `0x${string}`} isVerified={false} size="md" />
                      </div>
                      <p className="mb-3 px-4 text-[10px] leading-relaxed text-amber-300/70">
                        You are importing a token not in TeraSwap&apos;s default list. Anyone can create a token using any symbol or name. Verify the contract address matches the official source.
                      </p>
                      <button
                        onClick={handleImportToken}
                        disabled={importing}
                        className="rounded-lg border border-cream-gold bg-transparent px-4 py-2 text-xs font-semibold text-cream-gold transition hover:bg-cream-gold hover:text-[#080B10] disabled:opacity-50"
                      >
                        {importing ? 'Importing...' : 'Import token'}
                      </button>
                      {importError && (
                        <p className="mt-2 text-[11px] text-danger">{importError}</p>
                      )}
                    </div>
                  )}

                  {filtered.length === 0 && !isAddressSearch && (
                    <div className="py-6 text-center">
                      <p className="text-sm text-cream-35">No tokens found</p>
                      <p className="mt-1 text-[10px] text-cream-20">Paste a contract address to import any ERC-20 token</p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* ── Your tokens (with balance) — shown first ── */}
                  {tokensWithBalance.length > 0 && (
                    <div className="mb-1">
                      <p className="sticky top-0 z-10 bg-[#0F1318] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-cream-gold">
                        Your Tokens
                      </p>
                      {tokensWithBalance.map((token) => (
                        <TokenRow
                          key={token.address}
                          token={token}
                          onSelect={handleSelect}
                          balance={balanceMap.get(token.address.toLowerCase())?.formatted}
                        />
                      ))}
                    </div>
                  )}

                  {/* ── Categorized list (without tokens already in "Your Tokens") ── */}
                  {groups?.map((group) => (
                    <div key={group.label} className="mb-2">
                      <p className="bg-[#0F1318] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-cream-35">
                        {group.label}
                      </p>
                      {group.tokens.map((token) => (
                        <TokenRow key={token.address} token={token} onSelect={handleSelect} balance={balanceMap.get(token.address.toLowerCase())?.formatted} />
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Token row component ─────────────────────────────────────
function TokenRow({ token, onSelect, balance }: { token: Token; onSelect: (t: Token) => void; balance?: string }) {
  return (
    <button
      onClick={() => onSelect(token)}
      className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-[#1E2530]"
    >
      <img
        src={token.logoURI}
        alt=""
        className="h-8 w-8 rounded-full bg-surface-tertiary"
        onError={(e) => {
          const img = e.target as HTMLImageElement
          img.style.display = 'none'
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-cream-gold">{token.symbol}</div>
        <div className="truncate text-xs text-cream-35">{token.name}</div>
        <TokenAddressBadge address={token.address} size="sm" showExplorerLink={false} />
      </div>
      {balance && (
        <div className="text-right">
          <div className="text-sm font-medium text-cream-80">{balance}</div>
        </div>
      )}
    </button>
  )
}
