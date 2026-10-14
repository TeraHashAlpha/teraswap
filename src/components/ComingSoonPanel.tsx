'use client'

import { useAccount, useSwitchChain } from 'wagmi'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'
import { getChainConfig } from '@/lib/chains/registry'
import { DCA_CHAINS } from '@/lib/dca-launch'
import { LIMIT_TP_CHAIN_ID } from '@/lib/order-engine/limit-launch'

export type ComingSoonMode = 'dca' | 'limit' | 'sltp'

const META: Record<ComingSoonMode, { icon: string; title: string; desc: string }> = {
  dca:   { icon: '⟳', title: 'Smart DCA Engine', desc: 'Automated dollar-cost averaging with price-aware buying windows.' },
  limit: { icon: '◇', title: 'Limit Orders', desc: 'Set your price and let the order execute autonomously on-chain.' },
  sltp:  { icon: '◆', title: 'Take Profit', desc: 'Lock in gains automatically when your target is hit.' },
}

/** Chains each gated mode is built for — the single source for the copy and the switch actions. */
const MODE_CHAINS: Record<ComingSoonMode, readonly number[]> = {
  dca: DCA_CHAINS,
  limit: [LIMIT_TP_CHAIN_ID],
  sltp: [LIMIT_TP_CHAIN_ID],
}

const nameOf = (id: number) => getChainConfig(id).name
const join = (names: string[]) => names.join(' and ')

/**
 * [fix/dca-chain-switch / P2] The teaser for a gated mode. `chainId` is the SELECTOR chain
 * (useQuoteChainId), the same one the tab gate uses. When that chain is simply not one the mode runs
 * on (Ethereum), say where it does run and offer the switch — instead of the old static "Coming to
 * L2 soon". Switching mirrors ChainSelector: wagmi when a wallet is connected, the disconnected
 * selection store otherwise.
 */
export default function ComingSoonPanel({ mode, chainId, onSwap }: { mode: ComingSoonMode; chainId: number; onSwap: () => void }) {
  const meta = META[mode]
  const { isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  const setDisconnectedChainId = useDisconnectedChainSelection((s) => s.setChainId)
  const targets = MODE_CHAINS[mode]
  const wrongChain = !targets.includes(chainId)

  const switchTo = (id: number) => (isConnected ? switchChain({ chainId: id }) : setDisconnectedChainId(id))

  const names = targets.map(nameOf)
  const runsOn = `${mode === 'dca' ? 'DCA' : meta.title} runs on ${join(names)}`

  return (
    <div className="flex flex-col items-center gap-5 rounded-2xl border border-cream-08 bg-surface-secondary/60 px-6 py-12 text-center backdrop-blur-md">
      <span className="text-5xl">{meta.icon}</span>
      <h3 className="text-xl font-bold text-cream">{meta.title}</h3>
      <p className="max-w-xs text-sm text-cream-50">{meta.desc}</p>
      {wrongChain ? (
        <>
          <span data-testid="coming-soon-runs-on" className="rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-xs font-semibold text-amber-300">
            {runsOn}
          </span>
          <div className="flex flex-wrap justify-center gap-2">
            {targets.map((id) => (
              <button
                key={id}
                data-testid={`switch-to-${id}`}
                onClick={() => switchTo(id)}
                className="rounded-xl border border-cream-08 px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-cream-08"
              >
                Switch to {nameOf(id)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-xs font-semibold text-amber-300">
          Coming Soon
        </span>
      )}
      <button
        onClick={onSwap}
        className="mt-2 rounded-xl bg-cream-gold px-6 py-2.5 text-sm font-bold text-[#080B10] transition-transform hover:scale-105"
      >
        Swap Now →
      </button>
    </div>
  )
}
