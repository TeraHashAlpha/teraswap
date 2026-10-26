'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuoteChainId } from '@/hooks/useChainId'
import { playTouchMP3 } from '@/lib/sounds'
import { isLimitLive } from '@/lib/order-engine'
import { Tabs, type TabItem } from '../primitives'
import { V2_TABS, type V2TabId } from './tab-paths'

/**
 * [ADR-025] Tab strip (pack 01): Swap · Portfolio · DCA · Limit · SL/TP · Orders · History · Analytics.
 * "Soon" lives ONLY on Limit and SL/TP, and only while `isLimitLive` (v1's gate) is false; DCA is never "Soon"
 * (the DCA pane explains where it runs). Selecting a tab navigates to its path (proxy rewrites it under the gate).
 */
export function TabBar({ active }: { active: V2TabId }) {
  const router = useRouter()
  const chainId = useQuoteChainId()
  const limitLive = isLimitLive(chainId)

  const tabs: TabItem[] = V2_TABS.map((t) => {
    const soon = (t.id === 'limit' || t.id === 'sltp') && !limitLive
    return { id: t.id, label: t.label, disabled: soon, badge: soon ? 'Soon' : undefined }
  })

  // [mobile] The strip scrolls horizontally; edge fades + chevrons show which side has more, and the active tab is
  // kept in view (pack m02–m07 / round-3 B7).
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [measure])

  useEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-tab-id="${active}"]`)
    if (!el || typeof el.scrollIntoView !== 'function') return
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [active])

  function onSelect(id: string) {
    const tab = V2_TABS.find((t) => t.id === id)
    if (!tab) return
    playTouchMP3() // v1: ModeTabs onSelect → playTouchMP3()
    router.push(tab.path)
  }

  return (
    <nav aria-label="App sections" className="relative px-4 pt-4 sm:px-8">
      <div
        ref={scrollerRef}
        data-tab-scroller=""
        data-edge-left={edges.left}
        data-edge-right={edges.right}
        className="ts-v2-tabscroll overflow-x-auto"
      >
        <Tabs tabs={tabs} active={active} onSelect={onSelect} label="App sections" className="min-w-max gap-8" />
      </div>
      {edges.left ? (
        <span aria-hidden="true" data-tab-chevron="left" className="ts-v2-tabchevron left-4 sm:left-8">
          ‹
        </span>
      ) : null}
      {edges.right ? (
        <span aria-hidden="true" data-tab-chevron="right" className="ts-v2-tabchevron right-4 sm:right-8">
          ›
        </span>
      ) : null}
    </nav>
  )
}
