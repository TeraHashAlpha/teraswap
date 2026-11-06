'use client'

import { useEffect, useState } from 'react'

/**
 * [feat/ui-v2-docs-legal] Container 2 (sticky TOC / scroll-spy nav): which section id is active, by the same
 * IntersectionObserver rule v1's DocsPage used (`rootMargin: '-20% 0px -70% 0px'`) — shared here so Legal's and
 * Docs' v2 TOCs track scroll the same way.
 */
export function useScrollSpy(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? '')

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      { rootMargin: '-20% 0px -70% 0px' },
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ids` is a stable literal array at each call site
  }, [])

  return active
}

export function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}
