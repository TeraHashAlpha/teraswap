/**
 * [ADR-025 / B7] The Orders parity remap, shared by `orders.test.tsx` and the whole-app sweep (`__tests__/parity-sweep.test.tsx`).
 * Owner rule "numbers via format.ts"; "explorer links use the ORDER chain": v1's raw `formatUnits` amounts → format.ts `fmtToken` of the
 * same bigint; v1's `toLocale*` dates → dropped (the instant is asserted on its own); v1's hard-coded chain-1 tx links → the order's chain.
 * Nothing else is rewritten. Test helper — not shipped.
 */
import { formatUnits } from 'viem'
import { normalize, type AllowedRemoval } from '../__tests__/content-parity'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fmtToken } from '@/lib/format'
import type { AutonomousOrder } from '@/lib/order-engine'
import { FILLS, ORDER_META } from '../dca/positions-fixtures'
import { amountInText, v1AmountInText } from './orders-model'

/** v1's glyphs: printed as text in v1, drawn `aria-hidden` (still visible) in v2 — the swap tab's rule; the words beside them stay. */
const GLYPHS = ['🔗', '📋', '⟳', '⇅', '🎯', '🛡️', '📎', '⏱', '⛽']
export function allowFor(v1: HTMLElement): AllowedRemoval[] {
  const text = v1.textContent ?? ''
  return GLYPHS.filter((g) => text.includes(g)).map((g) => ({ text: g, reason: 'decorative glyph: aria-hidden in v2, still drawn' }))
}

/** The instants an order (and its fills / meta) prints, for the date remap. */
function instants(o: AutonomousOrder): number[] {
  const out = [o.createdAt, o.executedAt, o.expiresAt].filter((t): t is number => typeof t === 'number' && t > 0)
  for (const f of FILLS[o.id] ?? []) for (const t of [f.executed_at, f.created_at]) if (t) out.push(Date.parse(t))
  const meta = ORDER_META[o.id]?.executed_at
  if (typeof meta === 'string') out.push(Date.parse(meta))
  return out
}

/** Apply the documented format remap to a clone of v1's DOM (see the header). */
export function remapV1(root: HTMLElement, orders: AutonomousOrder[]): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement
  const amount = new Map<string, string>()
  const dates = new Set<string>()
  for (const o of orders) {
    amount.set(normalize(v1AmountInText(o)), amountInText(o))
    if (o.amountOut) amount.set(normalize(formatUnits(BigInt(o.amountOut), o.tokenOutDecimals || 18)), fmtToken(BigInt(o.amountOut), o.tokenOutDecimals || 18))
    for (const t of instants(o)) {
      const d = new Date(t)
      dates.add(normalize(d.toLocaleDateString()))
      dates.add(normalize(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
      dates.add(normalize(d.toLocaleDateString([], { month: 'short', day: 'numeric' })))
    }
  }
  const walker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = normalize(n.textContent ?? '')
    if (amount.has(t)) n.textContent = amount.get(t) as string
    else if (dates.has(t)) n.textContent = ''
  }
  for (const a of Array.from(clone.querySelectorAll('a[href]'))) {
    // v1 links every tx to mainnet's explorer; pick those out by parsed host + path segment (the base only lets a relative href parse)
    const u = new URL(a.getAttribute('href') as string, 'https://app.invalid')
    const [, segment, hash] = u.pathname.split('/')
    if (u.hostname !== 'etherscan.io' || segment !== 'tx' || !hash) continue
    const owner = orders.find((o) => o.txHash === hash || (FILLS[o.id] ?? []).some((f) => f.tx_hash === hash) || ORDER_META[o.id]?.tx_hash === hash)
    if (owner) a.setAttribute('href', explorerTxUrl(hash, owner.chainId ?? 1))
  }
  return clone
}

