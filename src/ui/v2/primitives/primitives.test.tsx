// @vitest-environment jsdom
/**
 * [ADR-025] Render test for each v2 primitive: typed props, no business logic, a11y roles/states.
 * Round 7: the no-box language (D2/D3) — Surface / Button / Tabs+Segmented / Chip / Input / Toggle / Skeleton, plus the
 * deprecated old names (Panel, Button `secondary`) still resolving.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button, Chip, EyebrowLabel, HandUnderline, Input, Panel, Segmented, Skeleton, Surface, Tabs, Toggle, type TabItem } from './index'

afterEach(cleanup)

const CSS = readFileSync(join(__dirname, 'primitives.css'), 'utf8')

/** Nothing the language calls a box: no filled surface class, no border-width class, no radius class. */
const BOX = /\b(bg-v2-surface2?(\/\d+)?|border(-[trblxy])?(-\d+)?|rounded(-v2-\w+|-\w+)?)\b/

describe('Surface', () => {
  it('plain: no fill, no border, no radius — content on the photo', () => {
    render(<Surface data-testid="s">hello</Surface>)
    const el = screen.getByTestId('s')
    expect(el.textContent).toBe('hello')
    expect(el.getAttribute('data-surface')).toBe('plain')
    expect(el.className).not.toMatch(BOX)
  })

  it('plain separates with one hairline on the requested edge(s); `rule` is the 2 px accent that replaces a card box', () => {
    render(<>
      <Surface data-testid="r" edge="rule" />
      <Surface data-testid="t" edge="top" />
      <Surface data-testid="b" edge="bottom" />
      <Surface data-testid="l" edge="left" />
      <Surface data-testid="x" edge="both" />
    </>)
    expect(screen.getByTestId('t').className).toBe('ts-v2-rule-t')
    expect(screen.getByTestId('b').className).toBe('ts-v2-rule-b')
    expect(screen.getByTestId('l').className).toBe('ts-v2-rule-l')
    expect(screen.getByTestId('x').className).toBe('ts-v2-rule-t ts-v2-rule-b')
    expect(screen.getByTestId('r').className).toBe('ts-v2-rule-accent')
    expect(CSS).toMatch(/\.ts-v2-rule-accent \{ border-left: 2px solid var\(--hairline-rule\);/)
    expect(screen.getByTestId('r').className).not.toMatch(BOX)
  })

  it('sheet: solid --bg with a top hairline only (a drawer takes the left); no radius, no outline', () => {
    render(<><Surface variant="sheet" data-testid="m" /><Surface variant="sheet" edge="left" data-testid="d" /></>)
    expect(screen.getByTestId('m').className).toMatch(/\bbg-v2-bg\b/)
    expect(screen.getByTestId('m').className).toMatch(/ts-v2-rule-t/)
    expect(screen.getByTestId('d').className).toMatch(/ts-v2-rule-l/)
    expect(screen.getByTestId('d').className).not.toMatch(/ts-v2-rule-t/)
    expect(screen.getByTestId('m').className).not.toMatch(/rounded|\bborder\b|shadow/)
  })

  it('strip: solid --bg with a bottom hairline; an accent swaps it for a 2 px left bar in the status colour', () => {
    render(<><Surface variant="strip" data-testid="s" /><Surface variant="strip" accent="red" data-testid="a" /></>)
    expect(screen.getByTestId('s').className).toMatch(/bg-v2-bg.*ts-v2-rule-b/)
    const a = screen.getByTestId('a').className
    expect(a).toMatch(/\bborder-l-2\b/)
    expect(a).toMatch(/\bborder-v2-red\b/)
    expect(a).not.toMatch(/ts-v2-rule/)
  })

  it('popover: solid --surface, 1 px hairline, no radius, no shadow; bare (tooltip) drops the hairline', () => {
    render(<><Surface variant="popover" data-testid="p" /><Surface variant="popover" bare data-testid="t" /></>)
    const p = screen.getByTestId('p').className
    expect(p).toMatch(/\bbg-v2-surface\b/)
    expect(p).toMatch(/border-\[color:var\(--hairline\)\]/)
    expect(p).not.toMatch(/rounded|shadow/)
    expect(screen.getByTestId('t').className).not.toMatch(/\bborder\b/)
  })

  it('appends className and forwards props', () => {
    render(<Surface variant="strip" className="p-4" aria-label="x" data-testid="s" />)
    expect(screen.getByTestId('s').className).toMatch(/\bp-4\b/)
    expect(screen.getByTestId('s').getAttribute('aria-label')).toBe('x')
  })
})

describe('Panel (deprecated re-export)', () => {
  it('still exists and renders an unboxed plain Surface; overPhoto is accepted and ignored', () => {
    render(<Panel data-testid="p" overPhoto className="p-5">hello</Panel>)
    const el = screen.getByTestId('p')
    expect(el.textContent).toBe('hello')
    expect(el.getAttribute('data-surface')).toBe('plain')
    expect(el.className).toMatch(/\bp-5\b/)
    expect(el.className).not.toMatch(BOX)
    expect(el.hasAttribute('overphoto')).toBe(false)
  })

  it('nothing in the v2 tree calls it any more (callers moved to Surface)', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const root = join(__dirname, '..')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const f = join(d, n)
        return statSync(f).isDirectory() ? walk(f) : /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n) && !f.includes('/primitives/') ? [f] : []
      })
    const callers = walk(root).filter((f) => /<Panel\b/.test(readFileSync(f, 'utf8')))
    expect(callers).toEqual([])
  })
})

describe('Button', () => {
  it('defaults to primary: the solid cream square CTA, type="button", ≥ 46 px', () => {
    render(<Button>go</Button>)
    const b = screen.getByRole('button', { name: 'go' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.className).toMatch(/\bbg-v2-cream\b/)
    expect(b.className).toMatch(/font-v2-mono/)
    expect(b.className).toMatch(/rounded-\[var\(--radius-cta\)\]/)
    expect(b.className).toMatch(/min-h-\[46px\]/)
    expect(b.className).not.toMatch(/rounded-v2|\bborder\b/)
  })

  it('text: no fill, no border, hairline underline, ≥ 44 px, cream; danger is red', () => {
    render(<><Button variant="text">cancel</Button><Button variant="text" tone="danger">revoke</Button></>)
    const a = screen.getByRole('button', { name: 'cancel' })
    expect(a.className).toMatch(/ts-v2-underline/)
    expect(a.className).toMatch(/\btext-v2-cream\b/)
    expect(a.className).toMatch(/bg-transparent/)
    expect(a.className).toMatch(/min-h-\[44px\]/)
    expect(a.className).not.toMatch(BOX)
    const r = screen.getByRole('button', { name: 'revoke' })
    expect(r.className).toMatch(/\btext-v2-red\b/)
    expect(r.getAttribute('data-tone')).toBe('danger')
  })

  it('icon: bare, 44 × 44, no underline, no fill', () => {
    render(<Button variant="icon" aria-label="swap direction">⇅</Button>)
    const b = screen.getByRole('button', { name: 'swap direction' })
    expect(b.className).toMatch(/\bh-11\b/)
    expect(b.className).toMatch(/\bw-11\b/)
    expect(b.className).toMatch(/bg-transparent/)
    expect(b.className).not.toMatch(/ts-v2-underline/)
    expect(b.className).not.toMatch(BOX)
  })

  it('secondary (deprecated) is the text button', () => {
    render(<Button variant="secondary">alt</Button>)
    const b = screen.getByRole('button', { name: 'alt' })
    expect(b.getAttribute('data-variant')).toBe('text')
    expect(b.className).toMatch(/ts-v2-underline/)
    expect(b.className).not.toMatch(/\bbg-v2-cream\b|\bbg-v2-surface\b/)
  })

  it('fires onClick; a disabled button does not (and its underline is gone)', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(<Button onClick={onClick} disabled>go</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(CSS).toMatch(/\.ts-v2-underline:disabled\s*\{\s*box-shadow:\s*none/)
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
    { id: 'c', label: 'C', disabled: true, badge: 'soon' },
  ]

  it('marks the active tab (aria-selected, roving tabindex), cream label, one cream underline on it', () => {
    render(<Tabs tabs={tabs} active="b" onSelect={() => {}} label="t" />)
    expect(screen.getByRole('tablist', { name: 't' })).toBeTruthy()
    const [a, b, c] = screen.getAllByRole('tab') as HTMLButtonElement[]
    expect([a, b, c].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect([a, b].map((t) => t.tabIndex)).toEqual([-1, 0])
    expect(b.className).toMatch(/\btext-v2-cream\b/)
    expect(a.className).toMatch(/\btext-v2-muted\b/)
    const bars = document.querySelectorAll('[data-tab-bar]')
    expect(bars).toHaveLength(1)
    expect(bars[0].className).toMatch(/\bbg-v2-cream\b/)
    expect(b.contains(bars[0])).toBe(true)
  })

  it('selects on click; a disabled tab is dim, shows its badge as plain text and cannot be selected', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={tabs} active="a" onSelect={onSelect} label="t" />)
    fireEvent.click(screen.getByRole('tab', { name: /^B$/ }))
    expect(onSelect).toHaveBeenCalledWith('b')
    const c = screen.getByRole('tab', { name: /C/ }) as HTMLButtonElement
    expect(c.disabled).toBe(true)
    expect(c.className).toMatch(/text-v2-dim/)
    expect(c.textContent).toContain('soon')
    expect(CSS).toMatch(/\[data-tab-badge\]::before \{ content: '· '; \}/)
    expect(c.querySelector('[data-tab-badge]')?.className).not.toMatch(BOX)
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

  it('Segmented is the same underline row, small — no pill', () => {
    render(<Segmented tabs={tabs.slice(0, 2)} active="a" onSelect={() => {}} label="seg" />)
    const [a] = screen.getAllByRole('tab')
    expect(a.className).toMatch(/text-\[12px\]/)
    expect(a.className).not.toMatch(BOX)
    expect(document.querySelectorAll('[data-tab-bar]')).toHaveLength(1)
  })
})

describe('Chip', () => {
  it('is a toggle button: selected = cream + underline marker, others muted; no border, no fill', () => {
    const onClick = vi.fn()
    render(<><Chip selected onClick={onClick}>50%</Chip><Chip onClick={onClick}>100%</Chip></>)
    const [sel, off] = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(sel.getAttribute('aria-pressed')).toBe('true')
    expect(sel.hasAttribute('data-selected')).toBe(true)
    expect(sel.className).toMatch(/\btext-v2-cream\b/)
    expect(off.getAttribute('aria-pressed')).toBe('false')
    expect(off.hasAttribute('data-selected')).toBe(false)
    expect(off.className).toMatch(/\btext-v2-muted\b/)
    for (const c of [sel, off]) {
      expect(c.className).not.toMatch(BOX)
      expect(c.className).toMatch(/min-h-\[44px\]/)
    }
    fireEvent.click(off)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(CSS).toMatch(/\.ts-v2-chip\[data-selected\]\s*\{\s*box-shadow:\s*inset 0 -1px 0 var\(--cream\)/)
  })
})

describe('Input', () => {
  it('is an underline input: transparent, no box; typed value flows through', () => {
    const onChange = vi.fn()
    render(<Input aria-label="amount" scale="amount" placeholder="0.0" onChange={onChange} />)
    const el = screen.getByRole('textbox', { name: 'amount' }) as HTMLInputElement
    expect(el.className).toMatch(/ts-v2-input/)
    expect(el.className).toMatch(/bg-transparent/)
    expect(el.className).toMatch(/font-v2-mono/)
    expect(el.className).not.toMatch(BOX)
    expect(el.hasAttribute('aria-invalid')).toBe(false)
    fireEvent.change(el, { target: { value: '1.5' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('invalid sets aria-invalid; CSS: idle ring underline, cream 2 px on focus, red on error and error wins', () => {
    render(<Input aria-label="f" invalid />)
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')
    expect(CSS).toMatch(/\.ts-v2-input \{[^}]*border-bottom:\s*1px solid var\(--hairline-ring\)/)
    expect(CSS).toMatch(/\.ts-v2-input:focus-visible \{[^}]*border-bottom:\s*2px solid var\(--cream\)/)
    expect(CSS).toMatch(/\.ts-v2-input\[aria-invalid='true'\][^{]*\{[^}]*border-bottom-color:\s*var\(--red\)/)
    expect(CSS.indexOf("[aria-invalid='true']")).toBeGreaterThan(CSS.indexOf('.ts-v2-input:focus-visible'))
    expect(CSS).toMatch(/\.ts-v2-input \{[^}]*border-radius:\s*0/)
  })

  it('forwards its ref', () => {
    const ref = { current: null as HTMLInputElement | null }
    render(<Input aria-label="r" ref={ref} />)
    expect(ref.current?.tagName).toBe('INPUT')
  })
})

describe('Toggle', () => {
  it('is one switch named by its label; the row is unboxed with a hairline under it', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<Toggle checked={false} onChange={onChange} label="Force MEV Protection" />)
    const sw = screen.getByRole('switch', { name: 'Force MEV Protection' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(container.firstElementChild?.className).toMatch(/ts-v2-rule-b/)
    expect(container.firstElementChild?.className).not.toMatch(BOX)
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<Toggle checked onChange={onChange} label="Force MEV Protection" />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('disabled cannot be toggled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} disabled onChange={onChange} label="x" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
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
  it('is a decorative sized bar carrying the shimmer class — square, no border', () => {
    render(<Skeleton data-testid="s" width={120} height="1rem" />)
    const el = screen.getByTestId('s')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.className).toMatch(/ts-v2-skeleton/)
    expect(el.className).not.toMatch(BOX)
    expect(el.style.width).toBe('120px')
    expect(el.style.height).toBe('1rem')
  })

  it('CSS: hairline-cream bar with a 10% cream sweep, 1.2s token, no shimmer under reduced motion', () => {
    expect(CSS).toMatch(/\.ts-v2-skeleton \{[^}]*background-color:\s*var\(--hairline\)/)
    expect(CSS).toMatch(/rgba\(234, 223, 182, 0\.1\)/)
    expect(CSS).toMatch(/animation:\s*ts-v2-shimmer var\(--t-shimmer\)/)
    expect(/@media \(prefers-reduced-motion: reduce\) \{[^}]*background-image:\s*none/.test(CSS)).toBe(true)
  })
})
