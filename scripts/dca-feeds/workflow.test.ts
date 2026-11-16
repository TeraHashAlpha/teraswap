/**
 * [feat/dca-feed-candidates-weekly] Guards on .github/workflows/dca-feed-candidates.yml, read as TEXT (no YAML dependency):
 * the weekly job may only ever list candidates and open a PR. It must stay schedule + manual only, read-only by default,
 * pinned, free of ${{ }} inside run: scripts, and unable to merge, approve, enable a row, hold a key or send a transaction.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { getSupportedChainIds } from '@/lib/chains/registry'
import { CHAINS } from './lib'
import { directoryUrl } from './directory'

const TEXT = readFileSync(new URL('../../.github/workflows/dca-feed-candidates.yml', import.meta.url), 'utf8')
const LINES = TEXT.split('\n')
const indentOf = (l: string) => l.length - l.trimStart().length
const code = LINES.filter(l => !l.trimStart().startsWith('#')).join('\n')

/** The text of every `run:` step: the inline value, or the block under `run: |`. */
function runBlocks(): string[] {
  const out: string[] = []
  LINES.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/)
    if (!m) return
    const keyIndent = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0)
    if (!/^[|>]/.test(m[2])) { out.push(m[2]); return }
    const body: string[] = []
    for (let j = i + 1; j < LINES.length; j++) {
      if (LINES[j].trim() !== '' && indentOf(LINES[j]) <= keyIndent) break
      body.push(LINES[j])
    }
    out.push(body.join('\n'))
  })
  return out
}
/** The `key: value` entries of every `permissions:` block. */
function permissions(): string[] {
  const out: string[] = []
  LINES.forEach((line, i) => {
    const m = line.match(/^(\s*)permissions:\s*(.*)$/)
    if (!m || line.trimStart().startsWith('#')) return
    for (let j = i + 1; j < LINES.length; j++) {
      if (LINES[j].trim() !== '' && indentOf(LINES[j]) <= m[1].length) break
      const e = LINES[j].match(/^\s+([\w-]+):\s*(read|write|none)\b/)
      if (e) out.push(`${e[1]}: ${e[2]}`)
    }
  })
  return out
}

describe('dca-feed-candidates.yml', () => {
  it('runs on a weekly schedule and by hand, nothing else', () => {
    const start = LINES.findIndex(l => /^on:\s*$/.test(l))
    const keys: string[] = []
    for (let j = start + 1; j < LINES.length && (LINES[j].trim() === '' || indentOf(LINES[j]) > 0); j++) {
      const k = LINES[j].match(/^ {2}(\w+):/)
      if (k) keys.push(k[1])
    }
    expect(keys).toEqual(['schedule', 'workflow_dispatch'])
    expect(code).toMatch(/cron: "30 6 \* \* 1"/)
    expect(code).not.toMatch(/pull_request|push:|repository_dispatch|workflow_run/)
  })
  it('is read-only by default and grants only contents and pull-requests write to the one job that needs them', () => {
    expect(permissions()).toEqual(['contents: read', 'contents: write', 'pull-requests: write'])
    expect(code.match(/^permissions:\n {2}contents: read$/m)).not.toBeNull()
  })
  it('pins every action to a full commit SHA', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map(m => m[1])
    expect(uses.length).toBeGreaterThanOrEqual(4)
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })
  it('never puts an expression inside a run: script (values arrive through env:)', () => {
    const blocks = runBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    for (const b of blocks) expect(b).not.toContain('${{')
  })
  it('takes its chains from the registry and runs the read-only script with the one write it is allowed', () => {
    expect(code).toContain('fromJson(needs.chains.outputs.matrix)')
    expect(code).toContain('scripts/dca-feeds/list-chains.ts')
    expect(code).toContain('scripts/dca-feeds/candidates.ts --chain "$CHAIN" --write-config')
    expect(code).toContain('--title "DCA feed candidates: ${CHAIN}, ${TODAY}"')
    expect(code).toContain('--body-file')
    expect(code).not.toContain('continue-on-error')
  })
  it('cannot merge, approve, enable a row, hold a key or send a transaction', () => {
    for (const bad of [
      /gh pr merge/, /--auto\b/, /--admin/, /--approve/, /gh pr review/, /pull_request_target/, /--force/, /push[^\n]*\s\+\S/, /--delete-branch/,
      /\bcast\b/, /sendTransaction/, /private[_ ]?key/i, /mnemonic/i, /PRIVATE_KEY/, /GUARD_RPC/, /batch\.ts/, /plan\.ts/, /enabled: true/, /"enabled"/, /--batch\b/,
    ]) expect(code.match(bad)?.[0] ?? null, `forbidden pattern ${String(bad)}`).toBeNull()
    const secrets = [...code.matchAll(/secrets\.(\w+)/g)].map(m => m[1])
    expect(secrets).toEqual(['CATALOG_PR_TOKEN'])
    expect(code).not.toMatch(/\bgithub\.event\./)
  })
  it('the matrix is the registry narrowed to chains the DCA scripts know, each with a directory file and an executor', () => {
    const supported = new Set(getSupportedChainIds())
    const keys = Object.entries(CHAINS).filter(([, c]) => supported.has(c.id)).map(([k]) => k)
    expect(keys).toEqual(['base', 'arbitrum'])
    for (const [, c] of Object.entries(CHAINS)) {
      expect(supported.has(c.id), `${c.name} is in the chain registry`).toBe(true)
      expect(directoryUrl(c.id), `${c.name} has a directory file`).not.toBeNull()
    }
  })
})
