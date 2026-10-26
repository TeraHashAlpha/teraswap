'use client'

import { useCallback, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { AccountPanel } from './AccountPanel'
import { shortAddress } from './format-address'

const PILL =
  'inline-flex h-11 items-center gap-2 rounded-full border border-v2-cream bg-transparent px-4 font-v2-mono text-[13px] font-bold uppercase tracking-[1.5px] text-v2-cream ' +
  'hover:bg-v2-cream hover:text-v2-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal sm:px-5'

/**
 * [ADR-025] Connect / connected-address control. Disconnected → RainbowKit's connect modal (its wallet list is the
 * one in `wagmiConfig`, the same connectors v1's header offers); connected → the address pill toggles AccountPanel,
 * exactly the v1 Header flow (`ConnectButton.Custom` + WalletModal).
 */
export function ConnectArea() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  return (
    <div className="relative">
      <ConnectButton.Custom>
        {({ account, chain, openConnectModal, mounted }) => {
          const connected = Boolean(mounted && account && chain)
          return (
            <>
              <button type="button" onClick={connected ? () => setOpen((o) => !o) : openConnectModal} className={PILL}>
                {connected && account ? (
                  <>
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-v2-green" />
                    {account.ensName ?? shortAddress(account.address)}
                  </>
                ) : (
                  <>
                    Connect<span className="hidden sm:inline">&nbsp;Wallet</span>
                  </>
                )}
              </button>
              {connected ? <AccountPanel open={open} onClose={close} /> : null}
            </>
          )
        }}
      </ConnectButton.Custom>
    </div>
  )
}
