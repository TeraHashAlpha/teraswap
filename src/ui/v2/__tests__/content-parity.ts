/**
 * [ADR-025] Content-parity helpers — the B10 gate, first instance: landing (B2). The rule the gate enforces for every
 * migrated page ("nothing lost", pack D5): every VISIBLE v1 text node, normalised, appears in the v2 render, and every
 * v1 link target is still linked. The only way a v1 string may disappear is an ALLOW-LIST entry, each carrying the
 * owner's reason; an entry that no longer matches anything in v1 (stale) or is still present in v2 (not removed) fails.
 *
 * Usage (B3+): render the v1 page and the v2 page against the same mocked claims, then
 *   const result = compareContent(v1Container, v2Container, ALLOW)
 *   expect(result.missingText).toEqual([]); expect(result.missingHrefs).toEqual([]); expect(result.staleAllow).toEqual([])
 */

export interface AllowedRemoval {
  /** Exact substring of a v1 text node (normalised) the owner removed from v2. */
  text: string
  /** Who decided, when, why — shown in the failure output. */
  reason: string
}

/**
 * NBSP / thin space / narrow NBSP -> space, runs of whitespace -> one space, trimmed, lower-cased. Case is styling, not
 * content: v1 hand-writes some strings in capitals ("READ THE DOCS", "PRE-SWAP") where v2 types them normally and lets
 * CSS capitalise - the words, their order and their punctuation are what the gate compares.
 */
export function normalize(s: string): string {
  return s.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function hiddenFromReaders(el: Element | null, root: Element): boolean {
  for (let n: Element | null = el; n && n !== root.parentElement; n = n.parentElement) {
    if (n.getAttribute('aria-hidden') === 'true' || n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'NOSCRIPT') return true
  }
  return false
}

/** Every visible text node under `root`, normalised, empty ones dropped (decorative `aria-hidden` subtrees skipped). */
export function visibleTextNodes(root: Element): string[] {
  const out: string[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (hiddenFromReaders(n.parentElement, root)) continue
    const t = normalize(n.textContent ?? '')
    if (t) out.push(t)
  }
  return out
}

export function hrefs(root: Element): string[] {
  return Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '')
}

/** v2's whole visible text as one normalised string, in document order (decorative subtrees skipped). */
export function visibleText(root: Element): string {
  return normalize(visibleTextNodes(root).join(' '))
}

export interface ParityResult {
  v1Nodes: number
  v1Hrefs: number
  missingText: string[]
  missingHrefs: string[]
  /** Allow-list entries that matched nothing in v1, or whose text is still present in v2. */
  staleAllow: string[]
}

export function compareContent(v1: Element, v2: Element, allow: readonly AllowedRemoval[] = []): ParityResult {
  const v1Nodes = visibleTextNodes(v1)
  const v2Text = visibleText(v2)
  const v2Hrefs = new Set(hrefs(v2))
  const v1Hrefs = Array.from(new Set(hrefs(v1)))

  const staleAllow: string[] = []
  for (const a of allow) {
    const text = normalize(a.text)
    if (!v1Nodes.some((n) => n.includes(text))) staleAllow.push(`${a.text} — matches nothing in v1 (${a.reason})`)
    else if (v2Text.includes(text)) staleAllow.push(`${a.text} — still present in v2, so it was not removed (${a.reason})`)
  }

  const missingText: string[] = []
  for (const node of v1Nodes) {
    let expected = node
    // the removed clause takes its leading space with it, so the sentence closes up cleanly
    for (const a of allow) expected = expected.split(` ${normalize(a.text)}`).join('').split(normalize(a.text)).join('')
    expected = normalize(expected)
    if (expected && !v2Text.includes(expected)) missingText.push(node)
  }

  return {
    v1Nodes: v1Nodes.length,
    v1Hrefs: v1Hrefs.length,
    missingText: Array.from(new Set(missingText)),
    missingHrefs: v1Hrefs.filter((h) => !v2Hrefs.has(h)),
    staleAllow,
  }
}
