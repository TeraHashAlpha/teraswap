/**
 * [fix/catalog-refresh-drops-untrusted] one open failure issue per chain, closed when the chain's refresh passes.
 */
import { describe, it, expect } from 'vitest'
import { failureIssueTitle, heldBackIssueTitle, planFailureIssue, planHeldBackIssue, planPassClose } from './issue-plan'

const T = failureIssueTitle

describe('issue-plan', () => {
  it('title is the one the workflow has always used', () => {
    expect(T(1)).toBe('[token-catalog-guard] chain 1 refresh failed')
    expect(T('8453')).toBe('[token-catalog-guard] chain 8453 refresh failed')
  })

  it('a failed run creates an issue only when the chain has none open', () => {
    expect(planFailureIssue(1, [])).toEqual({ action: 'create' })
    expect(planFailureIssue(1, [{ number: 703, title: T(8453) }])).toEqual({ action: 'create' })
  })

  it('a failed run comments on the open issue — never a second one (lowest number wins)', () => {
    expect(planFailureIssue(1, [{ number: 706, title: T(1) }, { number: 700, title: T(1) }])).toEqual({ action: 'comment', number: 700 })
  })

  it('matching is by EXACT title: chain 1 never matches chain 10 / 8453 / a longer title', () => {
    const open = [
      { number: 5, title: T(10) },
      { number: 6, title: `${T(1)} (again)` },
      { number: 7, title: T(8453) },
      { number: 8, title: `x ${T(1)}` },
    ]
    expect(planFailureIssue(1, open)).toEqual({ action: 'create' })
    expect(planPassClose(1, open)).toEqual([])
  })

  it('a passing run closes every open issue of that chain, only that chain', () => {
    const open = [
      { number: 700, title: T(1) },
      { number: 703, title: T(8453) },
      { number: 706, title: T(42161) },
      { number: 710, title: T(1) },
    ]
    expect(planPassClose(1, open)).toEqual([700, 710])
    expect(planPassClose(8453, open)).toEqual([703])
    expect(planPassClose(42161, open)).toEqual([706])
    expect(planPassClose(1, [])).toEqual([])
  })
})

describe('held-back sources issue (growth breaker) — ONE per chain', () => {
  const t1 = heldBackIssueTitle(1)
  it('title is exact and distinct from the failure issue', () => {
    expect(t1).toBe('[token-catalog-guard] chain 1 source growth held back')
    expect(t1).not.toBe(failureIssueTitle(1))
  })
  it('a held source with no open issue creates one', () => {
    expect(planHeldBackIssue(1, [], 1)).toEqual({ action: 'create' })
  })
  it('a held source with an open issue comments on the lowest-numbered one, never creates a second', () => {
    expect(planHeldBackIssue(1, [{ number: 9, title: t1 }, { number: 4, title: t1 }], 2)).toEqual({ action: 'comment', number: 4 })
  })
  it('nothing held back closes every open held-back issue of THAT chain only', () => {
    const open = [{ number: 4, title: t1 }, { number: 5, title: heldBackIssueTitle(8453) }, { number: 6, title: failureIssueTitle(1) }]
    expect(planHeldBackIssue(1, open, 0)).toEqual({ action: 'close', numbers: [4] })
  })
  it('nothing held back and nothing open does nothing', () => {
    expect(planHeldBackIssue(1, [{ number: 6, title: failureIssueTitle(1) }], 0)).toEqual({ action: 'none' })
  })
  it('a near-miss title is not matched (exact title only)', () => {
    expect(planHeldBackIssue(1, [{ number: 4, title: `${t1} (copy)` }], 1)).toEqual({ action: 'create' })
  })
})
