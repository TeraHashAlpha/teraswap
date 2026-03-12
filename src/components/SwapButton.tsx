'use client'

import { useAccount, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { CHAIN_ID } from '@/lib/constants'
import { playTouchMP3 } from '@/lib/sounds'
import type { SwapStatus } from '@/hooks/useSwap'
import type { ApprovalStatus } from '@/hooks/useApproval'

interface Props {
  swapStatus: SwapStatus
  approvalStatus: ApprovalStatus
  approvalReady: boolean
  hasAmount: boolean
  hasSufficientBalance: boolean
  hasQuote: boolean
  quoteLoading: boolean
  /** When true, price deviation from Chainlink exceeds the block threshold — swap MUST be blocked */
  priceBlocked: boolean
  /** Reason for the block: 'warn' (2-3% deviation), 'danger' (>3%), 'oracle' (no oracle + high value) */
  blockReason?: 'warn' | 'danger' | 'oracle'
  onApprove: () => void
  onSwap: () => void
}

export default function SwapButton({
  swapStatus, approvalStatus, approvalReady,
  hasAmount, hasSufficientBalance, hasQuote, quoteLoading,
  priceBlocked, blockReason,
  onApprove, onSwap,
}: Props) {
  const { isConnected, chain } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChain } = useSwitchChain()
  const isCorrectChain = chain?.id === CHAIN_ID

  type BtnConfig = { text: string; disabled: boolean; onClick: () => void; variant: string }

  const getConfig = (): BtnConfig => {
    if (!isConnected)
      return { text: 'Connect Wallet', disabled: false, onClick: () => openConnectModal?.(), variant: 'primary' }
    if (!isCorrectChain)
      return { text: 'Switch to Ethereum', disabled: false, onClick: () => switchChain({ chainId: CHAIN_ID }), variant: 'warning' }
    if (!hasAmount)
      return { text: 'Enter amount', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (!hasSufficientBalance)
      return { text: 'Insufficient balance', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (quoteLoading)
      return { text: 'Finding best route...', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (!hasQuote)
      return { text: 'No quotes available', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (priceBlocked) {
      const msg = blockReason === 'warn'
        ? 'Price outside safe range — waiting...'
        : blockReason === 'oracle'
          ? 'No oracle — swap blocked'
          : 'Price deviation too high — blocked'
      return { text: msg, disabled: true, onClick: () => {}, variant: blockReason === 'warn' ? 'warning' : 'error' }
    }
    if (approvalStatus === 'approving_permit2')
      return { text: 'Approving...', disabled: true, onClick: () => {}, variant: 'loading' }
    if (approvalStatus === 'signing')
      return { text: 'Signing...', disabled: true, onClick: () => {}, variant: 'loading' }
    if (approvalStatus === 'error')
      return { text: 'Approval error — retry', disabled: false, onClick: onApprove, variant: 'error' }
    if (!approvalReady)
      return { text: 'Approve & Swap', disabled: false, onClick: onApprove, variant: 'primary' }
    if (swapStatus === 'fetching_swap')
      return { text: 'Preparing swap...', disabled: true, onClick: () => {}, variant: 'loading' }
    if (swapStatus === 'cow_signing')
      return { text: 'Sign order in wallet...', disabled: true, onClick: () => {}, variant: 'cow' }
    if (swapStatus === 'cow_pending')
      return { text: 'Waiting for solver...', disabled: true, onClick: () => {}, variant: 'cow' }
    if (swapStatus === 'swapping')
      return { text: 'Executing swap...', disabled: true, onClick: () => {}, variant: 'loading' }
    if (swapStatus === 'success')
      return { text: 'Swap complete', disabled: true, onClick: () => {}, variant: 'success' }
    if (swapStatus === 'error')
      return { text: 'Error — retry', disabled: false, onClick: onSwap, variant: 'error' }
    return { text: 'Swap', disabled: false, onClick: onSwap, variant: 'primary' }
  }

  const config = getConfig()

  const variantClasses: Record<string, string> = {
    primary: 'border-cream-80 text-cream hover:bg-cream hover:text-black',
    warning: 'border-warning text-warning hover:bg-warning hover:text-black',
    success: 'border-success text-success',
    error: 'border-danger text-danger hover:bg-danger hover:text-white',
    loading: 'border-cream-35 text-cream-50 cursor-wait',
    cow: 'border-cream-gold/50 text-cream-gold cursor-wait',
    disabled: 'border-cream-08 text-cream-35 cursor-not-allowed opacity-50',
  }

  const isSpinning = ['approving_permit2', 'signing'].includes(approvalStatus) ||
    ['fetching_swap', 'swapping', 'cow_signing', 'cow_pending'].includes(swapStatus)

  const isCowFlow = swapStatus === 'cow_signing' || swapStatus === 'cow_pending'
  const showStepper = isSpinning || approvalStatus === 'approving_permit2'
  const approveActive = ['approving_permit2', 'signing'].includes(approvalStatus)
  const swapActive = ['fetching_swap', 'swapping', 'cow_signing', 'cow_pending'].includes(swapStatus)
  const approveDone = approvalReady && (swapActive || swapStatus === 'success')

  return (
    <div>
      <button
        onClick={() => { playTouchMP3(); config.onClick() }}
        disabled={config.disabled}
        className={`w-full rounded-full border-2 bg-transparent py-4 text-[15px] font-bold uppercase tracking-[1.5px] transition-all ${variantClasses[config.variant]}`}
      >
        {isSpinning && <span className="mr-2 inline-block animate-spin">&#8635;</span>}
        {config.text}
      </button>

      {showStepper && !isCowFlow && (
        <div className="mt-2 flex items-center justify-center gap-2 text-xs text-cream-35">
          <span className={approveActive ? 'font-bold text-cream' : approveDone ? 'text-success' : ''}>
            1. Approve
          </span>
          <span>&#8594;</span>
          <span className={swapActive ? 'font-bold text-cream' : ''}>
            2. Swap
          </span>
        </div>
      )}

      {/* CoW Protocol stepper */}
      {isCowFlow && (
        <div className="mt-2 flex items-center justify-center gap-2 text-xs text-cream-35">
          <span className={swapStatus === 'cow_signing' ? 'font-bold text-cream-gold' : 'text-success'}>
            1. Sign
          </span>
          <span>&#8594;</span>
          <span className={swapStatus === 'cow_pending' ? 'font-bold text-cream-gold' : ''}>
            2. Solver fills
          </span>
        </div>
      )}

      {swapStatus === 'cow_pending' && (
        <p className="mt-1.5 text-center text-[10px] text-cream-gold/60">
          Your order is MEV-protected. Solvers are competing to fill it at the best price.
        </p>
      )}

      {!approvalReady && hasAmount && hasQuote && !quoteLoading && (
        <p className="mt-2 text-center text-[10px] text-cream-35">
          Exact approval only — we never request unlimited access to your tokens.
        </p>
      )}
    </div>
  )
}
