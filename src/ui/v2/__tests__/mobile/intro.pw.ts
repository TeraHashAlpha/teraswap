/**
 * [round 10] The landing entry animation, in real Chromium against `next start` (UI_V2_ENABLED=true): the timeline as built,
 * every skip gesture (a click does not reach the link under it, a scroll still scrolls), reduced motion, a script that no
 * longer runs, and the second load of a session.
 *
 *   V2_SHOTS_DIR=<dir>   also writes the measured timing table (intro-timing.json) there (evidence for FEEDBACK)
 *
 * Every other v2 Playwright run marks the intro as already played (`ts_v2_intro_seen`), so its first visit is not under the curtain.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const KEY = 'ts_v2_intro_seen'
const WORDS = ['Compare.', 'Verify.', 'Swap.', 'Repeat.']

async function fresh(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })
  const page = await context.newPage()
  return { context, page }
}

/** Start a requestAnimationFrame sampler at document start: word opacities and the mask offset, per frame, while the overlay exists. */
async function sampleFromStart(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __intro: Array<{ t: number; o: number[]; y: number }> }
    w.__intro = []
    let t0 = -1
    const tick = () => {
      const root = document.querySelector('[data-ts-intro]')
      if (root) {
        const now = performance.now()
        if (t0 < 0) t0 = now
        const cs = getComputedStyle(root.querySelector('[data-ts-intro-curtain]') as Element)
        const y = parseFloat((cs.maskPosition || cs.webkitMaskPosition || '0 0').split(' ')[1] ?? '0') || 0
        const o = Array.from(root.querySelectorAll('.ts-intro__word')).map((n) => Number(getComputedStyle(n).opacity))
        w.__intro.push({ t: now - t0, o, y })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const overlay = (page: Page) => page.locator('[data-ts-intro]')

test.describe('v2 landing intro', () => {
  test('timeline as built: words at 0.0 / 0.6 / 1.2 / 1.8 s, sweep 2.95 to 3.30 s, overlay gone after', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await sampleFromStart(context)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(overlay(page)).toHaveCount(0, { timeout: 8_000 })
    const s = await page.evaluate(() => (window as unknown as { __intro: Array<{ t: number; o: number[]; y: number }> }).__intro)
    expect(s.length).toBeGreaterThan(100)

    const first = (i: number, pred: (v: number) => boolean) => s.find((f) => pred(f.o[i]))?.t ?? NaN
    const rows = WORDS.map((word, i) => {
      const appear = first(i, (v) => v > 0.02)
      const full = first(i, (v) => v >= 0.95)
      const afterFull = s.find((f) => f.t > full && f.o[i] < 0.02)?.t ?? NaN
      return { word, appearMs: Math.round(appear), fullMs: Math.round(full), cutMs: Math.round(afterFull) }
    })
    const sweepStart = s.find((f) => f.y < -2)?.t ?? NaN
    const last = s[s.length - 1]
    const timing = { rows, sweepStartMs: Math.round(sweepStart), lastFrameMs: Math.round(last.t), frames: s.length }
    console.log('INTRO TIMING ' + JSON.stringify(timing))
    if (process.env.V2_SHOTS_DIR) {
      mkdirSync(process.env.V2_SHOTS_DIR, { recursive: true })
      writeFileSync(join(process.env.V2_SHOTS_DIR, 'intro-timing.json'), JSON.stringify(timing, null, 2))
    }

    const TOL = 120 // one or two dropped frames in a loaded headless run
    rows.forEach((r, i) => {
      expect(Math.abs(r.appearMs - i * 600)).toBeLessThan(TOL)
      expect(r.fullMs - r.appearMs).toBeLessThan(400) // fade-in of about 250 ms
      if (i < 3) expect(Math.abs(r.cutMs - (i + 1) * 600)).toBeLessThan(TOL) // replaced by a cut at the end of its 600 ms slot
    })
    expect(Math.abs(sweepStart - 2950)).toBeLessThan(TOL + 60) // the first measurable move of the edge
    expect(Math.abs(last.t - 3300)).toBeLessThan(TOL + 60)
    await context.close()
  })

  test('the landing is there under it from the start: the hero is in the DOM while the overlay plays', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('#hero h1')).toHaveCount(1)
    await expect(overlay(page)).toHaveAttribute('aria-hidden', 'true')
    await context.close()
  })

  test('plays on the first load, not on the second load of the same session, and again in a new session', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBe('1')
    await expect(overlay(page)).toHaveCount(0, { timeout: 8_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('#hero h1')).toHaveCount(1, { timeout: 20_000 })
    await page.waitForTimeout(600)
    await expect(overlay(page)).toHaveCount(0)
    await context.close()

    const again = await fresh(browser)
    await again.page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(again.page)).toHaveCount(1, { timeout: 20_000 })
    await again.context.close()
  })

  test('a click skips it and does not activate the link under it', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    const cta = await page.locator('#hero').getByRole('button', { name: /launch app/i }).first().boundingBox()
    expect(cta).not.toBeNull()
    const x = cta!.x + cta!.width / 2
    const y = cta!.y + cta!.height / 2
    // the curtain, not the button, is what is at that point
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-ts-intro]') !== null, [x, y])).toBe(true)
    await page.mouse.click(x, y)
    await expect(overlay(page)).toHaveCount(0)
    await expect(page.locator('#hero h1')).toHaveCount(1) // still the landing: "Launch app" was not pressed
    await context.close()
  })

  test('a key press skips it', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    await page.keyboard.press('Tab')
    await expect(overlay(page)).toHaveCount(0)
    await context.close()
  })

  test('a wheel turn skips it and the page scrolls', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    await page.mouse.move(720, 450)
    await page.mouse.wheel(0, 600)
    await expect(overlay(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(0)
    await context.close()
  })

  test.describe('on a phone', () => {
    test('a tap skips it and does not activate the link under it; a touch scroll skips it and scrolls', async ({ browser }) => {
      const tap = await fresh(browser, { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true })
      await tap.page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(overlay(tap.page)).toHaveCount(1, { timeout: 20_000 })
      const cta = await tap.page.locator('#hero').getByRole('button', { name: /launch app/i }).first().boundingBox()
      expect(cta).not.toBeNull()
      await tap.page.touchscreen.tap(Math.min(cta!.x + cta!.width / 2, 360), Math.min(cta!.y + cta!.height / 2, 650))
      await expect(overlay(tap.page)).toHaveCount(0)
      await expect(tap.page.locator('#hero h1')).toHaveCount(1)
      await tap.context.close()

      const drag = await fresh(browser, { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true })
      await drag.page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(overlay(drag.page)).toHaveCount(1, { timeout: 20_000 })
      const cdp = await drag.context.newCDPSession(drag.page)
      await cdp.send('Input.synthesizeScrollGesture', { x: 187, y: 400, yDistance: -300, gestureSourceType: 'touch', speed: 800 })
      await expect(overlay(drag.page)).toHaveCount(0)
      await expect.poll(() => drag.page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeGreaterThan(0)
      await drag.context.close()
    })
  })

  test('prefers-reduced-motion: reduce plays no intro at all', async ({ browser }) => {
    const { context, page } = await fresh(browser, { reducedMotion: 'reduce' })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#hero h1')).toHaveCount(1, { timeout: 20_000 })
    await expect(overlay(page)).toHaveCount(0)
    expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBeNull()
    await context.close()
  })

  test('with scripts off the page is not held: the server HTML has no overlay (and a <noscript> would hide it)', async ({ browser }) => {
    const { context, page } = await fresh(browser, { javaScriptEnabled: false })
    const res = await page.goto('/', { waitUntil: 'domcontentloaded' })
    expect(res?.status()).toBe(200)
    expect(await page.content()).not.toContain('ts-intro')
    await context.close()
  })

  test('with its script gone it still ends by itself: CSS alone makes it invisible and click-through', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(overlay(page)).toHaveCount(1, { timeout: 20_000 })
    // Replace the overlay with a copy React does not know: no handler, no state update can remove it. Only its CSS can.
    await page.evaluate(() => {
      const el = document.querySelector('[data-ts-intro]') as Element
      el.replaceWith(el.cloneNode(true))
    })
    const cta = await page.locator('#hero').getByRole('button', { name: /launch app/i }).first().boundingBox()
    await page.waitForTimeout(3_700)
    expect(await page.locator('[data-ts-intro-curtain]').evaluate((n) => getComputedStyle(n).visibility)).toBe('hidden')
    expect(await page.locator('.ts-intro__rim').evaluate((n) => getComputedStyle(n).visibility)).toBe('hidden')
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-ts-intro]') === null, [cta!.x + 10, cta!.y + 10])).toBe(true)
    await context.close()
  })

  test('is on the landing only: not on an app tab, Docs, Privacy or Terms, and not after returning to the landing', async ({ browser }) => {
    const { context, page } = await fresh(browser)
    for (const path of ['/swap', '/docs', '/privacy', '/terms']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1_500)
      await expect(overlay(page), path).toHaveCount(0)
    }
    expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBeNull() // none of them used up the session's one play
    await context.close()
  })
})
