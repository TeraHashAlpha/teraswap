/**
 * The link-preview card (Discord, Telegram, X read og:image / twitter:image): one static file, referenced twice in layout.tsx.
 * Chat apps cache a preview by URL, so the file name is versioned; scripts/og-image/build.mjs regenerates it.
 * Reads layout.tsx as text because importing it pulls in next/font, which only exists inside the Next build.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')
const IMAGE_URL = '/og-teraswap-v2.png'
const IMAGE_FILE = path.join(ROOT, 'public', IMAGE_URL)
const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8')
const EM_DASH = '—'

describe('link-preview image', () => {
  it('exists, is a 1200x630 PNG and stays under 300 KB', () => {
    const png = readFileSync(IMAGE_FILE)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR: width at byte 16, height at byte 20 (big endian)
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(statSync(IMAGE_FILE).size).toBeLessThan(300 * 1024)
  })

  it('is what both openGraph.images and twitter.images point to, and nothing points to the old card', () => {
    expect(layout.match(new RegExp(`['"]${IMAGE_URL}['"]`, 'g'))).toHaveLength(2)
    expect(layout).toMatch(/openGraph:[\s\S]*?images:\s*\[\s*\{\s*url:\s*'\/og-teraswap-v2\.png',\s*width:\s*1200,\s*height:\s*630,/)
    expect(layout).toMatch(/twitter:[\s\S]*?images:\s*\['\/og-teraswap-v2\.png'\]/)
    expect(layout).not.toContain('og-image.png')
  })

  it('has the owner-approved alt text, without an em dash', () => {
    const alt = layout.match(/alt:\s*'([^']*)'/)?.[1]
    expect(alt).toBe('TeraSwap: Compare. Verify. Swap. Repeat.')
    expect(alt).not.toContain(EM_DASH)
  })
})
