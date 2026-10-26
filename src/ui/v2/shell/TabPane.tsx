'use client'

import { Panel, Skeleton } from '../primitives'
import type { V2TabId } from './tab-paths'

/** [ADR-025] Pane placeholder: pages land in B2+. Skeleton blocks only — no copy. */
export function TabPane({ tab }: { tab: V2TabId }) {
  return (
    <section aria-busy="true" data-tab-pane={tab} className="mx-auto w-full max-w-[540px]">
      <Panel overPhoto className="flex flex-col gap-4 p-5">
        <Skeleton height={20} width="40%" />
        <Skeleton height={72} />
        <Skeleton height={72} />
        <Skeleton height={46} />
      </Panel>
    </section>
  )
}
