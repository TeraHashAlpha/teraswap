// @vitest-environment jsdom
/**
 * [ADR-025] Render test for each v2 primitive: typed props, no business logic, a11y roles/states.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button, EyebrowLabel, HandUnderline, Panel, Skeleton, Tabs, type TabItem } from './index'

afterEach(cleanup)

describe('Panel', () => {
  it('renders children on a surface with 1px border and card radius', () => {
    render(<Panel data-testid="p">hello</Panel>)
    const el = screen.getByTestId('p')
    expect(el.textContent).toBe('hello')
    expect(el.className).toMatch(/\bbg-v2-surface\b/)
    expect(el.className).toMatch(/\bborder\b/)
    expect(el.className).toMatch(/rounded-v2-card/)
  })

  it('overPhoto keeps it 95% opaque; className is appended', () => {
    render(<Panel data-testid="p" overPhoto className="p-5">x</Panel>)
    const el = screen.getByTestId('p')
    expect(el.className).toMatch(/bg-v2-surface\/95/)
    expect(el.className).toMatch(/\bp-5\b/)
  })
})

describe('Button', () => {
  it('defaults to primary (cream) and type="button"', () => {
    render(<Button>go</Button>)
    const b = screen.getByRole('button', { name: 'go' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.className).toMatch(/\bbg-v2-cream\b/)
    expect(b.className).toMatch(/font-v2-mono/)
    expect(b.className).toMatch(/rounded-v2-control/)
  })

  it('secondary uses the surface style, not cream', () => {
    render(<Button variant="secondary">alt</Button>)
    const b = screen.getByRole('button', { name: 'alt' })
    expect(b.className).toMatch(/\bbg-v2-surface\b/)
    expect(b.className).not.toMatch(/\bbg-v2-cream\b/)
  })

  it('fires onClick; a disabled button does not', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(<Button onClick={onClick} disabled>go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('forwards its ref', () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(<Button ref={ref}>r</Button>)
    expect(ref.current?.tagName).toBe('BUTTON')
  })
})

describe('Tabs', () => {
  const tabs: TabItem[] = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C', disabled: true, badge: 'chip' },
  ]

  it('marks the active tab (aria-selected, roving tabindex) and draws one cream bar on it', () => {
    render(<Tabs tabs={tabs} active="b" onSelect={() => {}} label="t" />)
    expect(screen.getByRole('tablist', { name: 't' })).toBeTruthy()
    const [a, b, c] = screen.getAllByRole('tab') as HTMLButtonElement[]
    expect([a, b, c].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect([a, b].map((t) => t.tabIndex)).toEqual([-1, 0])
    const bars = document.querySelectorAll('[data-tab-bar]')
    expect(bars).toHaveLength(1)
    expect(bars[0].className).toMatch(/\bbg-v2-cream\b/)
    expect(b.contains(bars[0])).toBe(true)
  })

  it('selects on click; a disabled tab is dim, shows its badge and cannot be selected', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={tabs} active="a" onSelect={onSelect} label="t" />)
    fireEvent.click(screen.getByRole('tab', { name: /^B$/ }))
    expect(onSelect).toHaveBeenCalledWith('b')
    const c = screen.getByRole('tab', { name: /C/ }) as HTMLButtonElement
    expect(c.disabled).toBe(true)
    expect(c.className).toMatch(/text-v2-dim/)
    expect(c.textContent).toContain('chip')
    fireEvent.click(c)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('arrow keys / Home / End move between enabled tabs only (wrapping)', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={tabs} active="a" onSelect={onSelect} label="t" />)
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('b')
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('b') // wraps over the disabled tab: a → b
    fireEvent.keyDown(list, { key: 'End' })
    expect(onSelect).toHaveBeenLastCalledWith('b')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(onSelect).toHaveBeenLastCalledWith('a')
  })
})

describe('EyebrowLabel', () => {
  it('renders mono uppercase text with a cream bar', () => {
    render(<EyebrowLabel>label</EyebrowLabel>)
    const el = screen.getByText('label')
    expect(el.className).toMatch(/border-l-2/)
    expect(el.className).toMatch(/border-v2-cream/)
    expect(el.className).toMatch(/font-v2-mono/)
    expect(el.className).toMatch(/uppercase/)
  })
})

describe('HandUnderline', () => {
  it('wraps its children with a decorative inline SVG stroke', () => {
    render(<HandUnderline data-testid="h">word</HandUnderline>)
    const el = screen.getByTestId('h')
    expect(el.textContent).toBe('word')
    const svg = el.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.querySelectorAll('path').length).toBeGreaterThanOrEqual(1)
    expect(svg?.getAttribute('class')).toMatch(/text-v2-cream/)
  })
})

describe('Skeleton', () => {
  it('is a decorative sized block carrying the shimmer class', () => {
    render(<Skeleton data-testid="s" width={120} height="1rem" />)
    const el = screen.getByTestId('s')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.className).toMatch(/ts-v2-skeleton/)
    expect(el.style.width).toBe('120px')
    expect(el.style.height).toBe('1rem')
  })

  it('CSS: cream 5% sweep on surface-2, 1.2s token, shimmer off under reduced motion', () => {
    const css = readFileSync(join(__dirname, 'primitives.css'), 'utf8')
    expect(css).toMatch(/background-color:\s*var\(--surface-2\)/)
    expect(css).toMatch(/rgba\(234, 223, 182, 0\.05\)/)
    expect(css).toMatch(/animation:\s*ts-v2-shimmer var\(--t-shimmer\)/)
    expect(/@media \(prefers-reduced-motion: reduce\) \{[^}]*background-image:\s*none/.test(css)).toBe(true)
  })
})
