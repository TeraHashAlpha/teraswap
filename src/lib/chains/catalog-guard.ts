/**
 * catalog-guard — pure audit logic for the curated token catalog.
 *
 * Validates EVERY catalog token against the four failure classes seen this sprint:
 *   1. dead address          (W / USDe / weETH — no on-chain bytecode)
 *   2. wrong/untrusted addr   (not in any reputable token list)
 *   3. non-transferable       (legacy MORPHO — transfer reverts; ADVISORY, see below)
 *   4. duplicate symbol       (legacy + current MORPHO both present on one chain)
 *
 * The on-chain signals (bytecode / transferability) come from a DETERMINISTIC cached
 * fixture (catalog-guard.trust.json) refreshed out-of-band by scripts/refresh-catalog-guard.ts —
 * this module performs NO network I/O, so the gate is reproducible and never flaky.
 *
 * Severities:
 *   • fatal — reds the gate: missing-verdict, hasBytecode===false, non-allowlisted
 *     trusted-list miss, non-allowlisted duplicate symbol.
 *   • warn  — advisory only (never reds the gate): inTrustedList===null / hasBytecode===null
 *     (refresh couldn't reach CoinGecko / RPC) and transferable===false. Transferability is
 *     advisory because the read-only `transfer(0x..dead,0)` probe also reverts for some
 *     perfectly transferable tokens (e.g. USDT), so it can flag but must not fail.
 */

export interface TokenLike {
  address: string
  symbol: string
  /** Catalog decimals — cross-checked against on-chain decimals() when present. */
  decimals?: number
}

export interface Verdict {
  chainId: number
  address: string
  symbol: string
  inTrustedList: boolean | null
  hasBytecode: boolean | null
  transferable: boolean | null
  /** On-chain symbol() recorded at refresh — binds the verdict to the token IDENTITY. null = bytes32/RPC-fail. */
  onchainSymbol?: string | null
  /** On-chain decimals() recorded at refresh — cross-checked vs the catalog. null = RPC-fail/non-standard. */
  decimals?: number | null
}

export interface Allowlist {
  nativeEth: string
  trustedListExempt: Array<{ chainId: number; address: string; symbol: string; reason: string }>
  /** Pre-existing deprecated/migrated legacy tokens — exempt from the trusted-list FATAL but emit an advisory warn. */
  knownDeprecated?: Array<{ chainId: number; address: string; symbol: string; canonicalAddress?: string; reason: string }>
  /** Catalog symbol legitimately differs from on-chain symbol() (artifact/rebrand/wrap). Pinned to the expected on-chain symbol. */
  symbolMismatchExempt?: Array<{ chainId: number; address: string; symbol: string; onchainSymbol: string; reason: string }>
  duplicateSymbolExempt: Array<{ chainId: number; symbol: string; addresses: string[]; reason: string }>
}

export interface Finding {
  severity: 'fatal' | 'warn'
  check: 'bytecode' | 'trusted-list' | 'duplicate-symbol' | 'transferable' | 'verdict-cache' | 'deprecated' | 'identity' | 'decimals'
  chainId: number
  symbol: string
  address: string
  message: string
}

const lc = (s: string) => s.toLowerCase()

/**
 * Audit one chain's catalog against its verdicts + the allowlist. Pure; returns findings.
 * `verdicts` may cover multiple chains — only those matching `chainId` are used.
 */
export function auditChain(
  chainId: number,
  tokens: TokenLike[],
  verdicts: Verdict[],
  allowlist: Allowlist,
): Finding[] {
  const findings: Finding[] = []
  const nativeEth = lc(allowlist.nativeEth)
  const verdictByAddr = new Map<string, Verdict>()
  for (const v of verdicts) {
    if (v.chainId === chainId) verdictByAddr.set(lc(v.address), v)
  }
  const trustExempt = new Set(
    allowlist.trustedListExempt.filter((e) => e.chainId === chainId).map((e) => lc(e.address)),
  )
  const deprecated = new Set(
    (allowlist.knownDeprecated ?? []).filter((e) => e.chainId === chainId).map((e) => lc(e.address)),
  )
  // address → expected on-chain symbol (UPPER) for legit catalog/on-chain symbol mismatches.
  const symbolMismatch = new Map<string, string>()
  for (const e of allowlist.symbolMismatchExempt ?? []) {
    if (e.chainId === chainId) symbolMismatch.set(lc(e.address), e.onchainSymbol.toUpperCase())
  }

  for (const t of tokens) {
    const addr = lc(t.address)
    if (addr === nativeEth) continue // native-ETH sentinel: not an ERC-20

    const v = verdictByAddr.get(addr)
    if (!v) {
      findings.push({
        severity: 'fatal', check: 'verdict-cache', chainId, symbol: t.symbol, address: t.address,
        message: `no cached on-chain verdict — run \`npm run guard:refresh\` and commit catalog-guard.trust.json (a token may only enter the catalog after its address is verified).`,
      })
      continue
    }

    // ⓪ cache freshness — the cached row's symbol must match the live catalog symbol; otherwise the
    // catalog changed at this address without a refresh (stale cache) ⇒ fatal (fail-closed).
    if (v.symbol && lc(v.symbol) !== lc(t.symbol)) {
      findings.push({ severity: 'fatal', check: 'verdict-cache', chainId, symbol: t.symbol, address: t.address, message: `stale cache: verdict symbol "${v.symbol}" ≠ catalog symbol "${t.symbol}" at this address — run \`npm run guard:refresh\`.` })
    }

    // ① bytecode — dead address ⇒ fatal. null ⇒ advisory (RPC unreachable at refresh).
    if (v.hasBytecode === false) {
      findings.push({ severity: 'fatal', check: 'bytecode', chainId, symbol: t.symbol, address: t.address, message: 'no on-chain bytecode — address is not a deployed contract (dead/undeployed).' })
    } else if (v.hasBytecode === null) {
      findings.push({ severity: 'warn', check: 'bytecode', chainId, symbol: t.symbol, address: t.address, message: 'bytecode unknown (RPC unreachable at refresh) — re-run refresh.' })
    }

    // ①ᵇ identity — on-chain symbol() must equal the catalog symbol (catches a typo/swap to ANOTHER
    // live token under the same symbol), unless a symbolMismatchExempt entry pins the expected value.
    if (v.onchainSymbol != null && lc(v.onchainSymbol) !== lc(t.symbol)) {
      const expected = symbolMismatch.get(addr)
      if (!(expected && expected === v.onchainSymbol.toUpperCase())) {
        findings.push({ severity: 'fatal', check: 'identity', chainId, symbol: t.symbol, address: t.address, message: `on-chain symbol() = "${v.onchainSymbol}" but catalog symbol = "${t.symbol}" — the address may be a different token. Correct the address, or add a symbolMismatchExempt entry if this is a legit rebrand/wrap/artifact.` })
      }
    }

    // ①ᶜ decimals — catalog `decimals` MUST equal the on-chain `decimals()`. FUND-AFFECTING: the swap path
    // sizes amounts with `token.decimals` via parseUnits/formatUnits (useSwap.ts), so a mismatch corrupts the
    // raw sell amount + balance/allowance math. null ⇒ advisory (RPC/non-standard at refresh).
    if (typeof t.decimals === 'number' && v.decimals != null && v.decimals !== t.decimals) {
      findings.push({ severity: 'fatal', check: 'decimals', chainId, symbol: t.symbol, address: t.address, message: `catalog decimals ${t.decimals} ≠ on-chain decimals() ${v.decimals} — corrupts swap amount sizing (parseUnits/formatUnits). Correct the catalog decimals.` })
    } else if (typeof t.decimals === 'number' && v.decimals === null) {
      findings.push({ severity: 'warn', check: 'decimals', chainId, symbol: t.symbol, address: t.address, message: 'on-chain decimals() unknown (RPC/non-standard) at refresh — re-run refresh.' })
    }

    // ② trusted-list — not in a reputable list and not allowlisted ⇒ fatal. null ⇒ advisory.
    if (deprecated.has(addr)) {
      findings.push({ severity: 'warn', check: 'deprecated', chainId, symbol: t.symbol, address: t.address, message: 'pre-existing DEPRECATED/MIGRATED legacy token (allowlisted in knownDeprecated) — flagged for cleanup; replace with the canonical address.' })
    } else if (v.inTrustedList === false && !trustExempt.has(addr)) {
      findings.push({ severity: 'fatal', check: 'trusted-list', chainId, symbol: t.symbol, address: t.address, message: 'address not found in the bundled CoinGecko per-chain list and not in trustedListExempt — add to the allowlist with justification or correct the address.' })
    } else if (v.inTrustedList === null) {
      findings.push({ severity: 'warn', check: 'trusted-list', chainId, symbol: t.symbol, address: t.address, message: 'trusted-list membership unknown (CoinGecko list unreachable at refresh).' })
    }

    // ④ transferability — ADVISORY only (probe false-positives, e.g. USDT).
    if (v.transferable === false) {
      findings.push({ severity: 'warn', check: 'transferable', chainId, symbol: t.symbol, address: t.address, message: 'read-only transfer(0x..dead,0) reverts — possibly non-transferable (advisory: USDT-style tokens also revert this probe).' })
    }
  }

  // ③ duplicate symbol per chain — non-allowlisted ⇒ fatal. The exemption is ADDRESS-scoped: a
  // duplicate group is only allowed when EVERY colliding address is listed for that symbol, so an
  // extra (e.g. evil) address under an exempted ticker still trips the fatal.
  const dupExemptAddrs = new Map<string, Set<string>>()
  for (const e of allowlist.duplicateSymbolExempt) {
    if (e.chainId === chainId) dupExemptAddrs.set(e.symbol.toUpperCase(), new Set(e.addresses.map(lc)))
  }
  const bySymbol = new Map<string, TokenLike[]>()
  for (const t of tokens) {
    if (lc(t.address) === nativeEth) continue
    const s = t.symbol.toUpperCase()
    if (!bySymbol.has(s)) bySymbol.set(s, [])
    bySymbol.get(s)!.push(t)
  }
  for (const [sym, list] of bySymbol) {
    if (list.length <= 1) continue
    const allowed = dupExemptAddrs.get(sym)
    const fullyExempt = !!allowed && list.every((t) => allowed.has(lc(t.address)))
    if (!fullyExempt) {
      findings.push({
        severity: 'fatal', check: 'duplicate-symbol', chainId, symbol: sym, address: list.map((t) => t.address).join(', '),
        message: `symbol "${sym}" appears at ${list.length} addresses on chain ${chainId} — keep only the trusted-list canonical address (prevents legacy/duplicate tokens like the removed non-transferable MORPHO). Every colliding address must be in duplicateSymbolExempt to be allowed.`,
      })
    }
  }

  return findings
}

/** Audit all chains. `catalogByChain` maps chainId → token list. */
export function auditCatalog(
  catalogByChain: Record<number, TokenLike[]>,
  verdicts: Verdict[],
  allowlist: Allowlist,
): Finding[] {
  return Object.entries(catalogByChain).flatMap(([cid, tokens]) =>
    auditChain(Number(cid), tokens, verdicts, allowlist),
  )
}

export const fatal = (f: Finding[]): Finding[] => f.filter((x) => x.severity === 'fatal')
export const warnings = (f: Finding[]): Finding[] => f.filter((x) => x.severity === 'warn')
