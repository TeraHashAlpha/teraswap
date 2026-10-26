'use client'

import Link from 'next/link'
import { useBlockNumber } from 'wagmi'
import { COPYRIGHT_YEAR, PLATFORM_FEE_LABEL } from '@/config/product-claims'
import { useQuoteChainId } from '@/hooks/useChainId'
import { getChainConfig } from '@/lib/chains/registry'
import { SUPPORT_EMAIL } from '@/lib/constants'
import { fmtInt } from '@/lib/format'
import { PhotoCredit } from '../photos/PhotoCredit'
import type { ShellPhoto } from '../photos/photos'

// Mainnet block time is ~12 s; polling faster only reissues eth_blockNumber calls (same value and rationale as v1).
export const V2_FOOTER_BLOCK_POLL_MS = 12_000

/** The one neutral risk line, verbatim (v1 `FOOTER_RISK_LINE`; a test pins both to this literal). */
export const V2_RISK_LINE = 'Smart contracts have not been externally audited. Use at your own risk.'

function footerChain(chainId: number): { name: string; blockExplorer: string } | null {
  try {
    const { name, blockExplorer } = getChainConfig(chainId)
    return { name, blockExplorer }
  } catch {
    return null
  }
}

const LINK =
  'py-1 transition-colors hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal'
const SEP = (
  <span aria-hidden="true" className="text-v2-dim">
    ·
  </span>
)

/**
 * [ADR-025] Full footer (pack 01): every v1 footer item — Docs, GitHub, X, Fee, No infinite approvals, chain · block
 * with explorer link, Privacy, Terms, Contact, ©, TeraHelps — plus the risk line. The block is the SELECTED chain's
 * (wallet chain when connected, dropdown pick when not), polled like v1 (paused in hidden tabs). `photo` puts the photo
 * credit inside this container (left), away from the floating ? / ♫.
 */
export function Footer({ photo }: { photo?: ShellPhoto }) {
  const chainId = useQuoteChainId()
  const chain = footerChain(chainId)
  const { data: blockNumber } = useBlockNumber({
    chainId,
    query: { refetchInterval: V2_FOOTER_BLOCK_POLL_MS, refetchIntervalInBackground: false },
  })

  return (
    <footer data-ts-footer="" className="box-border min-h-[var(--photo-footer-band)] px-4 pb-20 pt-3 sm:px-8 sm:pb-3">
      <div className="border-t border-v2-border pt-3">
        <p className="text-xs text-v2-muted">{V2_RISK_LINE}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0 font-v2-mono text-[11px] uppercase tracking-[0.5px] text-v2-muted">
          <Link href="/docs" className={LINK}>
            Docs
          </Link>
          {SEP}
          <a href="https://github.com/TeraHashAlpha/teraswap" target="_blank" rel="noopener noreferrer" className={LINK}>
            GitHub
          </a>
          {SEP}
          <a href="https://x.com/TeraHash" target="_blank" rel="noopener noreferrer" className={LINK} aria-label="X (Twitter)">
            X
          </a>
          {SEP}
          <span className="text-v2-cream">Fee {PLATFORM_FEE_LABEL}</span>
          {SEP}
          <span>No infinite approvals</span>
          {blockNumber !== undefined ? (
            <>
              {SEP}
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-v2-teal" />
                {chain ? (
                  <a href={`${chain.blockExplorer}/block/${blockNumber}`} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {chain.name} · Block #{fmtInt(blockNumber)}
                  </a>
                ) : (
                  <>Block #{fmtInt(blockNumber)}</>
                )}
              </span>
            </>
          ) : null}
          {SEP}
          <Link href="/privacy" className={LINK}>
            Privacy
          </Link>
          {SEP}
          <Link href="/terms" className={LINK}>
            Terms
          </Link>
          {SEP}
          <span>
            Contact{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="normal-case tracking-normal text-v2-cream" aria-label={`Email support at ${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </span>
          {SEP}
          <span>&copy; {COPYRIGHT_YEAR} TeraSwap</span>
          {SEP}
          <a href="https://terahelps.netlify.app/" target="_blank" rel="noopener noreferrer" className={`${LINK} text-v2-cream`}>
            TeraHelps
          </a>
        </div>
        {photo ? <PhotoCredit photo={photo} /> : null}
      </div>
    </footer>
  )
}
