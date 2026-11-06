// @vitest-environment jsdom
/**
 * [S-3, A75b] The Help Center is v1's right-edge drawer (HelpDrawer.tsx: fixed right-0 top-0 bottom-0, max-w-[420px], left hairline)
 * and round 7 item 7 keeps it: a drawer with a left hairline at >= 1024 px, a bottom sheet only below. L-6/A75 rebuilt it on Sheet,
 * which centres a 440 px modal at 1440 and so lost the geometry. Layout does not exist in jsdom: this pins the marker and the
 * stylesheet rules that carry the geometry; the real-render check is `help drawer` in __tests__/mobile/mobile.pw.ts (CI job
 * v2-mobile-parity).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HelpDrawer } from '../shell/HelpDrawer'
import { Sheet } from './Sheet'

afterEach(cleanup)

const css = readFileSync(join(__dirname, 'modals.css'), 'utf8')
/** The declarations of the rule `<selector> { … }` inside `scope` (plain string search: no regex is built from a selector). */
const rule = (scope: string, selector: string) => {
  const start = scope.indexOf(`${selector} {`)
  if (start < 0) return ''
  const open = scope.indexOf('{', start)
  return scope.slice(open + 1, scope.indexOf('}', open))
}
const media = (query: string) => {
  const start = css.indexOf(`@media (${query})`)
  if (start < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i)
  }
  return ''
}

describe('Sheet placement="drawer"', () => {
  it('marks the root; every other sheet is unmarked (centre / bottom as before)', () => {
    const { rerender } = render(<Sheet title="Plain" onClose={() => {}}><button>x</button></Sheet>)
    expect(document.querySelector('[data-sheet-root]')!.hasAttribute('data-placement')).toBe(false)
    rerender(<Sheet title="Side" placement="drawer" onClose={() => {}}><button>x</button></Sheet>)
    expect(document.querySelector('[data-sheet-root]')!.getAttribute('data-placement')).toBe('drawer')
  })

  it('the Help Center opens as a drawer with the left hairline', () => {
    render(<HelpDrawer open onClose={() => {}} />)
    expect(document.querySelector('[data-sheet-root]')!.getAttribute('data-placement')).toBe('drawer')
    expect(screen.getByRole('dialog').className).toContain('ts-v2-rule-l')
    fireEvent.keyDown(document, { key: 'Escape' })
  })
})

describe('modals.css: drawer geometry', () => {
  const desktop = media('min-width: 1024px')
  const drawerRoot = "[data-placement='drawer']"

  it('from 1024 px up: flush to the right edge, full height, 420 px wide (v1 max-w-[420px])', () => {
    expect(desktop).toContain(drawerRoot)
    const root = rule(desktop, `.ts-sheet-root${drawerRoot}`)
    expect(root).toMatch(/justify-content:\s*flex-end/)
    expect(root).toMatch(/align-items:\s*stretch/)
    expect(root).toMatch(/padding:\s*0/)
    const panel = rule(desktop, `.ts-sheet-root${drawerRoot} .ts-sheet`)
    expect(panel).toMatch(/max-width:\s*420px/)
    expect(panel).toMatch(/height:\s*100%/)
    expect(panel).toMatch(/max-height:\s*none/)
  })

  it('below 1024 px (outside that media query): a bottom sheet, full width, grab bar, top hairline', () => {
    const outside = css.replace(desktop, '')
    const root = rule(outside, `.ts-sheet-root${drawerRoot}`)
    expect(root).toMatch(/align-items:\s*flex-end/)
    expect(root).toMatch(/padding:\s*0/)
    expect(rule(outside, `.ts-sheet-root${drawerRoot} .ts-sheet`)).toMatch(/max-width:\s*none/)
    expect(rule(outside, `.ts-sheet-root${drawerRoot} .ts-sheet-grab`)).toMatch(/display:\s*block/)
    expect(rule(outside, `.ts-sheet-root${drawerRoot} .ts-sheet`)).toMatch(/border-top:\s*1px solid var\(--hairline\)/)
  })

  it('does not hang the drawer on the 600 px phone breakpoint (the bug: centred modal at 601-1023)', () => {
    expect(media('max-width: 600px')).not.toContain(drawerRoot)
  })
})
