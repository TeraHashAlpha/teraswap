'use client'

import type { DashboardData } from '@/lib/analytics-types'
import { barHeightPct, barTitle } from './analytics-model'

/**
 * [B9 C2] v1's Volume Trend (`DailyVolumeChart`): one div bar per day, oldest → newest left to right, the first and last date under it,
 * v1's tooltip on each bar (`{date}: {usd} ({n} trades)`). v1 draws it with plain divs, so no chart library is involved; the series is
 * exactly `dashboard.dailyVolume`.
 *
 * Accessibility: the bars are decorative (`aria-hidden`) and the text alternative is the same series as a list — one `li` per day,
 * v1's tooltip string verbatim (no new words), read in order by a screen reader and visually hidden. Motion: the only transition is a
 * hover opacity on the `--t-fast` token, which is 0 under `prefers-reduced-motion` (tokens.css); nothing animates in.
 */
export function VolumeChart({ data }: { data: DashboardData['dailyVolume'] }) {
  const maxVol = Math.max(...data.map((d) => d.volumeUsd), 1)
  if (data.length === 0) return null
  return (
    <figure className="m-0" data-testid="volume-trend" aria-labelledby="ts-an-volume-h">
      <figcaption>
        <h3 id="ts-an-volume-h" className="ts-an-cap mb-3">Volume Trend (30d)</h3>
      </figcaption>
      <div className="ts-an-bars" aria-hidden="true" data-testid="volume-bars">
        {data.map((d, i) => (
          <div key={`${d.date}-${i}`} className="ts-an-bar" style={{ height: `${barHeightPct(d.volumeUsd, maxVol)}%` }} title={barTitle(d)} />
        ))}
      </div>
      <ul className="ts-an-sr" data-testid="volume-text">
        {data.map((d, i) => (
          <li key={`${d.date}-${i}`}>{barTitle(d)}</li>
        ))}
      </ul>
      <div className="ts-an-axis">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </figure>
  )
}
