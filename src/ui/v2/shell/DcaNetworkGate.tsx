'use client'

import { getChainConfig } from '@/lib/chains/registry'
import { DCA_CHAINS, isDcaLaunchEnabled } from '@/lib/dca-launch'
import { Button, EyebrowLabel } from '../primitives'
import { useShellChain } from './use-shell-chain'

/**
 * [ADR-025] The only DCA state the shell owns (pack 30a): the selected network is not a DCA network, so the tab says where DCA runs and
 * offers the switch. Never "Soon". Derived from the SAME source as v1 (page.tsx `dcaWrongChain` + ComingSoonPanel): the chains are
 * `DCA_CHAINS` — the compile-time allowlist, not the live subset — named by the registry and joined with " and ", and the gate shows when
 * the launch flag is on and the selected chain is not one of them. `dca-gate-source.test.tsx` pins the two lists equal.
 */
export function dcaGateChainIds(): readonly number[] {
  return DCA_CHAINS
}

export function dcaGateChainNames(): string[] {
  return dcaGateChainIds().map((id) => getChainConfig(id).name)
}

export function shouldShowDcaGate(chainId: number): boolean {
  return isDcaLaunchEnabled() && !DCA_CHAINS.includes(chainId)
}

export function DcaNetworkGate() {
  const { chainId, select, isPending } = useShellChain()
  const ids = dcaGateChainIds()
  return (
    <section data-tab-pane="dca" data-dca-gate="" className="mx-auto w-full max-w-[880px] px-1 py-10">
      <EyebrowLabel>DCA · Live on L2</EyebrowLabel>
      <h1 className="mt-4 font-v2-display text-5xl uppercase leading-[0.95] text-v2-text sm:text-7xl">
        DCA runs on {dcaGateChainNames().join(' and ')}.
      </h1>
      <p className="mt-6 max-w-[640px] text-lg text-v2-muted">
        {getChainConfig(chainId).name} is selected. Switch network to create or manage DCA positions.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        {ids.map((id, i) => (
          <Button key={id} variant={i === 0 ? 'primary' : 'text'} disabled={isPending} onClick={() => select(id)}>
            Switch to {getChainConfig(id).name}
          </Button>
        ))}
      </div>
      <p className="mt-6 text-sm text-v2-muted">Positions on other networks stay visible in Orders.</p>
    </section>
  )
}
