'use client'

import { useRouter } from 'next/navigation'
import { useQuoteChainId } from '@/hooks/useChainId'
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

  function onSelect(id: string) {
    const tab = V2_TABS.find((t) => t.id === id)
    if (tab) router.push(tab.path)
  }

  return (
    <nav aria-label="App sections" className="px-4 pt-4 sm:px-8">
      <Tabs tabs={tabs} active={active} onSelect={onSelect} label="App sections" className="gap-8" />
    </nav>
  )
}
