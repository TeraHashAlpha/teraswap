'use client'

import './v2.css'
import { v2FontClassNames } from './font-loader'

// [ADR-025] Foundation placeholder: no pages yet. `data-ts-ui` is the marker the v1-bundle
// isolation evidence greps for in built chunks.
export default function HomeV2() {
  return <main data-ts-ui="v2" className={`ts-v2 min-h-screen ${v2FontClassNames}`} />
}
