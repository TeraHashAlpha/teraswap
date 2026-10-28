// @vitest-environment jsdom
/**
 * [ADR-025] Round 7 item 13 — the keyboard / focus contract every v2 swap modal inherits from Sheet: a labelled aria-modal dialog,
 * Tab wraps inside it (both directions), Esc closes it, the dimmed page closes it, and focus goes back to the opener.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from './Sheet'

afterEach(cleanup)

function Harness({ dismissOnBackdrop = true }: { dismissOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && (
        <Sheet title="Test sheet" subtitle="About it" onClose={() => setOpen(false)} dismissOnBackdrop={dismissOnBackdrop} name="t">
          <button>first</button>
          <input aria-label="field" />
          <button>last</button>
        </Sheet>
      )}
    </div>
  )
}

const press = (key: string, opts: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key, ...opts })

describe('Sheet', () => {
  it('is a labelled, described aria-modal dialog on a solid surface with a top hairline only', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    const dlg = screen.getByRole('dialog', { name: 'Test sheet' })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy()
    expect(dlg.getAttribute('data-surface')).toBe('sheet')
    expect(dlg.className).toContain('ts-v2-rule-t') // the top hairline
    expect(dlg.className).not.toMatch(/rounded|border-(?!t)|shadow|ring/) // no radius, outline or shadow classes
  })

  it('moves focus into the sheet on open', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    screen.getByText('last').focus()
    press('Tab')
    expect(document.activeElement).toBe(screen.getByText('first'))
    press('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('last'))
  })

  it('focus that has escaped the sheet is pulled back in on the next Tab', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    screen.getByText('opener').focus()
    press('Tab')
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('Esc closes the sheet and focus returns to the opener', () => {
    render(<Harness />)
    const opener = screen.getByText('opener')
    opener.focus()
    fireEvent.click(opener)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    press('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('a click on the dimmed page closes it, unless the sheet opts out', () => {
    const { unmount } = render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()

    render(<Harness dismissOnBackdrop={false} />)
    fireEvent.click(screen.getByText('opener'))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('Esc is handled once and does not reach a listener behind the sheet', () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    render(<Harness />)
    fireEvent.click(screen.getByText('opener'))
    press('Escape')
    document.removeEventListener('keydown', behind)
    expect(behind).not.toHaveBeenCalled()
  })
})
