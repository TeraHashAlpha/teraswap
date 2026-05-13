// @vitest-environment jsdom
/**
 * [P115/M-01] Permit2EducationModal — first-Permit2 explainer modal.
 *
 * Tests the security-relevant flow:
 *   - mount/unmount via the `open` prop
 *   - Escape key triggers onCancel
 *   - "I understand" / "Continue" triggers onConfirm
 *   - "Don't show again" checkbox writes a localStorage flag
 *   - isPermit2Educated() reads that flag correctly
 *   - Focus trap: tabbing past the last focusable wraps to the first
 *     (kept light — we verify the listener installs, not full physics)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import Permit2EducationModal, { isPermit2Educated } from './Permit2EducationModal'

const STORAGE_KEY = 'teraswap:permit2-educated:v1'

describe('Permit2EducationModal', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders nothing when open=false', () => {
    const { container } = render(
      <Permit2EducationModal open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog when open=true', () => {
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      screen.getByText(/about to sign a permit2 approval/i),
    ).toBeInTheDocument()
  })

  it('shows the amount + tokenSymbol row when both are provided', () => {
    render(
      <Permit2EducationModal
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        amount="1234"
        tokenSymbol="USDC"
      />,
    )
    expect(screen.getByText('1234 USDC')).toBeInTheDocument()
  })

  it('fires onCancel when Escape is pressed', () => {
    const onCancel = vi.fn()
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the backdrop is clicked', async () => {
    const onCancel = vi.fn()
    const { container } = render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    // The outermost element is the role="presentation" backdrop.
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onCancel).toHaveBeenCalled()
  })

  it('does NOT fire onCancel when the dialog body is clicked (stopPropagation)', () => {
    const onCancel = vi.fn()
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('fires onConfirm when "Continue to signature" is clicked', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <Permit2EducationModal open onConfirm={onConfirm} onCancel={vi.fn()} />,
    )
    await user.click(screen.getByRole('button', { name: /continue to signature/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the Cancel button is clicked', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('writes the localStorage flag when "Don\'t show again" is checked + confirmed', async () => {
    const user = userEvent.setup()
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    // Default: nothing in localStorage.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /continue to signature/i }))

    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
    expect(isPermit2Educated()).toBe(true)
  })

  it('does NOT write the localStorage flag when "Don\'t show again" is unchecked', async () => {
    const user = userEvent.setup()
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    await user.click(screen.getByRole('button', { name: /continue to signature/i }))
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(isPermit2Educated()).toBe(false)
  })

  it('isPermit2Educated() reads the flag set by a prior confirm', () => {
    localStorage.setItem(STORAGE_KEY, '1')
    expect(isPermit2Educated()).toBe(true)
  })

  it('focuses the Cancel button on open (focus trap entry point)', () => {
    render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    const cancelBtn = screen.getByRole('button', { name: /^cancel$/i })
    // firstFocusRef points at Cancel; the useEffect calls .focus() on mount.
    expect(document.activeElement).toBe(cancelBtn)
  })

  it('removes its keydown listener on close (no Escape after unmount)', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <Permit2EducationModal open onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    rerender(
      <Permit2EducationModal open={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    cleanup()
  })
})
