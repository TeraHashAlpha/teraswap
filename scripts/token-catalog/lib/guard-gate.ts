/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Guard gate — routes candidates THROUGH the existing
 * catalog guard (src/lib/chains/catalog-guard.ts) and maps its findings onto per-address
 * pipeline outcomes. The guard's checks (bytecode, on-chain identity, FATAL decimals
 * cross-check, trusted-list, duplicate-symbol) are reused verbatim — nothing on-chain is
 * reimplemented here.
 *
 *  - any FATAL finding for an address        ⇒ 'fatal'
 *  - missing verdict                          ⇒ 'fatal' (the guard fails closed)
 *  - null on-chain signals (RPC unreachable)  ⇒ 'unverifiable' — advisory for the guard,
 *    but the PIPELINE must not mark verified:true on a token it could not read
 *  - transferable=false stays ADVISORY (pass) — same policy as the guard (USDT-style
 *    read-only transfer probes revert legitimately)
 */
import { auditChain, type Allowlist, type TokenLike, type Verdict } from '@/lib/chains/catalog-guard'
import type { GuardOutcome } from './types'

export function deriveGuardOutcomes(
  chainId: number,
  tokens: Array<TokenLike & { decimals?: number }>,
  verdicts: Verdict[],
  allowlist: Allowlist,
): Map<string, GuardOutcome> {
  const out = new Map<string, GuardOutcome>()
  const nativeLower = allowlist.nativeEth.toLowerCase()
  const findings = auditChain(chainId, tokens, verdicts, allowlist)

  // Index fatal findings by address. The duplicate-symbol finding joins every colliding
  // address into one field — split it so EACH collider is marked fatal.
  const fatalByAddr = new Map<string, string>()
  for (const f of findings) {
    if (f.severity !== 'fatal') continue
    for (const a of f.address.split(',').map((s) => s.trim().toLowerCase())) {
      if (a && !fatalByAddr.has(a)) fatalByAddr.set(a, `${f.check}: ${f.message}`)
    }
  }

  const verdictByAddr = new Map<string, Verdict>()
  for (const v of verdicts) {
    if (v.chainId === chainId) verdictByAddr.set(v.address.toLowerCase(), v)
  }

  for (const t of tokens) {
    const a = t.address.toLowerCase()
    if (a === nativeLower) {
      out.set(a, { status: 'pass' }) // native sentinel: no ERC-20 contract to audit
      continue
    }
    const fatalDetail = fatalByAddr.get(a)
    if (fatalDetail) {
      out.set(a, { status: 'fatal', detail: fatalDetail })
      continue
    }
    const v = verdictByAddr.get(a)
    if (!v || v.hasBytecode == null || (typeof t.decimals === 'number' && v.decimals == null)) {
      out.set(a, { status: 'unverifiable', detail: 'on-chain signals unreadable at refresh' })
      continue
    }
    out.set(a, { status: 'pass' })
  }
  return out
}
