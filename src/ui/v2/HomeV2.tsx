'use client'

import { AppShell } from './shell'

// [ADR-025] `/` under the switch: the Swap tab (owner review, 26 Oct — it used to be an empty <main>). The landing
// page joins it in the next commit, behind the same landing-vs-app split v1 uses.
export default function HomeV2() {
  return <AppShell tab="swap" />
}
