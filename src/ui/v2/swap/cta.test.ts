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
