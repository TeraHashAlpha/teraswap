import { describe, expect, it } from 'vitest'
import { ctaFor, type CtaInput } from './cta'

const READY: CtaInput = { isConnected: true, isCorrectChain: true, targetChainName: 'Ethereum', hasAmount: true, hasSufficientBalance: true, quoteLoading: false, hasQuote: true }
const row = (over: Partial<CtaInput>) => ctaFor({ ...READY, ...over })

describe('CTA matrix (v1 SwapButton order; Swap → Review swap)', () => {
  // [inputs that differ from READY, kind, label, disabled]
  const table: [string, Partial<CtaInput>, string, string, boolean][] = [
    ['not connected', { isConnected: false }, 'connect', 'Connect wallet', false],
    ['not connected, with an amount and a quote', { isConnected: false, hasAmount: true, hasQuote: true }, 'connect', 'Connect wallet', false],
    ['connected, wrong network (29)', { isCorrectChain: false }, 'wrong-network', 'Switch to Ethereum', false],
    ['wrong network wins over everything below', { isCorrectChain: false, hasAmount: false, hasSufficientBalance: false }, 'wrong-network', 'Switch to Ethereum', false],
    ['the switch names the target chain it is given', { isCorrectChain: false, targetChainName: 'Base' }, 'wrong-network', 'Switch to Base', false],
    ['no amount', { hasAmount: false, hasQuote: false }, 'enter-amount', 'Enter amount', true],
    ['amount above the balance', { hasSufficientBalance: false }, 'insufficient-balance', 'Insufficient balance', true],
    ['balance beats quoting', { hasSufficientBalance: false, quoteLoading: true }, 'insufficient-balance', 'Insufficient balance', true],
    ['quoting (21b)', { quoteLoading: true, hasQuote: false }, 'finding-route', 'Finding best route...', true],
    ['quoting, even with a stale quote at hand', { quoteLoading: true, hasQuote: true }, 'finding-route', 'Finding best route...', true],
    ['settled with no quote', { hasQuote: false }, 'no-quotes', 'No quotes available', true],
    ['ready (20)', {}, 'review', 'Review swap', false],
  ]
  it.each(table)('%s', (_name, over, kind, label, disabled) => {
    expect(row(over)).toEqual({ kind, label, disabled })
  })

  it('exactly the five goal states are reachable on the happy-path inputs: Connect wallet · Enter amount · Insufficient balance · Review swap · Wrong network', () => {
    const labels = new Set(
      [{ isConnected: false }, { hasAmount: false }, { hasSufficientBalance: false }, {}, { isCorrectChain: false }].map((o) => row(o).label.replace(/ to .*/, ' to')),
    )
    expect([...labels].sort()).toEqual(['Connect wallet', 'Enter amount', 'Insufficient balance', 'Review swap', 'Switch to'])
  })

  it('only the ready state is both enabled and a swap: the others either prompt (connect / switch) or are disabled', () => {
    for (const [, over, kind, , disabled] of table) {
      if (kind === 'review') continue
      expect(kind === 'connect' || kind === 'wrong-network' ? !disabled : disabled).toBe(true)
      expect(row(over).kind).not.toBe('review')
    }
  })
})

describe('B5 — SwapButton\'s remaining states, in v1\'s order and words', () => {
  const full: [string, Partial<CtaInput>, string, string, boolean][] = [
    ['price-gate block beats approval and swap states', { blockReason: 'oracle', approvalStatus: 'approving_permit2' }, 'blocked', 'No oracle — swap blocked', true],
    ['approving', { approvalStatus: 'approving_permit2', approvalReady: false }, 'in-flight', 'Approving...', true],
    ['signing the approval', { approvalStatus: 'signing', approvalReady: false }, 'in-flight', 'Signing...', true],
    ['approval error → retry', { approvalStatus: 'error', approvalReady: false }, 'retry', 'Approval error — retry', false],
    ['approval still needed (single route: the review sheet carries "Approve & Swap")', { approvalReady: false }, 'review', 'Review swap', false],
    ['approval still needed (split route: no review → v1\'s own label)', { approvalReady: false, splitActive: true }, 'split-swap', 'Approve & Swap', false],
    ['ready, split route', { approvalReady: true, splitActive: true }, 'split-swap', 'Swap', false],
    ['preparing', { approvalReady: true, swapStatus: 'fetching_swap' }, 'in-flight', 'Preparing swap...', true],
    ['simulating', { approvalReady: true, swapStatus: 'simulating' }, 'in-flight', 'Simulating transaction...', true],
    ['review transaction', { approvalReady: true, swapStatus: 'confirming' }, 'in-flight', 'Review transaction...', true],
    ['CoW: sign in wallet', { approvalReady: true, swapStatus: 'cow_signing' }, 'in-flight', 'Sign order in wallet...', true],
    ['CoW: waiting for solver', { approvalReady: true, swapStatus: 'cow_pending' }, 'in-flight', 'Waiting for solver...', true],
    ['executing', { approvalReady: true, swapStatus: 'swapping' }, 'in-flight', 'Executing swap...', true],
    ['complete', { approvalReady: true, swapStatus: 'success' }, 'complete', 'Swap complete', true],
    ['error → retry', { approvalReady: true, swapStatus: 'error' }, 'retry', 'Error — retry', false],
  ]
  it.each(full)('%s', (_n, over, kind, label, disabled) => {
    const r = row(over)
    expect({ kind: r.kind, label: r.label, disabled: r.disabled }).toEqual({ kind, label, disabled })
  })
  it('the B3 states still win over every lifecycle state (wrong network beats an in-flight swap)', () => {
    expect(row({ isCorrectChain: false, swapStatus: 'swapping', blockReason: 'oracle' }).kind).toBe('wrong-network')
  })
})
