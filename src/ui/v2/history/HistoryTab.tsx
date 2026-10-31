'use client'

import { explorerTxUrl } from '@/lib/chains/tokens'
import { getChainName } from '@/lib/chains/registry'
import { fmtUsd } from '@/lib/format'
import { Button, Skeleton } from '../primitives'
import { rowNavKeyDown } from '../orders/keyboard'
import { fillLabel, historyAmount, shortenHash, sourceLabel, statusKind, timeAgo, type SwapRecord } from './history-model'
import { useWalletHistory } from './use-wallet-history'
import '../orders/orders.css'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'
const TONE: Record<'green' | 'red' | 'muted', string> = { green: 'text-v2-green', red: 'text-v2-red', muted: 'text-v2-muted' }

/**
 * One record as a hairline row (round7 43): v1's glyph (⟳ DCA fill / ⇄ swap), amount in → amount out with the symbols, v1's DCA mark (and
 * its title), v1's status word, the sub-line (`Fill #n of m · position …xxxxxx` or `via {source}`, then `≈ $usd`), the chain, how long
 * ago, and the tx on the record's OWN chain (`chain_id`, as v1).
 */
function HistoryRow({ r, now }: { r: SwapRecord; now: number }) {
  const isFill = r.kind === 'dca_fill'
  const status = statusKind(r.status)
  return (
    <li className="ts-history-row" data-testid="history-row" data-kind={r.kind ?? 'swap'}>
      <span aria-hidden="true" className="ts-orders-glyph">{isFill ? '⟳' : '⇄'}</span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-v2-mono text-[14px] font-semibold tabular-nums text-v2-text">
          <span>{historyAmount(r.amount_in, r.token_in_symbol)} {r.token_in_symbol}</span>
          <span className="text-v2-muted">→</span>
          <span>{historyAmount(r.amount_out, r.token_out_symbol)} {r.token_out_symbol}</span>
          {isFill && <span className={`${CAPS} text-v2-cream`} title="Automated DCA fill executed by the TeraSwap keeper" data-testid="history-dca">DCA</span>}
          <span className={`${CAPS} ${TONE[status.tone]}`} data-testid="history-status">{status.text}</span>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-v2-muted">
          {isFill ? (
            <span>
              {fillLabel(r)}
              {r.order_id && <span className="text-v2-dim"> · position …{r.order_id.slice(-6)}</span>}
            </span>
          ) : (
            <span>via {sourceLabel(r.source)}</span>
          )}
          {r.amount_in_usd != null && <span>≈ {fmtUsd(Number(r.amount_in_usd))}</span>}
          <span className={`${CAPS} text-v2-dim`} data-testid="history-chain">{getChainName(r.chain_id ?? 1)}</span>
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-v2-mono text-[11px] text-v2-muted">{timeAgo(r.created_at, now)}</div>
        {r.tx_hash && (
          <a
            href={explorerTxUrl(r.tx_hash, r.chain_id ?? 1)}
            target="_blank"
            rel="noopener noreferrer"
            title="View on block explorer"
            data-history-link=""
            className="inline-flex min-h-[44px] items-center font-v2-mono text-[12px] text-v2-cream underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
          >
            {shortenHash(r.tx_hash)} ↗
          </a>
        )}
      </div>
    </li>
  )
}

/**
 * [ADR-025 / B7 C3] The History tab (round7 43 / 46) — v1 WalletHistory in the round-7 language, every word v1's: the header with the
 * total, v1's Export CSV (the same `/api/analytics/export` link, inert until there is a record) and Refresh (`Loading...` while it reads),
 * v1's error line, five skeleton rows while the first read runs, v1's empty sentence, the rows, and v1's "Showing N of T" footer. ↑ / ↓
 * move between the rows' tx links.
 */
export function HistoryTab() {
  return <HistoryView {...useWalletHistory()} />
}

/** The tab's view over v1's read (`useWalletHistory`): what `HistoryTab` renders. */
export function HistoryView({ address, isConnected, swaps, total, loading, error, fetchedAt, fetchHistory }: ReturnType<typeof useWalletHistory>) {

  if (!isConnected) {
    return (
      <section className="ts-orders" aria-label="History" data-testid="history-disconnected">
        <div className="ts-orders-empty">
          <span aria-hidden="true" className="text-[22px] text-v2-muted">⇄</span>
          <p className="text-[15px] text-v2-text">Connect your wallet to see swap history</p>
        </div>
      </section>
    )
  }

  const empty = swaps.length === 0
  return (
    <section className="ts-orders" aria-label="History" aria-busy={loading || undefined} data-testid="history" onKeyDown={rowNavKeyDown('[data-history-link]')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-3 font-v2-display text-[34px] font-bold uppercase leading-none tracking-[0.5px] text-v2-text">
          History
          {total > 0 && <span className="font-v2-mono text-[13px] font-semibold normal-case text-v2-muted" data-testid="history-total">({total})</span>}
        </h2>
        <div className="flex items-center gap-5">
          {/* [P100] v1: Export CSV stays inert until there is at least one record. */}
          <a
            href={address ? `/api/analytics/export?wallet=${address}&format=csv` : '#'}
            aria-disabled={empty}
            onClick={(e) => { if (empty) e.preventDefault() }}
            data-testid="history-export"
            className={`ts-history-action ${empty ? 'cursor-not-allowed text-v2-dim' : 'text-v2-text'}`}
          >
            Export CSV
          </a>
          <Button variant="text" onClick={() => void fetchHistory()} disabled={loading} data-testid="history-refresh">
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && <p className="mt-4 border-l-2 border-v2-red pl-3 text-[13px] text-v2-red" role="alert" data-testid="history-error">{error}</p>}

      {loading && empty && (
        <div className="mt-4" data-testid="history-loading">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="ts-history-row"><Skeleton height={40} className="flex-1" /></div>
          ))}
        </div>
      )}

      {!loading && empty && !error && (
        <div className="ts-orders-empty" data-testid="history-empty">
          <span aria-hidden="true" className="text-[22px] text-v2-muted">⇄</span>
          <p className="text-[14px] text-v2-muted">No activity yet — your swaps and DCA fills will appear here</p>
        </div>
      )}

      {!empty && (
        <ul className="mt-4" data-testid="history-list">
          {swaps.map((r) => <HistoryRow key={r.id || r.tx_hash || r.created_at} r={r} now={fetchedAt} />)}
        </ul>
      )}

      {!empty && (
        <p className="mt-6 text-center font-v2-mono text-[11px] text-v2-dim" data-testid="history-footer">
          Showing {swaps.length} of {total} records on TeraSwap
        </p>
      )}
    </section>
  )
}
