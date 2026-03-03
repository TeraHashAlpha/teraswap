import { create } from 'zustand'
import type { AggregatorName } from '@/lib/constants'

/**
 * Record of a token approval made through TeraSwap.
 * Tracked in-memory to let the user revoke after swaps.
 */
export interface ApprovalRecord {
  id: string                     // unique: `${tokenAddress}:${spenderAddress}`
  tokenAddress: `0x${string}`
  tokenSymbol: string
  spenderAddress: `0x${string}`
  spenderLabel: string           // e.g. "CoW VaultRelayer", "Permit2"
  source: AggregatorName
  method: 'permit2' | 'exact' | 'infinite'  // how it was approved
  timestamp: number
  /** True if the approval is still active (not yet revoked) */
  active: boolean
  /** True if this approval leaves a significant residual allowance */
  needsRevoke: boolean
}

interface ActiveApprovalsStore {
  approvals: ApprovalRecord[]
  /** Track a new approval after a successful swap */
  addApproval: (record: Omit<ApprovalRecord, 'id' | 'active'>) => void
  /** Mark an approval as revoked */
  markRevoked: (id: string) => void
  /** Get only active approvals that need attention */
  getActionable: () => ApprovalRecord[]
}

export const useActiveApprovals = create<ActiveApprovalsStore>((set, get) => ({
  approvals: [],

  addApproval: (record) => {
    const id = `${record.tokenAddress.toLowerCase()}:${record.spenderAddress.toLowerCase()}`
    set((state) => {
      // Update existing or add new
      const existing = state.approvals.find((a) => a.id === id)
      if (existing) {
        return {
          approvals: state.approvals.map((a) =>
            a.id === id ? { ...a, ...record, id, active: true, timestamp: Date.now() } : a
          ),
        }
      }
      return {
        approvals: [{ ...record, id, active: true }, ...state.approvals].slice(0, 50),
      }
    })
  },

  markRevoked: (id) =>
    set((state) => ({
      approvals: state.approvals.map((a) =>
        a.id === id ? { ...a, active: false, needsRevoke: false } : a
      ),
    })),

  getActionable: () => get().approvals.filter((a) => a.active && a.needsRevoke),
}))
