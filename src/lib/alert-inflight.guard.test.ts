// @vitest-environment node
/**
 * Guard: no `emitTransitionAlert(` call may be left bare. Every call is either awaited (the caller waits for the fan-out)
 * or wrapped in `trackAlert(` (the keep-alive hook of alert-inflight.ts). A bare, un-collected call is the 2026-11-13
 * bug: the function is frozen after the response and the alert is cut.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')

/** Lines of `source` holding a call to emitTransitionAlert that is neither awaited nor passed to trackAlert. */
function bareAlertCalls(source: string): Array<{ line: number; text: string }> {
  const bare: Array<{ line: number; text: string }> = []
  source.split('\n').forEach((raw, i) => {
    const trimmed = raw.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return // comment or JSDoc
    const code = raw.replace(/\/\/.*$/, '') // trailing line comment
    const re = /emitTransitionAlert\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const before = code.slice(0, m.index)
      if (/\bfunction\s+$/.test(before)) continue // the definition itself
      if (/\bawait\s+$/.test(before)) continue
      if (/\btrackAlert\(\s*$/.test(before)) continue
      bare.push({ line: i + 1, text: trimmed })
    }
  })
  return bare
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'generated') continue
      out.splice(out.length, 0, ...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.splice(out.length, 0, full)
    }
  }
  return out
}

describe('emitTransitionAlert is never left bare', () => {
  it('the scanner flags a bare call, and passes awaited and tracked ones', () => {
    expect(bareAlertCalls('  emitTransitionAlert(id, a, b, r).catch(() => {})')).toHaveLength(1)
    expect(bareAlertCalls('  void emitTransitionAlert(id, a, b, r)')).toHaveLength(1)
    expect(bareAlertCalls('  return emitTransitionAlert(id, a, b, r)')).toHaveLength(1)
    expect(bareAlertCalls('  await emitTransitionAlert(id, a, b, r)')).toHaveLength(0)
    expect(bareAlertCalls('  trackAlert(emitTransitionAlert(id, a, b, r).catch(() => {}))')).toHaveLength(0)
    expect(bareAlertCalls('  trackAlert(\n    emitTransitionAlert(id, a, b, r))')).toHaveLength(1) // keep the pair on one line: easy to read, easy to grep
    expect(bareAlertCalls(' * emitTransitionAlert() fans out\n// emitTransitionAlert(x) is documented here')).toHaveLength(0)
    expect(bareAlertCalls('export async function emitTransitionAlert(')).toHaveLength(0)
  })

  it('no non-test source file under src/ has a bare call', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('emitTransitionAlert')) continue
      for (const b of bareAlertCalls(text)) offenders.splice(offenders.length, 0, `${path.relative(SRC, file)}:${b.line}: ${b.text}`)
    }
    expect(offenders).toEqual([])
  })

  it('source-state-machine.ts has exactly three calls, all of them trackAlert(emitTransitionAlert(...))', () => {
    const text = readFileSync(path.join(SRC, 'lib/source-state-machine.ts'), 'utf8')
    const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code.match(/emitTransitionAlert\s*\(/g) ?? []).toHaveLength(3)
    expect(code.match(/trackAlert\(emitTransitionAlert\s*\(/g) ?? []).toHaveLength(3)
  })

  it('alert-inflight.ts keeps `after` and node:async_hooks out of static imports (the module is reachable from a client chunk; `next build` fails otherwise)', () => {
    const text = readFileSync(path.join(SRC, 'lib/alert-inflight.ts'), 'utf8')
    const imports = text.split('\n').filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l))
    expect(imports.filter((l) => /next\/server|node:async_hooks/.test(l))).toEqual([])
  })
})
