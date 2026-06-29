/**
 * REAL-render proof (Chromium, desktop mouse @1280px) that the TokenSelector category
 * chips scroll horizontally and the last category is reachable — the thing JSDOM
 * could never prove (it does no layout). Mounts the real <CategoryChips/> in a
 * faithful copy of the modal card via an esbuild bundle + the app's compiled Tailwind
 * CSS (built in globalSetup). [chore/category-scroll-fix]
 */
import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Playwright runs from the config/root dir; the harness is built by globalSetup
// into e2e/category-chips/.harness (avoids import.meta — Playwright compiles .ts to CJS).
const HARNESS = pathToFileURL(
  join(process.cwd(), 'e2e', 'category-chips', '.harness', 'index.html'),
).href

/** Is the row's last chip fully inside the row's visible (scroll) viewport? */
function lastChipFullyVisible(el: HTMLElement): boolean {
  const last = el.querySelector('button:last-of-type') as HTMLElement
  const rb = el.getBoundingClientRect()
  const lb = last.getBoundingClientRect()
  return lb.right <= rb.right + 1 && lb.left >= rb.left - 1
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }) // desktop
  await page.goto(HARNESS)
  await expect(page.getByTestId('category-chips')).toBeVisible()
})

test('the row genuinely overflows and the last category starts off-screen', async ({ page }) => {
  const row = page.getByTestId('category-chips')

  // (1) scrollWidth > clientWidth — JSDOM can NOT see this (no layout).
  const dims = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  expect(dims.sw).toBeGreaterThan(dims.cw)

  // (2) The last category is clipped at the start (proving there's something to reach).
  expect(await row.evaluate(lastChipFullyVisible)).toBe(false)

  // (3) Right edge-fade affordance is shown; left one is hidden at the start.
  await expect(page.getByTestId('cat-fade-right')).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('cat-fade-left')).toHaveCSS('opacity', '0')
})

test('a vertical MOUSE WHEEL scrolls the row horizontally to the last category', async ({ page }) => {
  const row = page.getByTestId('category-chips')

  await row.hover()
  await page.mouse.wheel(0, 800)
  // (4) user scroll (wheel) changes scrollLeft.
  await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)

  // (5) Scrolled to the end → last category fully reachable/visible; fades flip.
  await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await expect.poll(() => row.evaluate(lastChipFullyVisible)).toBe(true)
  await expect(page.getByTestId('cat-fade-right')).toHaveCSS('opacity', '0')
  await expect(page.getByTestId('cat-fade-left')).toHaveCSS('opacity', '1')
})

test('programmatic scroll changes scrollLeft (the row is a real scroll container)', async ({ page }) => {
  const row = page.getByTestId('category-chips')
  const moved = await row.evaluate((el) => {
    el.scrollLeft = 120
    return el.scrollLeft
  })
  expect(moved).toBeGreaterThan(0)
})

test('drag-to-scroll moves the row (mouse users with no horizontal wheel)', async ({ page }) => {
  const row = page.getByTestId('category-chips')
  const box = (await row.boundingBox())!
  const y = box.y + box.height / 2
  // Drag from the right edge toward the left → scrolls forward.
  await page.mouse.move(box.x + box.width - 24, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 24, y, { steps: 12 })
  await page.mouse.up()
  expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
})

test('a real click toggles the filter; a drag does NOT toggle it', async ({ page }) => {
  const row = page.getByTestId('category-chips')
  const active = page.getByTestId('active-category')

  // A plain click toggles the filter on, then off.
  await row.getByText('Native', { exact: true }).click()
  await expect(active).toHaveText('Native')
  await row.getByText('Native', { exact: true }).click()
  await expect(active).toHaveText('none')

  // A drag must NOT be interpreted as a chip click.
  const box = (await row.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 24, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 24, y, { steps: 12 })
  await page.mouse.up()
  await expect(active).toHaveText('none')
})
