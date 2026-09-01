/**
 * layout.tsx's OG/meta description must carry the derived source count,
 * not a handwritten digit. Drives the shipped SITE_META_DESCRIPTION and
 * asserts layout.tsx actually imports it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
import { DISABLED_SOURCES } from '@/lib/constants'
import { INTEGRATED_DEX_SOURCE_COUNT, SITE_META_DESCRIPTION } from '@/config/product-claims'

const LAYOUT = path.resolve(__dirname, './layout.tsx')

describe('layout.tsx meta description', () => {
  const src = readFileSync(LAYOUT, 'utf8')

  it('imports SITE_META_DESCRIPTION from the claims module', () => {
    expect(src).toMatch(/from ['"]@\/config\/product-claims['"]/)
    expect(src).toMatch(/SITE_META_DESCRIPTION/)
    expect(src).toMatch(/SITE_DESCRIPTION\s*=\s*SITE_META_DESCRIPTION/)
  })

  it("meta-description count equals ADAPTER_REGISTRY.length minus DISABLED_SOURCES", () => {
    const quotingCount = ADAPTER_REGISTRY.filter((a) => !DISABLED_SOURCES[a.name]).length
    expect(INTEGRATED_DEX_SOURCE_COUNT).toBe(quotingCount)
    expect(SITE_META_DESCRIPTION).toContain(
      `queries ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources`,
    )
    expect(SITE_META_DESCRIPTION).toContain(
      `queries ${quotingCount} liquidity sources`,
    )
  })

  it('does not hard-code a source count next to "liquidity sources"', () => {
    expect(src).not.toMatch(/\b(?:\d+|ten|eleven|twelve)\s+liquidity sources\b/i)
  })
})
