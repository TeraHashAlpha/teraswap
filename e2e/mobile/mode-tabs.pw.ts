/**
 * [chore/mobile-ux-polish] REAL-render proof (Chromium @ iPhone SE / iPhone 14 / Pixel 7) that the
 * extracted <ModeTabs/> fixes the mobile tab bar: it genuinely overflows + scrolls (no flex-1 squish),
 * every tab is a ≥44px tap target with ≥12px labels, the last tab is reachable by scrolling, the bar
 * never exceeds the viewport, and the edge-fades reflect real scroll position — none of which JSDOM
 * can prove. The harness (real component + compiled Tailwind) is built in globalSetup.
 */
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS = pathToFileURL(join(process.cwd(), 'e2e', 'mobile', '.harness', 'index.html')).href

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS)
  await expect(page.getByTestId('mode-tabs')).toBeVisible()
})

test('the tab row overflows and genuinely scrolls (no flex-1 squish)', async ({ page }) => {
  const row = page.getByTestId('mode-tabs')
  const dims = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  // 6 tabs at natural width exceed every targeted phone width → a real scroll container.
  expect(dims.sw).toBeGreaterThan(dims.cw)
})

test('every tab is a ≥44px tap target with ≥12px labels', async ({ page }) => {
  const metrics = await page.getByTestId('mode-tabs').evaluate((row) => {
    const btns = [...row.querySelectorAll('button')]
    return {
      minHeight: Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))),
      minFontPx: Math.min(...btns.map((b) => parseFloat(getComputedStyle(b).fontSize))),
      count: btns.length,
    }
  })
  expect(metrics.count).toBe(6)
  expect(metrics.minHeight).toBeGreaterThanOrEqual(44)
  expect(metrics.minFontPx).toBeGreaterThanOrEqual(12)
})

test('the bar never exceeds the viewport (no horizontal page overflow)', async ({ page }) => {
  const overflow = await page.getByTestId('mode-tabs').evaluate(
    (row) => Math.round(row.getBoundingClientRect().right) - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test('the last tab is reachable by scrolling, and the left fade then appears', async ({ page }) => {
  const row = page.getByTestId('mode-tabs')
  // Last tab starts clipped (proving there is something to reach).
  const before = await row.evaluate((el) => {
    const last = el.querySelector('button:last-of-type')!.getBoundingClientRect()
    const rb = el.getBoundingClientRect()
    return last.right <= rb.right + 1
  })
  expect(before).toBe(false)

  await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await expect.poll(() => row.evaluate((el) => {
    const last = el.querySelector('button:last-of-type')!.getBoundingClientRect()
    const rb = el.getBoundingClientRect()
    return last.right <= rb.right + 1 && last.left >= rb.left - 1
  })).toBe(true)
  await expect(page.getByTestId('mode-fade-left')).toHaveCSS('opacity', '1')
})

test('the tab bar stays pinned to the top when the page scrolls (sticky)', async ({ page }) => {
  const row = page.getByTestId('mode-tabs')
  await page.evaluate(() => window.scrollTo(0, 800))
  // Pinned: the bar stays at the viewport top (top ≈ 0). A non-sticky bar would scroll off to a large
  // negative top (~ -784 after an 800px scroll), so assert it did NOT go negative.
  await expect.poll(() => row.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeGreaterThanOrEqual(-1)
  const top = await row.evaluate((el) => Math.round(el.getBoundingClientRect().top))
  expect(top).toBeLessThanOrEqual(20) // and it really is at the top, not somewhere mid-page
})

test('a vertical mouse wheel scrolls the row horizontally', async ({ page }) => {
  const row = page.getByTestId('mode-tabs')
  await row.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
})
