// @vitest-environment jsdom
/**
 * [SPRINT-9F / CHORE-2026-09-03] SourceToggle — the "Liquidity Sources"
 * selector must list every real, quoting aggregator the engine queries, and
 * must never offer a source that DISABLED_SOURCES says can't quote (toggling
 * it would do nothing). TOGGLEABLE_SOURCES is derived as
 * ADAPTER_REGISTRY minus DISABLED_SOURCES — never a hand-kept exclusion set,
 * so a newly disabled source (openocean/bebop, INC-2026-09-03-001) drops out
 * automatically and a newly re-enabled one reappears automatically.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
import { AGGREGATOR_META, DISABLED_SOURCES, type AggregatorName } from '@/lib/constants'
import SourceToggle, { TOGGLEABLE_SOURCES } from './SourceToggle'

describe('SourceToggle — list completeness [CHORE-2026-09-03]', () => {
  it('never silently diverges from ADAPTER_REGISTRY minus DISABLED_SOURCES', () => {
    const registryNames = ADAPTER_REGISTRY.map(a => a.name)
    const expectedToggleable = registryNames.filter(name => !DISABLED_SOURCES[name])

    expect(TOGGLEABLE_SOURCES.sort()).toEqual(expectedToggleable.sort())
  })

  it('contains no DISABLED_SOURCES key (negative control: a fake disabled entry disappears from the toggle)', () => {
    for (const name of Object.keys(DISABLED_SOURCES)) {
      expect(TOGGLEABLE_SOURCES).not.toContain(name)
    }

    // Negative control: an adapter that IS in the registry but is NOT
    // disabled must still be toggleable — proving the filter is keyed off
    // DISABLED_SOURCES membership, not some other exclusion.
    const stillEnabled = ADAPTER_REGISTRY.map(a => a.name).find(
      (name) => !DISABLED_SOURCES[name]
    ) as AggregatorName
    expect(TOGGLEABLE_SOURCES).toContain(stillEnabled)
  })

  it('lists exactly the ADAPTER_REGISTRY sources not in DISABLED_SOURCES (no alias/pseudo-source)', () => {
    const expectedCount = ADAPTER_REGISTRY.filter(a => !DISABLED_SOURCES[a.name]).length
    expect(TOGGLEABLE_SOURCES).toHaveLength(expectedCount)
    // `uniswap` is a legacy alias of `uniswapv3` in AGGREGATOR_META — must not
    // appear or "Uniswap V3" would render twice.
    expect(TOGGLEABLE_SOURCES).not.toContain('uniswap')
    // Internal engine pseudo-source must never be user-toggleable.
    expect(TOGGLEABLE_SOURCES).not.toContain('teraswap_order_engine')
    // Odos ceased operations 2026-07-30 — permanently disabled, never quotes.
    expect(TOGGLEABLE_SOURCES).not.toContain('odos')
    // openocean/bebop — disabled 2026-09-03 (INC-2026-09-03-001), never quoted.
    expect(TOGGLEABLE_SOURCES).not.toContain('openocean')
    expect(TOGGLEABLE_SOURCES).not.toContain('bebop')
  })
})

describe('SourceToggle — render + toggle [CHORE-2026-09-03]', () => {
  it('renders a still-enabled source row and toggling it calls onToggle', () => {
    const onToggle = vi.fn()
    const target = TOGGLEABLE_SOURCES[0]
    const targetLabel = AGGREGATOR_META[target].label
    renderWithProviders(<SourceToggle excludedSources={new Set()} onToggle={onToggle} />)
    fireEvent.click(screen.getByText(new RegExp(`/${TOGGLEABLE_SOURCES.length} sources`)))
    const row = screen.getByText(targetLabel).closest('button')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(onToggle).toHaveBeenCalledWith(target)
  })

  it('counts an excluded source as disabled in the "N/total sources" label', () => {
    const excluded = new Set([TOGGLEABLE_SOURCES[0]])
    renderWithProviders(<SourceToggle excludedSources={excluded} onToggle={vi.fn()} />)
    expect(
      screen.getByText(`${TOGGLEABLE_SOURCES.length - 1}/${TOGGLEABLE_SOURCES.length} sources`)
    ).toBeInTheDocument()
  })
})
