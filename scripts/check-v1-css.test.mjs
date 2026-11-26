// scripts/check-v1-css.mjs, on two hand-written fixture stylesheets (good, crossed) in a fake `.next/static` tree.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANCHOR, V1_ONLY, V2_ONLY, classNames } from './check-v1-css.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SCRIPT = path.join(HERE, 'check-v1-css.mjs')
const GOOD = readFileSync(path.join(HERE, 'check-v1-css-fixtures/good.css'), 'utf8')
const CROSSED = readFileSync(path.join(HERE, 'check-v1-css-fixtures/crossed.css'), 'utf8')
// the separate stylesheet the v2 pass emits
const V2_SHEET = '.bg-v2-surface{background-color:#0e1416}\n.font-v2-mono{font-family:var(--font-mono)}\n.text-v2-text{color:#e8ecea}\n'

let dir
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'v1-css-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(sheets, { sub = 'chunks' } = {}) {
  const home = mkdtempSync(path.join(dir, 'b-'))
  const staticDir = path.join(home, '.next/static')
  mkdirSync(path.join(staticDir, sub), { recursive: true })
  for (const [name, css] of Object.entries(sheets)) writeFileSync(path.join(staticDir, sub, name), css)
  return spawnSync(process.execPath, [SCRIPT, staticDir], { encoding: 'utf8' })
}

describe('check-v1-css on the fixtures', () => {
  it('good: exit 0, one OK line naming the stylesheet and the markers', () => {
    const r = run({ 'aaa.css': GOOD, 'bbb.css': V2_SHEET })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(r.stdout).toMatch(/^check-v1-css OK: chunks\/aaa\.css \(\d+ bytes\)/)
    for (const m of [...V1_ONLY, ...V2_ONLY]) expect(r.stdout).toContain(`.${m}`)
  })

  it('crossed: exit 1, every missing v1 marker and every v2 marker present is named', () => {
    const r = run({ 'aaa.css': CROSSED, 'bbb.css': V2_SHEET })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    for (const m of V1_ONLY) expect(r.stderr).toContain(`chunks/aaa.css lacks the v1-only class .${m}`)
    for (const m of V2_ONLY) expect(r.stderr).toContain(`chunks/aaa.css contains the v2-only class .${m}`)
  })

  it('either half alone fails: a lost v1 utility, or one v2 utility leaked into an otherwise good sheet', () => {
    for (const m of V1_ONLY) {
      const lost = GOOD.replace(`.${m.replace('/', '\\/')}{`, '.gone{')
      expect(lost).not.toBe(GOOD)
      const r = run({ 'aaa.css': lost, 'bbb.css': V2_SHEET })
      expect(r.status, m).toBe(1)
      expect(r.stderr).toContain(`lacks the v1-only class .${m}`)
      expect(r.stderr).not.toContain('contains the v2-only')
    }
    for (const m of V2_ONLY) {
      const r = run({ 'aaa.css': `${GOOD}.hover\\:flex:hover,.${m}{display:flex}\n`, 'bbb.css': V2_SHEET })
      expect(r.status, m).toBe(1)
      expect(r.stderr).toContain(`contains the v2-only class .${m}`)
      expect(r.stderr).not.toContain('lacks the v1-only')
    }
  })

  it('the hand-written overrides that survive a crossed build are not markers (they would pass it)', () => {
    const names = classNames(CROSSED)
    expect(names.has('bg-surface-secondary')).toBe(true)
    expect(names.has('text-cream')).toBe(true)
    for (const m of V1_ONLY) expect(names.has(m)).toBe(false)
  })

  it('a marker is matched as a whole class: a variant, a longer name, a comment, a string or a url() is not it', () => {
    const fake = V1_ONLY.map((m) => {
      const e = m.replace('/', '\\/')
      return `.hover\\:${e}:hover{x:y}\n.${e}0{x:y}\n.${e}-x{x:y}\n/* .${e} */\n.a{content:".${e}"}\n.b{background:url(/x.${e})}\n`
    }).join('')
    const r = run({ 'aaa.css': `:root{${ANCHOR}1}\n${fake}`, 'bbb.css': V2_SHEET })
    expect(r.status).toBe(1)
    for (const m of V1_ONLY) expect(r.stderr).toContain(`lacks the v1-only class .${m}`)
  })

  it('fails closed: no build directory, no stylesheet, or no stylesheet carrying the globals.css anchor', () => {
    const none = spawnSync(process.execPath, [SCRIPT, path.join(dir, 'nope')], { encoding: 'utf8' })
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('no built stylesheet')
    expect(run({}).status).toBe(1)
    const r = run({ 'bbb.css': V2_SHEET })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`no stylesheet declares ${ANCHOR}`)
  })

  it('fails when a v2 marker is in no other stylesheet (renamed in v2: the "contains" half would be empty)', () => {
    for (const sheets of [{ 'aaa.css': GOOD }, { 'aaa.css': GOOD, 'bbb.css': V2_SHEET.replace('.text-v2-text{', '.text-v2-ink{') }]) {
      const r = run(sheets)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('stale marker: .text-v2-text')
    }
  })

  it('checks every stylesheet that declares the anchor, and finds them under static/css too', () => {
    expect(run({ 'aaa.css': GOOD, 'bbb.css': V2_SHEET }, { sub: 'css' }).status).toBe(0)
    const r = run({ 'aaa.css': GOOD, 'zzz.css': CROSSED, 'bbb.css': V2_SHEET })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('chunks/zzz.css lacks')
    expect(r.stderr).not.toContain('chunks/aaa.css')
  })

  it('writes no process.exit (a piped report must not be cut)', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/process\.exit\(/)
  })
})

// The markers are only worth something while they mean what they say in the source tree.
describe('check-v1-css markers exist today and are one-sided', () => {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', 'src'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  const isV2 = (f) => f.startsWith('src/ui/v2/') || f.startsWith('src/app/v2/')
  const wordsOf = (f) => new Set(readFileSync(path.join(ROOT, f), 'utf8').split(/[\s"'`{}(),;=<>]+/))
  const words = files.map((f) => ({ v2: isV2(f), set: wordsOf(f) }))
  const users = (cls, v2) => words.filter((w) => w.v2 === v2 && w.set.has(cls)).length
  const globals = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8')

  it('the anchor is hand-written in globals.css, so it is in the stylesheet even when the Tailwind pass goes wrong', () => {
    expect(globals).toContain(ANCHOR)
  })

  it.each(V1_ONLY)('v1-only .%s: used by v1 source, by no v2 source, and not hand-written in globals.css', (m) => {
    expect(users(m, false)).toBeGreaterThan(0)
    expect(users(m, true)).toBe(0)
    expect(classNames(globals).has(m)).toBe(false)
  })

  it.each(V2_ONLY)('v2-only .%s: used by v2 source and by no v1 source', (m) => {
    expect(users(m, true)).toBeGreaterThan(0)
    expect(users(m, false)).toBe(0)
  })
})

describe('CI runs the check right after the build', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const job = ci.slice(ci.indexOf('\n  build:\n'))

  it('the build job runs `npm run build` and then node scripts/check-v1-css.mjs', () => {
    const runs = [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((m) => m[1].trim())
    expect(runs).toEqual(['npm ci', 'npm run build', 'node scripts/check-v1-css.mjs'])
    expect(job).not.toMatch(/continue-on-error|^\s+if:/m)
  })
})
