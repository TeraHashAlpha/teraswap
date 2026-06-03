// @vitest-environment jsdom
/**
 * [SPRINT-9J J3] The info (ⓘ) togglers were plain <span title="…"> — the native
 * HTML title only shows on slow hover and never on click or touch, so on mobile
 * (and on click anywhere) the tooltips "don't open". InfoTooltip is a real
 * popover: opens on click AND hover, closes on Escape / outside click, exposes
 * role="tooltip" + aria, and renders content as TEXT (no XSS).
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InfoTooltip from './InfoTooltip'

describe('InfoTooltip [SPRINT-9J J3]', () => {
  it('is closed initially and the trigger is an accessible button', () => {
    render(<InfoTooltip content="Hello info" label="Price impact info" />)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('button', { name: /price impact info/i })).toBeInTheDocument()
  })

  it('OPENS on click (the native-title bug fix) and closes on a second click', () => {
    render(<InfoTooltip content="Hello info" label="info" />)
    const trigger = screen.getByRole('button', { name: /info/i })
    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hello info')
    fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on hover and closes on mouse leave', () => {
    render(<InfoTooltip content="Hover info" label="info" />)
    const trigger = screen.getByRole('button', { name: /info/i })
    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hover info')
    fireEvent.mouseLeave(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes on Escape after being clicked open', () => {
    render(<InfoTooltip content="Esc info" label="info" />)
    fireEvent.click(screen.getByRole('button', { name: /info/i }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('renders content as TEXT, never as HTML (no XSS)', () => {
    render(<InfoTooltip content={'<img src=x onerror=alert(1)>'} label="info" />)
    fireEvent.click(screen.getByRole('button', { name: /info/i }))
    const tip = screen.getByRole('tooltip')
    expect(tip.querySelector('img')).toBeNull()
    expect(tip).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})
