/**
 * [fix/imported-tokens-persist] Per-chain localStorage persistence for tokens the user imported
 * by address. Owner rule: an import NEVER disappears on reload or a new visit — it stays in this
 * browser, per chain, until the user removes it.
 *
 * Key: `ts:imported-tokens:v1:<chainId>` → JSON array of ImportedTokenRecord. The schema version
 * lives in the key, so a future shape change reads a fresh key instead of mis-parsing this one.
 *
 * Token metadata ONLY (address/symbol/name/decimals/importedAt) — never balances, never anything
 * about the user. Every storage touch is try/catch: private mode, blocked site data, a full
 * quota or SSR all degrade to "not persisted", never to a crash.
 */
import { getAddress, isAddress } from 'viem'

export interface ImportedTokenRecord {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  /** Epoch ms of the import. */
  importedAt: number
}

export const IMPORTED_TOKENS_KEY_PREFIX = 'ts:imported-tokens:v1:'

export const importedTokensKey = (chainId: number): string => `${IMPORTED_TOKENS_KEY_PREFIX}${chainId}`

// Same bounds useTokenImport's sanitizeTokenField enforces at import time (symbol 20, name 64).
const MAX_SYMBOL = 20
const MAX_NAME = 64

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null // accessing localStorage itself can throw (blocked site data)
  }
}

/** A record is kept only if every field has the expected shape; one bad entry never poisons the rest. */
function parseRecord(raw: unknown): ImportedTokenRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.address !== 'string' || !isAddress(r.address, { strict: false })) return null
  if (typeof r.symbol !== 'string' || r.symbol.length === 0 || r.symbol.length > MAX_SYMBOL) return null
  if (typeof r.name !== 'string' || r.name.length > MAX_NAME) return null
  if (/[<>]/.test(r.symbol) || /[<>]/.test(r.name)) return null
  if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 255) return null
  if (typeof r.importedAt !== 'number' || !Number.isFinite(r.importedAt)) return null
  return {
    address: getAddress(r.address),
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
    importedAt: r.importedAt,
  }
}

/** Imports saved for `chainId`. Corrupt or unreadable storage yields `[]` (or just the valid entries). */
export function loadImportedTokens(chainId: number): ImportedTokenRecord[] {
  try {
    const raw = storage()?.getItem(importedTokensKey(chainId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: ImportedTokenRecord[] = []
    for (const item of parsed) {
      const rec = parseRecord(item)
      if (!rec || seen.has(rec.address.toLowerCase())) continue
      seen.add(rec.address.toLowerCase())
      out.push(rec)
    }
    return out
  } catch {
    return []
  }
}

function write(chainId: number, records: ImportedTokenRecord[]): void {
  try {
    const s = storage()
    if (!s) return
    if (records.length === 0) s.removeItem(importedTokensKey(chainId))
    else s.setItem(importedTokensKey(chainId), JSON.stringify(records))
  } catch {
    // quota / private mode — the import still works for this session, it just won't persist
  }
}

/** Saves (or refreshes, keeping the original `importedAt`) one import for `chainId`. */
export function saveImportedToken(chainId: number, rec: Omit<ImportedTokenRecord, 'importedAt'> & { importedAt?: number }): void {
  const addr = getAddress(rec.address)
  const current = loadImportedTokens(chainId)
  const prev = current.find((t) => t.address.toLowerCase() === addr.toLowerCase())
  const next: ImportedTokenRecord = {
    address: addr,
    symbol: rec.symbol,
    name: rec.name,
    decimals: rec.decimals,
    importedAt: prev?.importedAt ?? rec.importedAt ?? Date.now(),
  }
  write(chainId, [...current.filter((t) => t.address.toLowerCase() !== addr.toLowerCase()), next])
}

/** The ONLY way a persisted import leaves storage: the user's explicit Remove. */
export function removeImportedToken(chainId: number, address: string): void {
  const addr = address.toLowerCase()
  write(chainId, loadImportedTokens(chainId).filter((t) => t.address.toLowerCase() !== addr))
}
