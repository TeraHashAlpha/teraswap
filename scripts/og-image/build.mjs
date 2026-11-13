#!/usr/bin/env node
/**
 * Regenerates public/og-teraswap-v2.png, the link-preview card (Open Graph + Twitter).
 *
 *   node scripts/og-image/build.mjs
 *
 * What it draws: the dark v2 background with the entry animation's dot grid, the wordmark "TERASWAP", and the four words
 * "Compare. Verify. Swap. Repeat." under it, in the v2 display face (Barlow Condensed Bold) and the cream token.
 * Nothing else: no count, no chain, no claim.
 *
 * Offline and dependency-free: the colours are read from src/ui/v2/tokens.css (--bg, --cream), the font is the repo's own
 * woff2 inlined as a data URI, and the browser is the repo's Playwright Chromium. It throws if the text leaves the 80 px
 * safe area on any side, so a font or size change cannot silently push a word to the edge.
 *
 * Cache note: chat apps cache a preview by URL. Change the file name (og-teraswap-v2 -> og-teraswap-v3) whenever the
 * image changes, and update src/app/layout.tsx and src/app/layout.og-image.test.ts with it.
 */
import { copyFileSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT = path.join(ROOT, 'public', 'og-teraswap-v2.png')
// The old card's URL (/og-image.png) is still cached by chat apps and may be linked from elsewhere: it serves the same new card.
export const LEGACY_OUT = path.join(ROOT, 'public', 'og-image.png')
export const SIZE = { width: 1200, height: 630 }
export const SAFE = 80
export const WORDMARK = 'TERASWAP'
export const WORDS = ['Compare.', 'Verify.', 'Swap.', 'Repeat.']
export const MAX_BYTES = 300 * 1024

const token = (css, name) => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!m) throw new Error(`token --${name} not found in tokens.css`)
  return m[1]
}

const tokensCss = readFileSync(path.join(ROOT, 'src/ui/v2/tokens.css'), 'utf8')
const BG = token(tokensCss, 'bg')
const CREAM = token(tokensCss, 'cream')
const FONT = readFileSync(path.join(ROOT, 'src/ui/v2/fonts/latin/BarlowCondensed-Bold.latin.woff2')).toString('base64')

// The dot grid is intro.css's: 16 px pitch, rows 16 px apart, every other row shifted 8 px, cream at 5 % alpha.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "OgDisplay"; font-weight: 700; src: url(data:font/woff2;base64,${FONT}) format("woff2"); }
html, body { margin: 0; width: ${SIZE.width}px; height: ${SIZE.height}px; }
body {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background-color: ${BG};
  background-image:
    radial-gradient(circle at 4px 12px, rgba(234, 223, 182, 0.05) 1.5px, transparent 2px),
    radial-gradient(circle at 12px 28px, rgba(234, 223, 182, 0.05) 1.5px, transparent 2px);
  background-size: 16px 32px;
  color: ${CREAM}; font-family: "OgDisplay", sans-serif; font-weight: 700; line-height: 1; letter-spacing: -0.01em;
}
#wordmark { font-size: 230px; margin: 0 0 34px; white-space: nowrap; }
#words { font-size: 78px; white-space: nowrap; margin: 0; }
</style></head><body>
<div id="wordmark">${WORDMARK}</div>
<div id="words">${WORDS.join(' ')}</div>
</body></html>`

export async function build() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 })
    await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()))
    await page.setContent(html)
    await page.evaluate(() => document.fonts.ready)
    const loaded = await page.evaluate(() => document.fonts.check('700 100px OgDisplay'))
    if (!loaded) throw new Error('the display face did not load; refusing to render a fallback font')
    const boxes = await page.evaluate(() =>
      ['wordmark', 'words'].map((id) => {
        const r = document.createRange()
        r.selectNodeContents(document.getElementById(id))
        const b = r.getBoundingClientRect()
        return { id, left: b.left, top: b.top, right: b.right, bottom: b.bottom }
      }),
    )
    for (const b of boxes) {
      if (b.left < SAFE || b.top < SAFE || SIZE.width - b.right < SAFE || SIZE.height - b.bottom < SAFE) {
        throw new Error(`#${b.id} leaves the ${SAFE}px safe area: ${JSON.stringify(b)}`)
      }
    }
    await page.screenshot({ path: OUT, type: 'png' })
    copyFileSync(OUT, LEGACY_OUT)
    const bytes = statSync(OUT).size
    if (bytes > MAX_BYTES) throw new Error(`${OUT} is ${bytes} B, over the ${MAX_BYTES} B limit`)
    return { out: OUT, bytes, boxes }
  } finally {
    await browser.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().then(
    (r) => console.log(`wrote ${path.relative(ROOT, r.out)} (${r.bytes} B)\n${r.boxes.map((b) => `  #${b.id}: ${JSON.stringify(b)}`).join('\n')}`),
    (e) => {
      console.error(e.message)
      process.exit(1)
    },
  )
}
