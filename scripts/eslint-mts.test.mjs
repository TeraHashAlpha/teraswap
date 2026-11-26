// `.mts` / `.cts` are TypeScript and must be linted like `.ts`. eslint-config-next's TypeScript block only matches
// `*.ts` / `*.tsx`, so they fell to its Babel parser, whose function-type nodes make
// `@typescript-eslint/no-unused-vars` throw `TypeError: node.params is not iterable` (CI lint exit 2, PR #727).
// These tests run the repo's real eslint.config.mjs; the linted text is passed in, no file is written.
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: ROOT })
const EXTENSIONS = ['mts', 'cts', 'd.mts', 'd.cts']
const configFor = (ext) => eslint.calculateConfigForFile(path.join(ROOT, `scripts/probe.${ext}`))
const lint = async (ext, text) => (await eslint.lintText(text, { filePath: path.join(ROOT, `scripts/probe.${ext}`) }))[0]

const findings = (r) => r.messages.map((m) => [m.ruleId, m.severity, m.line])
// Three kinds of unused name, each next to a function type.
const UNUSED = [
  'const unused: () => number = () => 1\nexport type T = () => number\n',
  'type Unused = () => number\nexport {}\n',
  "import type { Stats } from 'node:fs'\nexport type T = () => number\n",
]

// The three function-type forms that crashed (PR #727: the first one, inside an object type).
const CRASHING = [
  'export type T = () => number',
  'export type Reader = { releaseWhen: (stderrSoFar: string) => boolean }',
  'export interface Calls { (x: string): void; method(y: number): void }',
]

describe.each(EXTENSIONS)('eslint config: *.%s is linted like *.ts', (ext) => {
  it('uses the same parser as .ts', async () => {
    const [own, ts] = await Promise.all([configFor(ext), configFor('ts')])
    expect(own.languageOptions.parser).toBe(ts.languageOptions.parser)
    expect(own.languageOptions.parser.meta?.name).toBe('typescript-eslint/parser')
  }, 60000)

  it('has the same rules at the same severities and options as .ts', async () => {
    const [own, ts] = await Promise.all([configFor(ext), configFor('ts')])
    expect(own.rules).toEqual(ts.rules)
  }, 60000)

  it.each(CRASHING)('reports on `%s` instead of crashing', async (code) => {
    const r = await lint(ext, `${code}\n`)
    expect(r.fatalErrorCount).toBe(0)
    expect(r.errorCount).toBe(0)
  }, 60000)

  it('still reports through the rule that crashed: an unused import is one no-unused-vars warning', async () => {
    const r = await lint(ext, "import type { Stats } from 'node:fs'\nexport type T = () => number\n")
    expect(findings(r)).toEqual([['@typescript-eslint/no-unused-vars', 1, 1]])
  }, 60000)

  // A declaration file's twin is `.d.ts`: there a top-level name counts as ambient, so an unused local is not reported.
  it('reports exactly what its .ts / .d.ts twin reports', async () => {
    const twin = ext.startsWith('d.') ? 'd.ts' : 'ts'
    for (const code of UNUSED) {
      const [own, same] = await Promise.all([lint(ext, code), lint(twin, code)])
      expect(findings(own), code).toEqual(findings(same))
    }
    const local = await lint(ext, UNUSED[0])
    expect(findings(local).length).toBe(twin === 'ts' ? 1 : 0)
  }, 60000)
})
