'use client'

import { useAccount, useChains, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { CHAIN_ID } from '@/lib/constants'
import { isChainActive } from '@/lib/chains'
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
  /** When true, the swap is blocked (oracle integrity, unverified large swap, or
   * price-impact consent not yet given) — the button MUST stay disabled. */
  priceBlocked: boolean
  /** [SPRINT-9J J1] Block reason:
   *  - 'price-impact'  → healthy oracle, high price impact; user must tick the
   *    informed-consent checkbox above (recoverable, NOT an indefinite pause)
   *  - 'oracle-stale'  → oracle integrity failure (stale/invalid); hard block
   *  - 'extreme'       → deviation beyond plausible price impact; hard block
   *  - 'oracle'        → no Chainlink feed + high-value swap; hard block
   *  [SPRINT-9W-oracle]:
   *  - 'depeg-consent' → asset trading 2–10% off its exchange rate; recoverable
   *    via the depeg consent checkbox (warning, like price-impact)
   *  - 'depeg-block'   → asset ≥10% off its exchange rate (depeg/manipulation); hard block */
  blockReason?: 'price-impact' | 'oracle-stale' | 'extreme' | 'oracle' | 'depeg-consent' | 'depeg-block'
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
  const configuredChains = useChains()
  const targetChainName = configuredChains.find((c) => c.id === CHAIN_ID)?.name ?? 'Ethereum'
  // [Sprint 45] Accept any SUPPORTED + ACTIVE chain (FeeCollector deployed), not
  // just mainnet. On an inactive/unsupported chain this stays false and the
  // button still prompts a switch to Ethereum (the safe default target below).
  const isCorrectChain = !!chain && isChainActive(chain.id)

  type BtnConfig = { text: string; disabled: boolean; onClick: () => void; variant: string }

  const getConfig = (): BtnConfig => {
    if (!isConnected)
      return { text: 'Connect Wallet', disabled: false, onClick: () => openConnectModal?.(), variant: 'primary' }
    if (!isCorrectChain)
      return { text: `Switch to ${targetChainName}`, disabled: false, onClick: () => switchChain({ chainId: CHAIN_ID }), variant: 'warning' }
    if (!hasAmount)
      return { text: 'Enter amount', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (!hasSufficientBalance)
      return { text: 'Insufficient balance', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (quoteLoading)
      return { text: 'Finding best route...', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (!hasQuote)
      return { text: 'No quotes available', disabled: true, onClick: () => {}, variant: 'disabled' }
    if (priceBlocked) {
      // [SPRINT-9J J1] 'price-impact' is recoverable via the consent checkbox —
      // surface that instead of an indefinite "waiting" block. Integrity / no-oracle
      // blocks stay hard errors.
      const msg = blockReason === 'price-impact'
        ? 'Confirm price impact to swap'
        : blockReason === 'depeg-consent'
          ? 'Confirm depeg risk to swap'
          : blockReason === 'depeg-block'
            ? 'Asset depegged — swap blocked'
            : blockReason === 'oracle'
              ? 'No oracle — swap blocked'
              : blockReason === 'extreme'
                ? 'Price deviation too high — blocked'
                : 'Oracle data unsafe — swap blocked'
      // 'price-impact' & 'depeg-consent' are recoverable (checkbox) → warning; the rest are hard.
      const recoverable = blockReason === 'price-impact' || blockReason === 'depeg-consent'
      return { text: msg, disabled: true, onClick: () => {}, variant: recoverable ? 'warning' : 'error' }
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
    if (swapStatus === 'simulating')
      return { text: 'Simulating transaction...', disabled: true, onClick: () => {}, variant: 'loading' }
    if (swapStatus === 'confirming')
      return { text: 'Review transaction...', disabled: true, onClick: () => {}, variant: 'loading' }
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
    ['fetching_swap', 'simulating', 'confirming', 'swapping', 'cow_signing', 'cow_pending'].includes(swapStatus)

  const isCowFlow = swapStatus === 'cow_signing' || swapStatus === 'cow_pending'
  const showStepper = isSpinning || approvalStatus === 'approving_permit2'
  const approveActive = ['approving_permit2', 'signing'].includes(approvalStatus)
  const swapActive = ['fetching_swap', 'simulating', 'confirming', 'swapping', 'cow_signing', 'cow_pending'].includes(swapStatus)
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
