'use client'

import { useState } from 'react'
import type { Token } from '@/lib/tokens'

/**
 * Round 7 item 2: the token selector is a TEXT button — logo, symbol, chevron, no fill, a ≥ 44 px hit area. The list it
 * opens (frame 23) is a B4 modal, so `onOpen` is a stub here (`data-b4-stub`); the button is real and accessible.
 */
export function TokenButton({ token, side, onOpen }: { token: Token | null; side: 'sell' | 'receive'; onOpen?: () => void }) {
  const [logoFailed, setLogoFailed] = useState(false)
  return (
    <button
      type="button"
      aria-label={`${side === 'sell' ? 'Sell' : 'Receive'} token: ${token?.symbol ?? 'none'}. Change token`}
      data-b4-stub="token-modal"
      onClick={onOpen}
      className="ts-swap-token inline-flex min-h-[44px] items-center gap-2 font-v2-mono text-[15px] font-semibold text-v2-text hover:text-v2-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
    >
      {token && !logoFailed && token.logoURI ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote token logos, same as v1's selector
        <img src={token.logoURI} alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-full" onError={() => setLogoFailed(true)} />
      ) : (
        <span aria-hidden="true" className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-v2-surface2 text-[11px] text-v2-text">
          {token?.symbol.slice(0, 1) ?? ''}
        </span>
      )}
      <span>{token?.symbol ?? 'Select'}</span>
      <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 4.5 6 8l4-3.5" />
      </svg>
    </button>
  )
}
