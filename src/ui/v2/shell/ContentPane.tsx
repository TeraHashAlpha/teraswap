'use client'

import { Skeleton, Surface } from '../primitives'

/** [feat/ui-v2-docs-legal] Placeholder for Docs/Terms/Privacy before their restyle lands. Skeleton blocks only — no copy. */
export function ContentPane() {
  return (
    <section aria-busy="true" data-content-pane="" className="mx-auto w-full max-w-[720px]">
      <Surface className="flex flex-col gap-4 p-5">
        <Skeleton height={28} width="40%" />
        <Skeleton height={16} />
        <Skeleton height={16} width="90%" />
        <Skeleton height={16} width="75%" />
      </Surface>
    </section>
  )
}
