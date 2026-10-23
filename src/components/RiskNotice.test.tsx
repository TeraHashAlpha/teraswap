// @vitest-environment jsdom
/**
 * Beta/experimental wording is out of the UI; one neutral risk line lives in the Footer.
 * (BetaBanner / BetaDisclaimer stay on disk, @deprecated and unused — CLAUDE.md rule #4.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
// @ts-expect-error — test-only global stub
globalThis.IntersectionObserver = IntersectionObserverStub

vi.mock('wagmi', () => ({ useBlockNumber: () => ({ data: 1n }) }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1 }))
vi.mock('@/hooks/useQuote', () => ({
  useQuote: () => ({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))

import { render } from '@/test-utils/render'
import Footer, { FOOTER_RISK_LINE } from './Footer'
import DocsPage from './DocsPage'
import LandingPage from './LandingPage'
import LandingBelowFold from './LandingBelowFold'

const BAD = /beta|experimental/i
const DEPRECATED = new Set(['BetaBanner.tsx', 'BetaDisclaimer.tsx'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !DEPRECATED.has(name)) out.push(full)
  }
  return out
}

describe('no beta / experimental wording in the UI', () => {
  it('no non-test source under src/components or src/app mentions it (deprecated files excluded)', () => {
    const hits = [...walk(join(process.cwd(), 'src/components')), ...walk(join(process.cwd(), 'src/app'))]
      .filter((f) => BAD.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('nothing imports the deprecated Beta* components', () => {
    const importers = [...walk(join(process.cwd(), 'src/components')), ...walk(join(process.cwd(), 'src/app'))]
      .filter((f) => /from ['"][^'"]*Beta(Banner|Disclaimer)['"]/.test(readFileSync(f, 'utf8')))
    expect(importers).toEqual([])
  })

  it('keeps the deprecated files, marked @deprecated (rule #4)', () => {
    for (const f of DEPRECATED) {
      expect(readFileSync(join(process.cwd(), 'src/components', f), 'utf8')).toContain('@deprecated')
    }
  })

  it.each([
    ['Footer', () => <Footer />],
    ['DocsPage', () => <DocsPage />],
    ['LandingPage', () => <LandingPage onLaunchApp={() => {}} />],
    ['LandingBelowFold', () => <LandingBelowFold onLaunchApp={() => {}} />],
  ])('%s renders no beta/experimental text', (_name, ui) => {
    const { container } = render(ui())
    expect(container.textContent).not.toMatch(BAD)
  })
})

describe('Footer risk line', () => {
  it('renders the line verbatim, exactly once', () => {
    const { container } = render(<Footer />)
    expect(FOOTER_RISK_LINE).toBe('Smart contracts have not been externally audited. Use at your own risk.')
    const text = container.textContent ?? ''
    expect(text.split(FOOTER_RISK_LINE).length - 1).toBe(1)
  })
})
