/**
 * [chore/mobile-ux-polish-2] REAL-render proof (Chromium @ iPhone SE / iPhone 14 / Pixel 7) that the
 * swept #236 DCA Positions dashboard controls meet the mobile bar that JSDOM cannot verify: every
 * tap target (Cancel / Remove / Cancel All / Remove All / Start a DCA / tx-hash link / category chip)
 * is ≥44px tall, every critical NUMBER (per-buy/total amounts, fill amounts, per-fill USD) is ≥12px,
 * and nothing overflows the viewport. Fixtures are props-only — no network, no timers, no next/image.
 * The harness (real components + compiled Tailwind) is built in globalSetup → dca.html.
 */
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS = pathToFileURL(join(process.cwd(), 'e2e', 'mobile', '.harness', 'dca.html')).href

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS)
  await expect(page.getByTestId('dca-harness')).toBeVisible()
})

test('every swept control is a ≥44px tap target', async ({ page }) => {
  const metrics = await page.getByTestId('dca-harness').evaluate((root) => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const controls = [...root.querySelectorAll('button, a[href]')].filter(isVisible)
    const heights = controls.map((c) => Math.round(c.getBoundingClientRect().height))
    return {
      count: controls.length,
      minHeight: heights.length ? Math.min(...heights) : null,
      // The smallest control's label, for a useful failure message.
      smallest: controls
        .map((c) => ({ h: Math.round(c.getBoundingClientRect().height), t: (c.textContent || '').trim().slice(0, 24) }))
        .sort((a, b) => a.h - b.h)[0],
    }
  })
  // Sanity: the fixtures actually rendered the swept controls (tx link + chips + 4 button kinds).
  expect(metrics.count).toBeGreaterThanOrEqual(8)
  expect(metrics.minHeight, `smallest control: ${JSON.stringify(metrics.smallest)}`).toBeGreaterThanOrEqual(44)
})

test('critical numbers render at ≥12px', async ({ page }) => {
  const minFont = await page.getByTestId('dca-harness').evaluate((root) => {
    // Critical NUMBER displays: OrbitStatRow per-buy/total amounts (tabular-nums), the fill
    // amountIn→amountOut line, and the per-fill USD. (Micro labels/timestamps/badges are excluded.)
    const sel = ['span.tabular-nums', '[data-testid="fill-row"] p.text-cream-65', '[data-testid="fill-usd"]']
    const els = sel.flatMap((s) => [...root.querySelectorAll(s)])
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((n) => Number.isFinite(n))
    return { count: sizes.length, min: sizes.length ? Math.min(...sizes) : null }
  })
  expect(minFont.count).toBeGreaterThan(0)
  expect(minFont.min).toBeGreaterThanOrEqual(12)
})

test('the dashboard never overflows the viewport horizontally', async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})
