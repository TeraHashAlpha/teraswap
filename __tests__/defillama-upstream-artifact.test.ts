/**
 * Guards the generator that turns the tested, reviewed
 * `integrations/defillama/teraswap-adapter.ts` mirror into
 * `integrations/defillama/upstream/index.ts` — the file that pastes into
 * DefiLlama/dimension-adapters with zero hand edits.
 *
 * `scripts/build-defillama-upstream.mjs` is the only thing allowed to write
 * `upstream/index.ts`. These tests exist so a hand edit to either file, or
 * drift between them, fails the suite instead of shipping quietly.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildUpstreamSource } from '../scripts/build-defillama-upstream.mjs'

const REPO_ROOT = path.join(__dirname, '..')
const MIRROR_PATH = path.join(REPO_ROOT, 'integrations/defillama/teraswap-adapter.ts')
const UPSTREAM_PATH = path.join(REPO_ROOT, 'integrations/defillama/upstream/index.ts')
const GENERATOR_PATH = path.join(REPO_ROOT, 'scripts/build-defillama-upstream.mjs')

const MIRROR_BODY_START_MARKER = 'export const SWAP_WITH_FEE_EVENT ='
const UPSTREAM_BODY_START_MARKER = 'const SWAP_WITH_FEE_EVENT ='

/** Strips block and line comments, then blank lines, then trims each line. */
function stripCommentsAndBlankLines(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = noBlockComments
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
  return lines.join('\n')
}

describe('DefiLlama upstream artifact — generator drift guard', () => {
  it('regenerating into a fresh path byte-matches the committed upstream/index.ts', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'defillama-upstream-'))
    const tmpOutput = path.join(tmpDir, 'index.ts')
    try {
      execFileSync('node', [GENERATOR_PATH, tmpOutput])
      const regenerated = readFileSync(tmpOutput, 'utf8')
      const committed = readFileSync(UPSTREAM_PATH, 'utf8')
      expect(regenerated).toBe(committed)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('the committed upstream/index.ts equals what buildUpstreamSource produces from the mirror right now', () => {
    // A mutation to the mirror without regenerating the committed upstream
    // file fails here: this calls the generator fresh against whatever
    // teraswap-adapter.ts currently is and compares against the file
    // actually checked in.
    const mirrorSource = readFileSync(MIRROR_PATH, 'utf8')
    const freshlyGenerated = buildUpstreamSource(mirrorSource)
    const committed = readFileSync(UPSTREAM_PATH, 'utf8')
    expect(freshlyGenerated).toBe(committed)
  })

  it('stripped of comments and blanks, the mirror and upstream bodies are the same code', () => {
    const mirrorSource = readFileSync(MIRROR_PATH, 'utf8')
    const upstreamSource = readFileSync(UPSTREAM_PATH, 'utf8')

    const mirrorBodyIdx = mirrorSource.indexOf(MIRROR_BODY_START_MARKER)
    const upstreamBodyIdx = upstreamSource.indexOf(UPSTREAM_BODY_START_MARKER)
    expect(mirrorBodyIdx).toBeGreaterThan(-1)
    expect(upstreamBodyIdx).toBeGreaterThan(-1)

    // Slicing from this marker drops the mirror's in-repo shim (which sits
    // entirely above it) and the upstream file's three imports (which sit
    // entirely above it too) — what remains is the part that must behave
    // identically once pasted upstream.
    const mirrorBody = mirrorSource.slice(mirrorBodyIdx)
    const upstreamBody = upstreamSource.slice(upstreamBodyIdx)

    const mirrorCode = stripCommentsAndBlankLines(mirrorBody).replace(/\bexport const\b/g, 'const')
    const upstreamCode = stripCommentsAndBlankLines(upstreamBody)

    expect(upstreamCode).toBe(mirrorCode)
  })

  it('the generated file carries no repo-internal path, no `export const`, and no shim marker', () => {
    const generated = readFileSync(UPSTREAM_PATH, 'utf8')

    for (const needle of ['docs/DEPLOYMENTS.md', 'src/lib/', 'contracts/', '__tests__/', 'CLAUDE.md']) {
      expect(generated).not.toContain(needle)
    }
    expect(generated).not.toMatch(/\bexport const\b/)
    expect(generated).not.toContain('IN-REPO SHIM')
  })

  it("the generated file's first three non-comment, non-blank lines are exactly the three upstream imports", () => {
    const generated = readFileSync(UPSTREAM_PATH, 'utf8')
    const codeLines = generated
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'))

    expect(codeLines.slice(0, 3)).toEqual([
      'import { FetchOptions, SimpleAdapter } from "../../adapters/types";',
      'import { CHAIN } from "../../helpers/chains";',
      'import { METRIC } from "../../helpers/metrics";',
    ])
  })
})
