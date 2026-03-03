import { PERMIT2_ADDRESS, PERMIT2_MAX_DEADLINE_SEC, PERMIT2_MAX_EXPIRATION_SEC } from './constants'

// ── Permit2 AllowanceTransfer ABI (minimal) ──────────────
export const permit2Abi = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// ── EIP-2612 permit detection ABI ────────────────────────
export const eip2612DetectionAbi = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'DOMAIN_SEPARATOR',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// ── Permit2 EIP-712 Types ────────────────────────────────
export const PERMIT2_DOMAIN = {
  name: 'Permit2',
  chainId: 1,
  verifyingContract: PERMIT2_ADDRESS,
} as const

export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const

// ── Approval method types ────────────────────────────────
export type ApprovalMethod = 'permit2' | 'eip2612' | 'exact'

export interface ApprovalPlan {
  method: ApprovalMethod
  /** Does the user need an on-chain tx before signing? (e.g. approve Permit2 contract) */
  needsOnChainApprove: boolean
  /** Human-friendly label */
  label: string
  /** Estimated extra gas cost (0 for off-chain signatures) */
  extraGas: number
}

/**
 * Determine the best approval strategy.
 * Priority: Permit2 > EIP-2612 > Exact approve
 */
export function planApproval(
  hasPermit2Allowance: boolean,
  tokenSupportsEip2612: boolean,
  isNativeToken: boolean,
): ApprovalPlan {
  // Native ETH needs no approval
  if (isNativeToken) {
    return {
      method: 'exact',
      needsOnChainApprove: false,
      label: 'No approval needed (native ETH)',
      extraGas: 0,
    }
  }

  // Best: Permit2 with existing approval to Permit2 contract
  if (hasPermit2Allowance) {
    return {
      method: 'permit2',
      needsOnChainApprove: false,
      label: 'Secure signature (Permit2)',
      extraGas: 0,
    }
  }

  // Good: Token supports EIP-2612 natively
  if (tokenSupportsEip2612) {
    return {
      method: 'eip2612',
      needsOnChainApprove: false,
      label: 'Secure signature (Permit)',
      extraGas: 0,
    }
  }

  // Fallback: Exact approve (1 tx extra, but NEVER infinite)
  return {
    method: 'exact',
    needsOnChainApprove: true,
    label: 'Exact approval (1 transaction)',
    extraGas: 46_000, // ~46k gas for approve
  }
}

/**
 * Generate a hardcoded Permit2 signature deadline (now + MAX_DEADLINE).
 * Prevents phishing attacks with indefinite deadlines.
 */
export function getPermit2Deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + PERMIT2_MAX_DEADLINE_SEC)
}

/**
 * Generate a hardcoded Permit2 allowance expiration (now + MAX_EXPIRATION).
 * Limits the window of risk for Permit2 allowances.
 */
export function getPermit2Expiration(): number {
  return Math.floor(Date.now() / 1000) + PERMIT2_MAX_EXPIRATION_SEC
}
