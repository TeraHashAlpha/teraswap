'use client'

import { formatChainList, chainNameFor, dcaLiveChainNames } from '@/config/product-claims'
import { DCA_CHAINS, isDcaLive } from '@/lib/dca-launch'
import { Button, EyebrowLabel } from '../primitives'
import { useShellChain } from './use-shell-chain'

/**
 * [ADR-025] The only DCA state the shell owns (pack 30a): the selected network is not a DCA network, so the tab
 * says where DCA runs and offers the switch. Never "Soon". Names and buttons come from `isDcaLive` /
 * `dcaLiveChainNames()` — Arbitrum appears here only once its executor is live. With no live chain there is
 * nothing true to claim, so the caller renders the plain pane instead (see `shouldShowDcaGate`).
 */
export function liveDcaChainIds(): number[] {
  return DCA_CHAINS.filter((id) => isDcaLive(id))
}

export function shouldShowDcaGate(chainId: number): boolean {
  return !DCA_CHAINS.includes(chainId) && liveDcaChainIds().length > 0
}

export function DcaNetworkGate() {
  const { chainId, select, isPending } = useShellChain()
  const ids = liveDcaChainIds()
  return (
    <section data-tab-pane="dca" data-dca-gate="" className="mx-auto w-full max-w-[880px] px-1 py-10">
      <EyebrowLabel className="ts-v2-plate">DCA · Live on L2</EyebrowLabel>
      <h1 className="mt-4 font-v2-display text-5xl uppercase leading-[0.95] text-v2-text sm:text-7xl">
        DCA runs on {formatChainList(dcaLiveChainNames())}.
      </h1>
      <p className="ts-v2-plate mt-6 inline-block max-w-[640px] text-lg text-v2-muted">
        {chainNameFor(chainId)} is selected. Switch network to create or manage DCA positions.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        {ids.map((id, i) => (
          <Button key={id} variant={i === 0 ? 'primary' : 'secondary'} disabled={isPending} onClick={() => select(id)}>
            Switch to {chainNameFor(id)}
          </Button>
        ))}
      </div>
      <p className="ts-v2-plate mt-6 inline-block text-sm text-v2-muted">Positions on other networks stay visible in Orders.</p>
    </section>
  )
}
