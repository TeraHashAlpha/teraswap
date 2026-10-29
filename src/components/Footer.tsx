'use client'

import { fmtInt } from '@/lib/format'
import Link from 'next/link'
import { FEE_PERCENT, SUPPORT_EMAIL } from '@/lib/constants'
import { useBlockNumber } from 'wagmi'
import { COPYRIGHT_YEAR } from '@/config/product-claims'
import { useQuoteChainId } from '@/hooks/useChainId'
import { getChainConfig } from '@/lib/chains'
import { BLOCK_POLL_MS } from '@/lib/rpc-polling'

// [feat/frontend-rpc-diet] 60 s (was 12 s): the block line is informational and a wallet-less visitor pays for
// nothing else, so this is the whole per-minute cost of an idle tab. See src/lib/rpc-polling.ts.
export const FOOTER_BLOCK_POLL_MS = BLOCK_POLL_MS

/** The one neutral risk line shown on every page (replaces the old banner and per-panel disclaimers). */
export const FOOTER_RISK_LINE = 'Smart contracts have not been externally audited. Use at your own risk.'

/** Name + explorer for the footer's block line; null for a chain outside the registry. */
function footerChain(chainId: number): { name: string; blockExplorer: string } | null {
  try {
    const { name, blockExplorer } = getChainConfig(chainId)
    return { name, blockExplorer }
  } catch {
    return null
  }
}

export default function Footer() {
  // [fix/functional-chain-ui F1] The block shown is the selected chain's: the
  // wallet's chain when connected, the ChainSelector pick when disconnected.
  // Without a chainId wagmi read mainnet's block while Base/Arbitrum was selected.
  const chainId = useQuoteChainId()
  const chain = footerChain(chainId)
  // [fix/footer-poll-hidden-tab] `watch:` is a viem watchBlockNumber subscription
  // that polls for the life of the tab regardless of visibility — a forgotten
  // background tab bills eth_blockNumber calls forever. TanStack Query's own
  // refetchInterval pauses while the tab is hidden and resumes on focus.
  const { data: blockNumber } = useBlockNumber({
    chainId,
    query: { refetchInterval: FOOTER_BLOCK_POLL_MS, refetchIntervalInBackground: false },
  })

  return (
    <footer className="relative z-[1] flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-t border-cream-08 px-4 py-4 text-[11px] text-cream-35 sm:gap-y-1">
      <Link href="/docs" className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0">Docs</Link>
      <span className="text-cream-15">|</span>
      <a href="https://github.com/TeraHashAlpha/teraswap" target="_blank" rel="noopener noreferrer" className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0">GitHub</a>
      <span className="text-cream-15">|</span>
      <a href="https://x.com/TeraHash" target="_blank" rel="noopener noreferrer" className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0" aria-label="X (Twitter)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
      <span className="text-cream-15">|</span>
      <span>Fee: {FEE_PERCENT}%</span>
      <span className="hidden text-cream-15 sm:inline">|</span>
      <span className="hidden sm:inline">No infinite approvals</span>
      {blockNumber && (
        <>
          <span className="hidden text-cream-15 sm:inline">|</span>
          <span className="hidden items-center gap-1 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {chain ? (
              <a
                href={`${chain.blockExplorer}/block/${blockNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="transition hover:text-cream active:text-cream"
              >
                {chain.name} · Block #{fmtInt(blockNumber)}
              </a>
            ) : (
              <>Block #{fmtInt(blockNumber)}</>
            )}
          </span>
        </>
      )}
      <span className="text-cream-15">|</span>
      <Link href="/privacy" className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0">Privacy</Link>
      <span className="text-cream-15">|</span>
      <Link href="/terms" className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0">Terms</Link>
      <span className="text-cream-15">|</span>
      <a href={`mailto:${SUPPORT_EMAIL}`} className="py-2 text-cream-50 transition hover:text-cream active:text-cream sm:py-0" aria-label={`Email support at ${SUPPORT_EMAIL}`}>Contact</a>
      <span className="text-cream-15">|</span>
      <span>&copy; {COPYRIGHT_YEAR} TeraSwap</span>
      <span className="text-cream-15">|</span>
      <a
        href="https://terahelps.netlify.app/"
        target="_blank"
        rel="noopener noreferrer"
        className="py-2 text-cream-gold transition hover:text-cream active:text-cream sm:py-0"
      >
        TeraHelps
      </a>
      <p className="basis-full text-center text-[10px] text-cream-35">{FOOTER_RISK_LINE}</p>
    </footer>
  )
}
