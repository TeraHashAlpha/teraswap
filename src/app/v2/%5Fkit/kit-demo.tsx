'use client'

import { useState } from 'react'
import '@/ui/v2/v2.css'
import { v2FontClassNames } from '@/ui/v2/font-loader'
import { Button, EyebrowLabel, HandUnderline, Panel, Skeleton, Tabs } from '@/ui/v2/primitives'

const TABS = [
  { id: 'a', label: 'Tab A' },
  { id: 'b', label: 'Tab B' },
  { id: 'c', label: 'Tab C', disabled: true, badge: 'badge' },
]

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <EyebrowLabel>{title}</EyebrowLabel>
      <div className="flex flex-wrap items-center gap-4">{children}</div>
    </section>
  )
}

/** Dev kit: every v2 primitive in every state. Developer labels only — no product copy. */
export default function KitDemo() {
  const [active, setActive] = useState('a')
  return (
    <main data-ts-ui="v2-kit" className={`ts-v2 min-h-screen space-y-10 p-8 ${v2FontClassNames}`}>
      <h1 className="font-v2-display text-5xl font-bold uppercase">
        <HandUnderline>v2 kit</HandUnderline>
      </h1>

      <Row title="Panel">
        <Panel className="w-64 p-5">default</Panel>
        <Panel overPhoto className="w-64 p-5">over photo (95%)</Panel>
      </Row>

      <Row title="Button">
        <Button variant="primary">primary</Button>
        <Button variant="secondary">secondary</Button>
        <Button variant="primary" disabled>primary disabled</Button>
        <Button variant="secondary" disabled>secondary disabled</Button>
      </Row>

      <Row title="Tabs">
        <Tabs tabs={TABS} active={active} onSelect={setActive} label="kit tabs" />
      </Row>

      <Row title="EyebrowLabel + HandUnderline">
        <EyebrowLabel>eyebrow label</EyebrowLabel>
        <span className="font-v2-display text-3xl font-bold uppercase"><HandUnderline>hand underline</HandUnderline></span>
      </Row>

      <Row title="Skeleton">
        <Skeleton width={260} height={14} />
        <Skeleton width={180} height={14} />
        <Skeleton width={72} height={48} />
      </Row>
    </main>
  )
}
