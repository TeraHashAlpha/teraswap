/**
 * [fix/revoke-chain C1] Approval records carry the chain the approve tx was sent on. The store is in-memory; the chain is
 * stored verbatim (never defaulted), a record without one is "chain unknown", and the schema-1 shape (no `chainId`) stays
 * readable through `readApprovalRecord` (rule #4: old shape readable, never deleted).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { APPROVAL_RECORD_SCHEMA_VERSION, readApprovalRecord, useActiveApprovals, type ApprovalRecord } from './useActiveApprovals'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const
const base = (over: Partial<Omit<ApprovalRecord, 'id' | 'active'>> = {}): Omit<ApprovalRecord, 'id' | 'active'> => ({
  tokenAddress: USDC, tokenSymbol: 'USDC', spenderAddress: RELAYER, spenderLabel: 'CoW VaultRelayer',
  source: 'cowswap' as ApprovalRecord['source'], method: 'exact', timestamp: 1_700_000_000_000, needsRevoke: true, chainId: 8453, ...over,
})

beforeEach(() => useActiveApprovals.setState({ approvals: [] }))

describe('addApproval — the record stores the chain it was written with', () => {
  it('keeps chainId verbatim (8453 stays 8453, 1 stays 1)', () => {
    useActiveApprovals.getState().addApproval(base({ chainId: 8453 }))
    expect(useActiveApprovals.getState().approvals[0].chainId).toBe(8453)
    useActiveApprovals.getState().addApproval(base({ tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1 }))
    expect(useActiveApprovals.getState().approvals[0].chainId).toBe(1)
  })
  it('an unknown chain stays unknown — never defaulted to mainnet or to the previous record', () => {
    useActiveApprovals.getState().addApproval(base({ chainId: undefined }))
    expect(useActiveApprovals.getState().approvals[0]).toHaveProperty('chainId', undefined)
    expect(useActiveApprovals.getState().approvals[0].chainId).not.toBe(1)
  })
  it('re-approving the same token:spender overwrites the chain with the NEW write\'s chain (not the old record\'s)', () => {
    useActiveApprovals.getState().addApproval(base({ chainId: 1 }))
    useActiveApprovals.getState().addApproval(base({ chainId: 8453 }))
    const all = useActiveApprovals.getState().approvals
    expect(all.length).toBe(1)
    expect(all[0].chainId).toBe(8453)
    useActiveApprovals.getState().addApproval(base({ chainId: undefined }))
    expect(useActiveApprovals.getState().approvals[0].chainId).toBeUndefined() // a later unknown does not inherit 8453
  })
  it('a non-integer / non-positive chainId is unknown (never coerced)', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '8453' as unknown as number]) {
      useActiveApprovals.setState({ approvals: [] })
      useActiveApprovals.getState().addApproval(base({ chainId: bad }))
      expect(useActiveApprovals.getState().approvals[0].chainId).toBeUndefined()
    }
  })
})

describe('readApprovalRecord — versioned reader (schema 1 → 2)', () => {
  it('schema version is 2', () => expect(APPROVAL_RECORD_SCHEMA_VERSION).toBe(2))
  it('a schema-1 record (no chainId key) reads as chain-unknown, everything else intact', () => {
    const v1 = { id: `${USDC.toLowerCase()}:${RELAYER.toLowerCase()}`, tokenAddress: USDC, tokenSymbol: 'USDC', spenderAddress: RELAYER, spenderLabel: 'CoW VaultRelayer', source: 'cowswap', method: 'exact', timestamp: 1_700_000_000_000, active: true, needsRevoke: true }
    const r = readApprovalRecord(v1)!
    expect(r).not.toBeNull()
    expect(r.chainId).toBeUndefined()
    expect(r).toMatchObject({ ...v1, chainId: undefined })
  })
  it('a schema-2 record reads unchanged', () => {
    const v2: ApprovalRecord = { id: 'x', ...base({ chainId: 42161 }), active: true }
    expect(readApprovalRecord(v2)).toEqual(v2)
  })
  it('a bad chainId on a stored record is unknown, not guessed', () => {
    expect(readApprovalRecord({ ...base(), chainId: '8453' })!.chainId).toBeUndefined()
    expect(readApprovalRecord({ ...base(), chainId: 0 })!.chainId).toBeUndefined()
  })
  it('derives the id when missing; defaults active=true / needsRevoke=false like the store', () => {
    const r = readApprovalRecord({ tokenAddress: USDC, spenderAddress: RELAYER, method: 'exact', timestamp: 1 })!
    expect(r.id).toBe(`${USDC.toLowerCase()}:${RELAYER.toLowerCase()}`)
    expect(r.active).toBe(true)
    expect(r.needsRevoke).toBe(false)
  })
  it('anything that is not a record → null (no throw)', () => {
    for (const junk of [null, undefined, 1, 'x', {}, { tokenAddress: 'nope' }, { ...base(), method: 'yolo' }, { ...base(), timestamp: 'now' }]) {
      expect(readApprovalRecord(junk)).toBeNull()
    }
  })
})
