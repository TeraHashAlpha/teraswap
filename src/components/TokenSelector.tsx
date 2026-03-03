'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { DEFAULT_TOKENS, getAllTokens, type Token } from '@/lib/tokens'
import { useTokenImport } from '@/hooks/useTokenImport'

// ── Popular tokens shown as quick-select chips ────────────
const POPULAR_SYMBOLS = ['ETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'WETH', 'LINK', 'UNI']

// ── Category ranges for visual grouping (index-based) ─────
const CATEGORIES: { label: string; start: number; end: number }[] = [
  { label: 'Native + Wrapped', start: 0, end: 1 },
  { label: 'Stablecoins', start: 2, end: 9 },
  { label: 'BTC Wrapped', start: 10, end: 11 },
  { label: 'Liquid Staking', start: 12, end: 15 },
  { label: 'DeFi Blue Chips', start: 16, end: 31 },
  { label: 'L2 / Infrastructure', start: 32, end: 38 },
  { label: 'AI / Data', start: 39, end: 41 },
  { label: 'Memecoins', start: 42, end: 46 },
  { label: 'Gaming', start: 47, end: 50 },
  { label: 'Other', start: 51, end: 55 },
]

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

  // Focus input when modal opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  const isSearching = search.length > 0
  const q = search.toLowerCase()

  // Check if search looks like an address
  const isAddressSearch = /^0x[a-fA-F0-9]{40}$/.test(search.trim())

  const filtered = useMemo(() => {
    const all = getAllTokens()
    return all.filter(
      (t) =>
        t.address.toLowerCase() !== disabledAddress?.toLowerCase() &&
        (t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q)),
    )
  }, [search, disabledAddress])

  // Build category groups (only when not searching)
  const groups = useMemo(() => {
    if (isSearching) return null
    const disabled = disabledAddress?.toLowerCase()
    return CATEGORIES.map((cat) => {
      const tokens = DEFAULT_TOKENS.slice(cat.start, cat.end + 1).filter(
        (t) => t.address.toLowerCase() !== disabled,
      )
      return tokens.length > 0 ? { label: cat.label, tokens } : null
    }).filter(Boolean) as { label: string; tokens: Token[] }[]
  }, [disabledAddress, isSearching])

  const popularTokens = useMemo(() => {
    const disabled = disabledAddress?.toLowerCase()
    return POPULAR_SYMBOLS.map((sym) =>
      DEFAULT_TOKENS.find(
        (t) => t.symbol === sym && t.address.toLowerCase() !== disabled,
      ),
    ).filter(Boolean) as Token[]
  }, [disabledAddress])

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

      {/* Modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-start sm:pt-[15vh]"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-cream-08 bg-surface-secondary p-4 shadow-2xl shadow-black/40 sm:rounded-2xl"
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
            <div className="max-h-[50vh] overflow-y-auto scrollbar-thin sm:max-h-72">
              {isSearching ? (
                /* Flat search results */
                <>
                  {filtered.length > 0 && (
                    <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-cream-35">
                      {filtered.length} result{filtered.length !== 1 ? 's' : ''}
                    </p>
                  )}
                  {filtered.map((token) => (
                    <TokenRow key={token.address} token={token} onSelect={handleSelect} />
                  ))}

                  {/* Import custom token by address */}
                  {filtered.length === 0 && isAddressSearch && (
                    <div className="py-4 text-center">
                      <p className="mb-2 text-sm text-cream-50">Token not in list</p>
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
                /* Categorized list */
                groups?.map((group) => (
                  <div key={group.label} className="mb-1">
                    <p className="sticky top-0 z-10 bg-surface-secondary px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-cream-35">
                      {group.label}
                    </p>
                    {group.tokens.map((token) => (
                      <TokenRow key={token.address} token={token} onSelect={handleSelect} />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Token row component ─────────────────────────────────────
function TokenRow({ token, onSelect }: { token: Token; onSelect: (t: Token) => void }) {
  return (
    <button
      onClick={() => onSelect(token)}
      className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-hover"
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
        <div className="text-sm font-medium text-cream">{token.symbol}</div>
        <div className="truncate text-xs text-cream-35">{token.name}</div>
      </div>
    </button>
  )
}
