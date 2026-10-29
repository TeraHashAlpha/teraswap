// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CtaButton } from './CtaButton'
import type { CtaState } from './cta'

afterEach(cleanup)

describe('one filled shape per screen: only the actionable states are the cream CTA; reporting states are text in the status colour (28a/b/c, 29)', () => {
  const table: [CtaState, 'primary' | 'text', RegExp | null][] = [
    [{ kind: 'connect', label: 'Connect wallet', disabled: false }, 'primary', null],
    [{ kind: 'review', label: 'Review swap', disabled: false }, 'primary', null],
    [{ kind: 'split-swap', label: 'Swap', disabled: false }, 'primary', null],
    [{ kind: 'enter-amount', label: 'Enter amount', disabled: true }, 'primary', null],
    [{ kind: 'wrong-network', label: 'Switch to Ethereum', disabled: false }, 'text', /text-v2-amber/],
    [{ kind: 'in-flight', label: 'Executing swap...', disabled: true }, 'text', /text-v2-muted/],
    [{ kind: 'complete', label: 'Swap complete', disabled: true }, 'text', /text-v2-green/],
    [{ kind: 'retry', label: 'Error — retry', disabled: false }, 'text', /text-v2-red/],
    [{ kind: 'blocked', label: 'Confirm price impact to swap', disabled: true, recoverable: true }, 'text', /text-v2-amber/],
    [{ kind: 'blocked', label: 'Asset depegged — swap blocked', disabled: true, recoverable: false }, 'text', /text-v2-red/],
  ]
  it.each(table)('%o → %s', (cta, variant, tone) => {
    const onClick = vi.fn()
    render(<CtaButton cta={cta} onClick={onClick} />)
    const b = screen.getByRole('button', { name: cta.label })
    expect(b.getAttribute('data-variant')).toBe(variant)
    if (tone) expect(b.className).toMatch(tone)
    expect((b as HTMLButtonElement).disabled).toBe(cta.disabled)
    if (!cta.disabled) {
      fireEvent.click(b)
      expect(onClick).toHaveBeenCalledTimes(1)
    }
  })
})
