/**
 * [P140] Pure parser for pre-swap simulation errors.
 *
 * simulateSwapTx in useSwap.ts catches the viem `client.call()` rejection
 * and forwards it here. We pull this out so the substring/selector matching
 * — including the FeeCollector custom-error handling added in P139 — can be
 * tested without spinning up a viem client.
 *
 * Returns:
 *   - { success: false, error }  when the message matches a known revert
 *     pattern and we can surface a human-readable hint.
 *   - { success: true }          when the error is unrecognised. Pre-swap
 *     simulation is best-effort: when we can't tell *why* the call failed
 *     (RPC timeout, gas estimation glitch, etc.) we don't block the swap.
 */
import { toFunctionSelector } from 'viem'

/** Module-level selector table — computed once via keccak256 of the
 *  canonical custom-error signatures from
 *  contracts/order-engine/src/TeraSwapFeeCollector.sol. */
export const FEE_COLLECTOR_ERROR_SELECTORS = {
  RouterNotWhitelisted: toFunctionSelector('RouterNotWhitelisted()'),
  InsufficientOutput: toFunctionSelector('InsufficientOutput(uint256,uint256)'),
  SwapFailed: toFunctionSelector('SwapFailed()'),
  ZeroAmount: toFunctionSelector('ZeroAmount()'),
} as const

export interface ParsedSimulationResult {
  success: boolean
  error?: string
}

export function parseSimulationError(error: unknown): ParsedSimulationResult {
  const msg = error instanceof Error ? error.message : String(error)
  const matchesSelector = (sel: string): boolean => msg.toLowerCase().includes(sel.toLowerCase())

  // FeeCollector-specific reverts — match either the decoded name (when
  // the RPC recognises it) or the raw 4-byte selector in the revert data.
  if (msg.includes('RouterNotWhitelisted') || matchesSelector(FEE_COLLECTOR_ERROR_SELECTORS.RouterNotWhitelisted)) {
    return { success: false, error: 'Router not whitelisted on FeeCollector contract. Contact support.' }
  }
  if (msg.includes('InsufficientOutput') || matchesSelector(FEE_COLLECTOR_ERROR_SELECTORS.InsufficientOutput)) {
    return { success: false, error: 'Swap output below minimum — price moved since quote. Try again or increase slippage.' }
  }
  if (msg.includes('SwapFailed') || matchesSelector(FEE_COLLECTOR_ERROR_SELECTORS.SwapFailed)) {
    return { success: false, error: 'DEX router call failed. Try a different route or increase slippage.' }
  }
  if (msg.includes('ZeroAmount') || matchesSelector(FEE_COLLECTOR_ERROR_SELECTORS.ZeroAmount)) {
    return { success: false, error: 'Swap amount is zero.' }
  }
  // Generic reverts — heuristics that pre-date the FeeCollector custom errors.
  if (msg.includes('insufficient funds')) {
    return { success: false, error: 'Insufficient ETH balance for this swap + gas.' }
  }
  if (msg.includes('STF') || msg.includes('TRANSFER_FROM_FAILED')) {
    return { success: false, error: 'Token transfer would fail — check approval or balance.' }
  }
  if (msg.includes('Too little received') || msg.includes('INSUFFICIENT_OUTPUT')) {
    return { success: false, error: 'Swap would fail due to slippage — price moved since quote. Try again.' }
  }
  if (msg.includes('execution reverted')) {
    return { success: false, error: 'Simulation reverted: swap would fail on-chain. Try a different route or amount.' }
  }
  // Unrecognised — caller decides whether to log+continue or block.
  return { success: true }
}

/**
 * [P140] Pure helper for the FeeCollector sender/recipient switch.
 *
 * When `routeViaFeeCollector` is true the on-chain msg.sender hitting the
 * DEX router is the FeeCollector contract, not the user wallet, so the
 * aggregator must build router calldata expecting FeeCollector as the
 * source of funds. The user wallet becomes the explicit `recipient` so
 * output tokens still land in their wallet.
 *
 * Direct (non-FeeCollector) routes pass the user as `from` and omit
 * `recipient` (the adapter defaults recipient = from).
 */
export interface FeeCollectorSwapArgs {
  from: string
  recipient: string | undefined
}

export function buildFeeCollectorSwapArgs(
  routeViaFeeCollector: boolean,
  userWallet: string,
  feeCollectorAddress: string,
): FeeCollectorSwapArgs {
  return routeViaFeeCollector
    ? { from: feeCollectorAddress, recipient: userWallet }
    : { from: userWallet, recipient: undefined }
}
