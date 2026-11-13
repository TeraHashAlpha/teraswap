/**
 * [ADR-025 / feat/ui-v2-mobile-parity] v2 at 375: one real-Chromium gate per route (landing + the 8 tabs, Limit/SL-TP included — they are
 * "Soon" shells), against `next start` with the network and the wallet mocked (rig.ts).
 *
 *   overflow     the page never scrolls sideways at 375 (documentElement.scrollWidth <= viewport) and no element pokes out of the viewport
 *                unless a clipping/scrolling ancestor owns it (the tab strip scrolls by design)
 *   tap targets  every button / tab / input / select / switch / non-inline link is >= 44 px on its short side (inline links inside running
 *                text are the WCAG 2.5.8 exception and are reported, not failed)
 *   sticky CTA   Swap and DCA (frames m02 / m04): the CTA is pinned to the bottom of the viewport while the form scrolls
 *   bottom sheet the token sheet, the review sheet and the wallet modal sit on the foot of the screen, full width (m03 / m08)
 *   credits      a photo credit lives in the footer band only (m09), never loose in the page
 *   motion       with prefers-reduced-motion: reduce nothing animates forever and no transition outlasts a blink
 *
 * `V2_SHOTS_DIR=<dir>` also writes the 375 and 1440 screenshot of every route there (evidence for FEEDBACK).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { installNetwork, installWallet, type Scenario } from './rig'

const ORIGIN = process.env.V2_BASE_URL ?? 'http://127.0.0.1:3917'
const SHOTS = process.env.V2_SHOTS_DIR
const M = { width: 375, height: 812 }
const D = { width: 1440, height: 900 }

interface Route {
  id: string
  path: string
  s: Scenario
  /** put the page in its widest realistic state (an amount typed, a list loaded) */
  prepare?: (page: Page) => Promise<void>
}

const typeAmount = (value: string) => async (page: Page) => {
  await page.locator('input[inputmode="decimal"]').first().fill(value)
  await page.waitForTimeout(1_500) // the quote (mocked) lands
}

const ROUTES: Route[] = [
  { id: 'landing', path: '/', s: { chainId: 1, connected: false } },
  { id: 'swap', path: '/swap', s: { chainId: 1, connected: true }, prepare: typeAmount('0.001') },
  { id: 'portfolio', path: '/portfolio', s: { chainId: 1, connected: true } },
  { id: 'dca', path: '/dca', s: { chainId: 8453, connected: true }, prepare: typeAmount('0.0006') },
  { id: 'dca-gate', path: '/dca', s: { chainId: 1, connected: true } },
  { id: 'limit', path: '/limit', s: { chainId: 8453, connected: true } },
  { id: 'sltp', path: '/sltp', s: { chainId: 8453, connected: true } },
  { id: 'orders', path: '/orders', s: { chainId: 8453, connected: true } },
  { id: 'history', path: '/history', s: { chainId: 8453, connected: true } },
  { id: 'analytics', path: '/analytics', s: { chainId: 1, connected: true } },
  // [feat/ui-v2-docs-legal] not app tabs (no wallet needed): same gates (overflow, tap targets, screenshots) apply.
  { id: 'docs', path: '/docs', s: { chainId: 1, connected: false } },
  { id: 'terms', path: '/terms', s: { chainId: 1, connected: false } },
  { id: 'privacy', path: '/privacy', s: { chainId: 1, connected: false } },
]

async function open(page: Page, r: Route, viewport: { width: number; height: number }, reduced = false) {
  await page.setViewportSize(viewport)
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
  if (process.env.V2_DEBUG) {
    page.on('pageerror', (e) => console.log(`[${r.id} pageerror] ${e.message.slice(0, 300)}`))
    page.on('console', (m) => m.type() === 'error' && console.log(`[${r.id} console.error] ${m.text().slice(0, 300)}`))
  }
  // [round 10] The landing's entry animation (3.3 s, once per session) would cover every first visit: mark it played here.
  // Its own proofs are in intro.pw.ts.
  await page.context().addInitScript(() => {
    try {
      sessionStorage.setItem('ts_v2_intro_seen', '1')
    } catch {}
  })
  await installWallet(page.context(), r.s)
  await installNetwork(page, ORIGIN, r.s)
  await page.goto(r.path, { waitUntil: 'load' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1_200)
  if (process.env.V2_DEBUG) await page.screenshot({ path: join(process.env.V2_DEBUG, `${r.id}-${viewport.width}.png`) })
  if (r.prepare) await r.prepare(page)
  if (process.env.V2_DEBUG && r.prepare) {
    await page.screenshot({ path: join(process.env.V2_DEBUG, `${r.id}-${viewport.width}-prepared.png`) })
    console.log(`[${r.id}] cta=${await page.locator('[data-cta]').first().getAttribute('data-cta')} checkboxes=${JSON.stringify(await page.getByRole('checkbox').allInnerTexts())}`)
  }
}

/** The page's sideways reach, and the elements that poke out of the viewport without a clipping ancestor. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const clipped = (el: Element) => {
      for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) if (getComputedStyle(n).overflowX !== 'visible') return true
      return false
    }
    const out: string[] = []
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') continue
      if ((r.right > vw + 0.5 || r.left < -0.5) && !clipped(el)) out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : ''} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent ?? '').trim().slice(0, 30)}"`)
    }
    return { vw, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, pokes: out.slice(0, 10), pokeCount: out.length }
  })

/** Interactive elements whose short side is under 44 px. Inline links in running text are returned apart (WCAG 2.5.8 inline exception). */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const sel = 'button, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], input:not([type="hidden"]), select, summary, a[href]'
    const small: string[] = []
    const inline: string[] = []
    for (const el0 of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      // a native checkbox / radio is tapped through its <label> (the whole row is the target)
      const el = (el0 instanceof HTMLInputElement && (el0.type === 'checkbox' || el0.type === 'radio') && el0.closest('label')) || el0
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[aria-hidden="true"]')) continue
      if (Math.min(r.width, r.height) >= 43.5) continue
      const label = `${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)}"`
      const isLink = el.tagName === 'A'
      const inText = isLink && cs.display === 'inline' && !!el.parentElement && Array.from(el.parentElement.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 3)
      ;(inText ? inline : small).push(label)
    }
    return { small, inline }
  })

test.describe('the detectors themselves (so a green run means something)', () => {
  test('the overflow check fails a box wider than the viewport, and lets a scroller own its overflow', async ({ page }) => {
    await page.setViewportSize(M)
    await page.setContent('<body style="margin:0"><div style="width:400px;height:20px">wide</div></body>')
    const bad = await overflow(page)
    expect(bad.docWidth).toBeGreaterThan(bad.vw)
    expect(bad.pokes.length).toBeGreaterThan(0)
    await page.setContent('<body style="margin:0"><div style="overflow-x:auto;width:375px"><div style="width:900px;height:20px">strip</div></div></body>')
    const ok = await overflow(page)
    expect(ok.docWidth).toBeLessThanOrEqual(ok.vw)
    expect(ok.pokes).toEqual([])
  })

  test('the tap-target check fails a 30 px button and a 20 px link, and exempts a link inside a sentence', async ({ page }) => {
    await page.setViewportSize(M)
    await page.setContent('<body><button style="width:30px;height:30px">x</button> <a href="#" style="display:block;height:20px">go</a><p>read the <a href="#">docs</a> for more</p></body>')
    const t = await smallTargets(page)
    expect(t.small.length).toBe(2)
    expect(t.inline.length).toBe(1)
  })
})

for (const r of ROUTES) {
  test.describe(`375 · ${r.id}`, () => {
    test('no horizontal overflow', async ({ page }) => {
      await open(page, r, M)
      const o = await overflow(page)
      expect(o.docWidth, `documentElement.scrollWidth ${o.docWidth} vs viewport ${o.vw}`).toBeLessThanOrEqual(o.vw)
      expect(o.bodyWidth, `body.scrollWidth ${o.bodyWidth} vs viewport ${o.vw}`).toBeLessThanOrEqual(o.vw)
      expect(o.pokes, `${o.pokeCount} element(s) outside the viewport with no clipping ancestor`).toEqual([])
    })

    test('tap targets are at least 44 px', async ({ page }) => {
      await open(page, r, M)
      const t = await smallTargets(page)
      if (t.inline.length) console.log(`[375 ${r.id}] inline links (WCAG 2.5.8 exception): ${t.inline.join(' | ')}`)
      expect(t.small, 'interactive elements under 44 px').toEqual([])
    })

    test('reduced motion: nothing animates forever, no transition outlasts a blink', async ({ page }) => {
      await open(page, r, M, true)
      const m = await page.evaluate(() => {
        const running = document.getAnimations().filter((a) => {
          const t = a.effect?.getComputedTiming()
          return a.playState === 'running' && (t?.iterations === Infinity || Number(t?.duration) > 100)
        })
        const long: string[] = []
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (el.getClientRects().length === 0) continue // not rendered (v1's own ♫ is display:none under v2)
          const cs = getComputedStyle(el)
          const dur = cs.transitionDuration.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000))
          if (dur.some((d) => d > 100) && cs.transitionProperty !== 'none') long.push(`${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/)[0]} ${cs.transitionDuration}`)
        }
        for (const fab of Array.from(document.querySelectorAll('[data-ts-fab]'))) if (parseFloat(getComputedStyle(fab).transitionDuration) > 0.0001) long.push(`fab ${getComputedStyle(fab).transitionDuration}`)
        return { running: running.map((a) => `${(a as CSSAnimation).animationName ?? a.id} ${String(a.effect?.getComputedTiming().duration)}`), long: long.slice(0, 8) }
      })
      expect(m.running, 'running animations').toEqual([])
      expect(m.long, 'transitions longer than 100 ms').toEqual([])
    })

    test('screenshots 375 + 1440', async ({ page }) => {
      test.skip(!SHOTS, 'set V2_SHOTS_DIR to write them')
      mkdirSync(SHOTS as string, { recursive: true })
      await open(page, r, M)
      await page.screenshot({ path: join(SHOTS as string, `${r.id}-375.jpg`), quality: 72 })
      await open(page, r, D)
      await page.screenshot({ path: join(SHOTS as string, `${r.id}-1440.jpg`), quality: 72 })
    })
  })
}

test.describe('375 · sticky CTA (frames m02 / m04)', () => {
  for (const r of ROUTES.filter((x) => x.id === 'swap' || x.id === 'dca')) {
    test(`${r.id}: the CTA stays in the viewport while the form scrolls`, async ({ page }) => {
      await open(page, r, M)
      const cta = page.locator('[data-cta]').first()
      await expect(cta).toBeVisible()
      for (const y of [0, 400, 100_000]) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        await page.waitForTimeout(150)
        const box = (await cta.boundingBox())!
        expect(box.y + box.height, `CTA bottom at scrollY=${y}`).toBeLessThanOrEqual(M.height + 0.5)
        expect(box.y, `CTA top at scrollY=${y}`).toBeGreaterThanOrEqual(0)
      }
    })
  }
})

test.describe('375 · bottom sheets (frames m03 / m08)', () => {
  const sheetGeometry = async (page: Page) => {
    const dlg = page.getByRole('dialog').first()
    await expect(dlg).toBeVisible()
    const box = (await dlg.boundingBox())!
    return { left: box.x, right: box.x + box.width, bottom: box.y + box.height, vh: page.viewportSize()!.height }
  }

  test('token sheet: on the foot of the screen, full width', async ({ page }) => {
    await open(page, ROUTES[1], M)
    await page.locator('.ts-swap-token').first().click()
    const g = await sheetGeometry(page)
    expect(g.left).toBeLessThanOrEqual(0.5)
    expect(g.right).toBeGreaterThanOrEqual(M.width - 0.5)
    expect(g.bottom).toBeGreaterThanOrEqual(g.vh - 1)
  })

  test('review sheet: on the foot of the screen, full width', async ({ page }) => {
    await open(page, ROUTES[1], M)
    await page.locator('[data-cta="review"]').first().click()
    const g = await sheetGeometry(page)
    expect(g.left).toBeLessThanOrEqual(0.5)
    expect(g.right).toBeGreaterThanOrEqual(M.width - 0.5)
    expect(g.bottom).toBeGreaterThanOrEqual(g.vh - 1)
  })

  test('wallet modal: a sheet on the foot of the screen', async ({ page }) => {
    await open(page, { id: 'swap-out', path: '/swap', s: { chainId: 1, connected: false } }, M)
    await page.getByRole('button', { name: /^connect/i }).first().click()
    const g = await sheetGeometry(page)
    expect(g.bottom).toBeGreaterThanOrEqual(g.vh - 1)
    expect(g.right - g.left).toBeGreaterThanOrEqual(M.width - 2)
  })
})

test.describe('help drawer geometry (S-3, A75b)', () => {
  // v1 / round 7 item 7: a right-edge drawer with a left hairline at >= 1024, a bottom sheet only below.
  const helpBox = async (page: Page, viewport: { width: number; height: number }) => {
    await open(page, ROUTES[1], viewport)
    await page.getByRole('button', { name: 'Open help' }).click()
    const dlg = page.getByRole('dialog', { name: 'How can we help?' })
    await expect(dlg).toBeVisible()
    const box = (await dlg.boundingBox())!
    return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, vw: viewport.width, vh: viewport.height }
  }

  for (const width of [1024, 1440]) {
    test(`${width}: flush to the right edge, full height, 420 px wide`, async ({ page }) => {
      const g = await helpBox(page, { width, height: 900 })
      expect(g.right, 'right edge').toBeGreaterThanOrEqual(g.vw - 0.5)
      expect(g.top, 'top').toBeLessThanOrEqual(0.5)
      expect(g.bottom, 'bottom').toBeGreaterThanOrEqual(g.vh - 0.5)
      expect(g.width, 'width').toBeLessThanOrEqual(420.5)
      expect(g.left, 'left').toBeGreaterThan(0)
    })
  }

  for (const width of [375, 768, 1023]) {
    test(`${width}: a bottom sheet, full width`, async ({ page }) => {
      const g = await helpBox(page, { width, height: 812 })
      expect(g.left, 'left').toBeLessThanOrEqual(0.5)
      expect(g.right, 'right').toBeGreaterThanOrEqual(g.vw - 0.5)
      expect(g.bottom, 'bottom').toBeGreaterThanOrEqual(g.vh - 1)
      expect(g.top, 'not full height').toBeGreaterThan(0)
    })
  }
})

test.describe('375 · photo credits live in the footer band only (frame m09)', () => {
  for (const r of ROUTES) {
    test(r.id, async ({ page }) => {
      await open(page, r, M)
      const loose = await page.evaluate(() => {
        const out: string[] = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!/pexels/i.test(n.textContent ?? '')) continue
          const el = n.parentElement
          if (el && !el.closest('footer, [data-ts-footer]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') out.push((n.textContent ?? '').trim().slice(0, 50))
        }
        return out
      })
      expect(loose, 'credit text outside the footer').toEqual([])
    })
  }
})
