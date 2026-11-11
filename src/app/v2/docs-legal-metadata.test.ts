/**
 * [feat/ui-v2-docs-legal] Each v2 layout re-exports its v1 counterpart's `metadata` (not a retyped copy), so
 * title/description can never drift between the two versions of the same URL.
 */
import { describe, expect, it } from 'vitest'
import { metadata as v1Docs } from '@/app/docs/layout'
import { metadata as v1Terms } from '@/app/terms/layout'
import { metadata as v1Privacy } from '@/app/privacy/layout'
import { metadata as v2Docs } from './docs/layout'
import { metadata as v2Terms } from './terms/layout'
import { metadata as v2Privacy } from './privacy/layout'

describe('v2 docs/terms/privacy metadata equals v1', () => {
  it.each([
    ['docs', v1Docs, v2Docs],
    ['terms', v1Terms, v2Terms],
    ['privacy', v1Privacy, v2Privacy],
  ])('%s: same title and description object (re-exported, not retyped)', (_label, v1, v2) => {
    expect(v2).toBe(v1)
    expect(v2).toMatchObject({ title: expect.stringContaining('TeraSwap'), description: expect.any(String) })
  })
})
