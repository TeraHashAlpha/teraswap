'use client'

import { useState, type ReactNode } from 'react'
import { Button, Chip, EyebrowLabel, HandUnderline, Input, Panel, Segmented, Skeleton, Surface, Tabs, Toggle } from './index'

/**
 * Dev kit body (rendered by the gated /v2/_kit page): every Round 7 primitive in every variant and state. Developer labels
 * only — no product copy. Each cell carries `data-kit-cell="<Primitive>/<variant>/<state>"`; primitives.test pins the list.
 * `:focus-visible` cannot be forced from markup — tab into any control to see it.
 */
const TABS = [
  { id: 'a', label: 'Tab A' },
  { id: 'b', label: 'Tab B' },
  { id: 'c', label: 'Tab C', disabled: true, badge: 'soon' },
]

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <EyebrowLabel>{title}</EyebrowLabel>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-5">{children}</div>
    </section>
  )
}

/** One matrix cell: a small mono caption (the cell id) over the live primitive. */
function Cell({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-kit-cell={id} className="flex min-w-[8rem] flex-col gap-2">
      <span className="font-v2-mono text-[10px] uppercase tracking-[1px] text-v2-dim">{id}</span>
      {children}
    </div>
  )
}

/** The brightest photo pixel the grading can produce (plates.test.ts model) — a stand-in "photo" for the scrim swatches. */
const WORST_PHOTO = 'rgb(69, 67, 57)'

export function KitSheet() {
  const [tab, setTab] = useState('a')
  const [seg, setSeg] = useState('a')
  const [chip, setChip] = useState('50')
  const [mev, setMev] = useState(true)
  return (
    <div className="space-y-10">
      <Row title="Surface">
        <Cell id="Surface/plain/default">
          <Surface className="w-56 p-4">content on the photo</Surface>
        </Cell>
        <Cell id="Surface/plain/edge-both">
          <Surface edge="both" className="w-56 py-4">between two hairlines</Surface>
        </Cell>
        <Cell id="Surface/sheet/top">
          <Surface variant="sheet" className="w-56 p-4">modal sheet</Surface>
        </Cell>
        <Cell id="Surface/sheet/left">
          <Surface variant="sheet" edge="left" className="w-56 p-4">drawer</Surface>
        </Cell>
        <Cell id="Surface/strip/bottom">
          <Surface variant="strip" className="w-56 p-4">mobile strip</Surface>
        </Cell>
        {(['cream', 'teal', 'red', 'green', 'amber'] as const).map((a) => (
          <Cell key={a} id={`Surface/strip/accent-${a}`}>
            <Surface variant="strip" accent={a} className="w-56 p-4">toast · {a}</Surface>
          </Cell>
        ))}
        <Cell id="Surface/popover/hairline">
          <Surface variant="popover" className="w-56 p-4">dropdown</Surface>
        </Cell>
        <Cell id="Surface/popover/bare">
          <Surface variant="popover" bare className="w-56 p-3 text-[13px]">tooltip</Surface>
        </Cell>
        <Cell id="Panel/deprecated/default">
          <Panel className="w-56 p-4">Panel (deprecated, legacy look)</Panel>
        </Cell>
      </Row>

      <Row title="Button">
        <Cell id="Button/primary/enabled"><Button>primary</Button></Cell>
        <Cell id="Button/primary/disabled"><Button disabled>primary</Button></Cell>
        <Cell id="Button/text/enabled"><Button variant="text">text</Button></Cell>
        <Cell id="Button/text/disabled"><Button variant="text" disabled>text</Button></Cell>
        <Cell id="Button/text/danger"><Button variant="text" tone="danger">revoke</Button></Cell>
        <Cell id="Button/text/danger-disabled"><Button variant="text" tone="danger" disabled>revoke</Button></Cell>
        <Cell id="Button/icon/enabled"><Button variant="icon" aria-label="swap direction">⇅</Button></Cell>
        <Cell id="Button/icon/disabled"><Button variant="icon" aria-label="swap direction (disabled)" disabled>⇅</Button></Cell>
        <Cell id="Button/secondary/deprecated"><Button variant="secondary">secondary</Button></Cell>
      </Row>

      <Row title="Tabs · Segmented">
        <Cell id="Tabs/underline/states">
          <Tabs tabs={TABS} active={tab} onSelect={setTab} label="kit tabs" />
        </Cell>
        <Cell id="Segmented/underline/states">
          <Segmented tabs={TABS} active={seg} onSelect={setSeg} label="kit segmented" />
        </Cell>
      </Row>

      <Row title="Chip">
        <Cell id="Chip/selected">
          <Chip selected onClick={() => setChip('50')}>50%</Chip>
        </Cell>
        <Cell id="Chip/unselected">
          <Chip selected={chip === '100'} onClick={() => setChip(chip === '100' ? '50' : '100')}>100%</Chip>
        </Cell>
        <Cell id="Chip/disabled">
          <Chip disabled>25%</Chip>
        </Cell>
      </Row>

      <Row title="Input">
        <Cell id="Input/field/idle"><Input aria-label="kit field" placeholder="search" className="w-56" /></Cell>
        <Cell id="Input/field/invalid"><Input aria-label="kit field invalid" invalid defaultValue="bad" className="w-56" /></Cell>
        <Cell id="Input/field/disabled"><Input aria-label="kit field disabled" disabled defaultValue="locked" className="w-56" /></Cell>
        <Cell id="Input/amount/idle"><Input aria-label="kit amount" scale="amount" placeholder="0.0" className="w-56" /></Cell>
        <Cell id="Input/amount/invalid"><Input aria-label="kit amount invalid" scale="amount" invalid defaultValue="9999" className="w-56" /></Cell>
      </Row>

      <Row title="Toggle">
        <Cell id="Toggle/on"><Toggle checked={mev} onChange={setMev} label="kit toggle" className="w-64" /></Cell>
        <Cell id="Toggle/off"><Toggle checked={false} onChange={() => {}} label="kit toggle off" className="w-64" /></Cell>
        <Cell id="Toggle/disabled"><Toggle checked disabled onChange={() => {}} label="kit toggle disabled" className="w-64" /></Cell>
      </Row>

      <Row title="EyebrowLabel + HandUnderline">
        <Cell id="EyebrowLabel/default"><EyebrowLabel>eyebrow label</EyebrowLabel></Cell>
        <Cell id="HandUnderline/default">
          <span className="font-v2-display text-3xl font-bold uppercase"><HandUnderline>hand underline</HandUnderline></span>
        </Cell>
      </Row>

      <Row title="Skeleton">
        <Cell id="Skeleton/line"><Skeleton width={260} height={14} /></Cell>
        <Cell id="Skeleton/short"><Skeleton width={180} height={14} /></Cell>
        <Cell id="Skeleton/block"><Skeleton width={72} height={48} /></Cell>
      </Row>

      <Row title="Scrims (over the brightest graded photo pixel)">
        {(['left', 'left-race', 'left-features', 'down', 'down-features'] as const).map((s) => (
          <Cell key={s} id={`Scrim/${s}`}>
            <div className="w-64 p-4 text-[13px] text-v2-muted" style={{ backgroundColor: WORST_PHOTO, backgroundImage: `var(--scrim-${s})` }}>
              <span className="text-v2-text">headline</span> body copy on the scrim
            </div>
          </Cell>
        ))}
      </Row>
    </div>
  )
}
