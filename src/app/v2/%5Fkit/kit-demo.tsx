'use client'

import '@/ui/v2/v2.css'
import { v2FontClassNames } from '@/ui/v2/font-loader'
import { EyebrowLabel, HandUnderline } from '@/ui/v2/primitives'
import { KitSheet } from '@/ui/v2/primitives/KitSheet'

/** Dev kit shell: the matrix itself lives in src/ui/v2/primitives/KitSheet.tsx (Round 7). */
export default function KitDemo() {
  return (
    <main data-ts-ui="v2-kit" className={`ts-v2 min-h-screen space-y-10 p-8 ${v2FontClassNames}`}>
      <h1 className="font-v2-display text-5xl font-bold uppercase">
        <HandUnderline>v2 kit</HandUnderline>
      </h1>
      <EyebrowLabel>Round 7 · no-box language</EyebrowLabel>
      <KitSheet />
    </main>
  )
}
