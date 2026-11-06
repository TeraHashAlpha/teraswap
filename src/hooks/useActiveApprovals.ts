import { create } from 'zustand'
import type { AggregatorName } from '@/lib/constants'

/**
 * Schema version of an {@link ApprovalRecord}.
 *   1 — up to B8: no `chainId`. Revoke and its receipt link used whatever chain the wallet was on at click time.
 *   2 — fix/revoke-chain: `chainId` is the chain the approve tx was sent on. A v1 record is read as `chainId: undefined`
 *       ("chain unknown") — never guessed — and cannot be revoked from the UI.
 * The store is in-memory (no persist middleware): nothing on disk carries a v1 record, but {@link readApprovalRecord} keeps
 * the old shape readable for any reader that ever receives one (rule #4: old shape readable, not deleted).
 */
export const APPROVAL_RECORD_SCHEMA_VERSION = 2

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
  /**
   * [fix/revoke-chain] The chain the approve tx was sent on — set at write time from the wallet's chain for that tx,
   * never from UI state. `undefined` = unknown (a schema-1 record, or the wallet's chain could not be read when the
   * record was written): shown as "Network unknown", never revocable from the UI, never defaulted to a chain.
   */
  chainId: number | undefined
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

/** A chain id is kept only when it is a positive integer; anything else is "unknown" (never coerced to a default). */
function normalizeChainId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

const METHODS: ReadonlySet<string> = new Set(['permit2', 'exact', 'infinite'])
const isHexAddress = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/**
 * Read a record of ANY past schema into the current one. A schema-1 record (no `chainId`) becomes chain-unknown; a
 * `chainId` that is not a positive integer becomes unknown too. Returns `null` for anything that is not a record.
 */
export function readApprovalRecord(raw: unknown): ApprovalRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isHexAddress(r.tokenAddress) || !isHexAddress(r.spenderAddress)) return null
  if (typeof r.method !== 'string' || !METHODS.has(r.method)) return null
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return null
  const id = typeof r.id === 'string' && r.id ? r.id : `${r.tokenAddress.toLowerCase()}:${r.spenderAddress.toLowerCase()}`
  return {
    id,
    tokenAddress: r.tokenAddress,
    tokenSymbol: typeof r.tokenSymbol === 'string' ? r.tokenSymbol : '',
    spenderAddress: r.spenderAddress,
    spenderLabel: typeof r.spenderLabel === 'string' ? r.spenderLabel : '',
    source: (typeof r.source === 'string' ? r.source : '') as AggregatorName,
    method: r.method as ApprovalRecord['method'],
    timestamp: r.timestamp,
    active: r.active !== false,
    needsRevoke: r.needsRevoke === true,
    chainId: normalizeChainId(r.chainId),
  }
}

export const useActiveApprovals = create<ActiveApprovalsStore>((set, get) => ({
  approvals: [],

  addApproval: (record) => {
    const id = `${record.tokenAddress.toLowerCase()}:${record.spenderAddress.toLowerCase()}`
    const chainId = normalizeChainId(record.chainId)
    set((state) => {
      // Update existing or add new
      const existing = state.approvals.find((a) => a.id === id)
      if (existing) {
        return {
          approvals: state.approvals.map((a) =>
            a.id === id ? { ...a, ...record, chainId, id, active: true, timestamp: Date.now() } : a
          ),
        }
      }
      return {
        approvals: [{ ...record, chainId, id, active: true }, ...state.approvals].slice(0, 50),
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
