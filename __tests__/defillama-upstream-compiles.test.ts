/**
 * Real `tsc` compile check for `integrations/defillama/upstream/index.ts`
 * against ambient stubs of the three upstream modules it imports, with no
 * `@ts-nocheck`. The comment-stripped body-equality test in
 * `defillama-upstream-artifact.test.ts` cannot catch a declaration that the
 * generator strips along with the in-repo shim (e.g. `SwapWithFeeLog`) —
 * this test would, because it actually type-checks the generated output the
 * way DefiLlama's own CI would once it is pasted into their repo.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(__dirname, '..')
const UPSTREAM_PATH = path.join(REPO_ROOT, 'integrations/defillama/upstream/index.ts')
const STUB_DIR = path.join(__dirname, 'fixtures/defillama-upstream-compile-stub')

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2020',
    lib: ['ES2020'],
    module: 'commonjs',
    moduleResolution: 'node',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  },
  include: ['**/*.ts'],
}

/**
 * Lays out `sourceText` as `aggregators/teraswap/index.ts` alongside stubs of
 * `adapters/types.ts` and `helpers/{chains,metrics}.ts` — the same relative
 * positions the file's own `../../adapters/types` etc. imports expect once
 * pasted into DefiLlama/dimension-adapters — and runs `tsc --noEmit` over it.
 * Returns `{ ok, output }` instead of throwing either way, so callers can
 * assert on failure as easily as success.
 */
function tscCompile(sourceText: string): { ok: boolean; output: string } {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'defillama-upstream-compile-'))
  try {
    cpSync(STUB_DIR, tmpDir, { recursive: true })
    const targetDir = path.join(tmpDir, 'aggregators/teraswap')
    cpSync(path.join(STUB_DIR, 'adapters'), path.join(tmpDir, 'adapters'), { recursive: true })
    cpSync(path.join(STUB_DIR, 'helpers'), path.join(tmpDir, 'helpers'), { recursive: true })
    require('node:fs').mkdirSync(targetDir, { recursive: true })
    writeFileSync(path.join(targetDir, 'index.ts'), sourceText)
    writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2))

    try {
      const output = execFileSync('npx', ['tsc', '--noEmit', '-p', tmpDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, output }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string }
      return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

describe('DefiLlama upstream artifact — real compile check', () => {
  it('the committed upstream/index.ts compiles clean against the upstream module stubs', () => {
    const source = readFileSync(UPSTREAM_PATH, 'utf8')
    const result = tscCompile(source)
    expect(result.output).not.toContain('SwapWithFeeLog')
    expect(result.ok).toBe(true)
  }, 30_000)

  it('a build that omits the local SwapWithFeeLog declaration fails to compile (the defect this test exists to catch)', () => {
    const source = readFileSync(UPSTREAM_PATH, 'utf8')
    // Strip just the local declaration this generator now emits, reproducing
    // exactly what shipped before Tasks 1-2: `accumulate` still annotates its
    // parameter `SwapWithFeeLog`, but nothing declares or imports it.
    const withoutLocalDecl = source.replace(
      /\/\*\*\n \* Local decoded-log shape[\s\S]*?\ntype SwapWithFeeLog = \{[\s\S]*?\n\}\n\n/,
      '',
    )
    expect(withoutLocalDecl).not.toContain('type SwapWithFeeLog')
    expect(withoutLocalDecl).toContain('log: SwapWithFeeLog')

    const result = tscCompile(withoutLocalDecl)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('SwapWithFeeLog')
  }, 30_000)
})
