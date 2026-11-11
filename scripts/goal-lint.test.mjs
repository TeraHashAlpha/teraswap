import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintGoal, MAX_CHARS } from './goal-lint.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'goal-lint.mjs')

const GOOD = [
  'CONTROL: model Sonnet · effort medium · NO CI polling · Exit = branch pushed + compare link reported.',
  'STOP only if blocked or before anything irreversible.',
  'SSH-signed commits.',
  '',
  'Do NOT run ssh, pm2 or cast send.',
].join('\n')

const AUDIT = 'CONTROL: READ-ONLY audit · Exit = report delivered on ANY verdict.\nVERDICT line last.'

const rules = (text) => lintGoal(text).map((v) => v.rule)

describe('lintGoal', () => {
  it('accepts a clean goal', () => {
    expect(lintGoal(GOOD)).toEqual([])
  })

  it('accepts a clean audit goal', () => {
    expect(lintGoal(AUDIT)).toEqual([])
  })

  it('fails above 4000 bytes and passes at exactly 4000 (the header holds a 2-byte "·")', () => {
    const head = 'CONTROL: x · Exit = y\n'
    const room = MAX_CHARS - Buffer.byteLength(head)
    expect(rules(head + 'a'.repeat(room))).toEqual([])
    expect(rules(head + 'a'.repeat(room + 1))).toContain('length')
  })

  it('fails when the first non-empty line is not CONTROL:', () => {
    expect(rules('NO CI polling\nCONTROL: x\nExit = y')).toContain('control-line')
    expect(rules('\n  \nsome preface\nCONTROL: x\nExit = y')).toContain('control-line')
    expect(rules('')).toContain('control-line')
  })
  it('leading blank lines before CONTROL: are fine (first NON-EMPTY line counts)', () => {
    expect(rules('\n\nCONTROL: x · Exit = y')).toEqual([])
    expect(rules('\nCONTROL: READ-ONLY · Exit = report')).toContain('audit-verdict')
  })

  it('fails without an Exit = clause', () => {
    expect(rules('CONTROL: x · Exit is somewhere')).toContain('exit-clause')
  })

  it('fails on "no Monitor" and "CI-poll" in any case', () => {
    expect(rules('CONTROL: x · Exit = y · no Monitor')).toContain('banned-phrase')
    expect(rules('CONTROL: x · Exit = y · NO CI-poll')).toContain('banned-phrase')
    expect(rules('CONTROL: x · Exit = y · ci-poll')).toContain('banned-phrase')
  })

  it('allows "CI polling" (no hyphen) — the spelling the owner uses', () => {
    expect(rules('CONTROL: x · Exit = y · NO CI polling')).toEqual([])
  })

  it('fails when pm2 / ssh / cast send appear outside a Do-NOT line', () => {
    for (const bad of ['restart with pm2', 'then ssh host', 'run cast send now']) {
      const hit = lintGoal(`CONTROL: x · Exit = y\n${bad}`).filter((v) => v.rule === 'risky-command')
      expect(hit, bad).toHaveLength(1)
      expect(hit[0].detail).toContain('line 2')
    }
  })

  it('allows them on Do-NOT lines (plain, bulleted, bold, heading) and inside a Do NOT section', () => {
    const lines = [
      'Do NOT use pm2.',
      '- Do NOT ssh anywhere.',
      '**Do NOT** cast send.',
    ]
    for (const l of lines) expect(rules(`CONTROL: x · Exit = y\n${l}`), l).toEqual([])
    expect(rules('CONTROL: x · Exit = y\n## Do NOT\npm2, ssh, cast send\nmore: ssh')).toEqual([])
  })

  it('leaves a Do NOT section when the next heading starts', () => {
    expect(rules('CONTROL: x · Exit = y\n## Do NOT\nssh\n## Steps\nssh in')).toEqual(['risky-command'])
  })

  it('does not match substrings or the uppercase prose "SSH-signed"', () => {
    expect(rules('CONTROL: x · Exit = y\nSSH-signed, sshd, pm2x, broadcast sending')).toEqual([])
  })

  it('requires "ANY verdict" only for READ-ONLY (audit) goals', () => {
    expect(rules('CONTROL: READ-ONLY · Exit = report')).toContain('audit-verdict')
    expect(rules('CONTROL: READ-ONLY · Exit = report on ANY verdict')).toEqual([])
    expect(rules('CONTROL: model Opus · Exit = report')).toEqual([])
  })

  it('reports several violations at once', () => {
    const r = rules('hello\nssh now')
    expect(r).toEqual(expect.arrayContaining(['control-line', 'exit-clause', 'risky-command']))
  })
})

describe('goal-lint CLI', () => {
  let dir
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'goal-lint-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name, text) => {
    const f = path.join(dir, name)
    writeFileSync(f, text)
    return f
  }

  it('exits 0 on a clean file', () => {
    const out = execFileSync('node', [SCRIPT, write('good.md', GOOD)], { encoding: 'utf8' })
    expect(out).toMatch(/^OK /)
  })

  it('exits 1 and lists violations on a bad file', () => {
    const r = spawnSync('node', [SCRIPT, write('bad.md', 'no control here\nssh x')], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL control-line')
    expect(r.stdout).toContain('FAIL risky-command')
  })

  it('exits 2 on a missing file or missing argument', () => {
    expect(spawnSync('node', [SCRIPT, path.join(dir, 'nope.md')], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status).toBe(2)
  })
})

describe('goal-lint A77 lows: bytes and Do-NOT shapes', () => {
  const HEAD = 'CONTROL: x · Exit = y\n'
  it('counts UTF-8 bytes exactly as `wc -c` does: 2000 two-byte characters is 4000 bytes + header -> over', () => {
    const body = 'é'.repeat(1900) // 3800 bytes
    const pad = (n) => 'a'.repeat(n)
    const fits = HEAD + body
    const bytes = Buffer.byteLength(fits)
    expect(rules(fits + pad(MAX_CHARS - bytes))).toEqual([])
    expect(rules(fits + pad(MAX_CHARS - bytes + 1))).toContain('length')
    // 1500 three-byte arrows: 1500 chars (< 4000) but 4500 bytes
    expect(rules(HEAD + '→'.repeat(1500))).toContain('length')
    expect(lintGoal(HEAD + '→'.repeat(1500))[0].detail).toMatch(/\d+ bytes > 4000/)
  })
  it('the CLI reports bytes equal to wc -c, including for invalid UTF-8', () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'goal-lint-wc-')), 'wc.md')
    writeFileSync(f, Buffer.concat([Buffer.from(HEAD + '· — é\n'), Buffer.from([0xff, 0xfe, 0x0a])]))
    const wc = Number(execFileSync('wc', ['-c', f], { encoding: 'utf8' }).trim().split(/\s+/)[0])
    expect(execFileSync('node', [SCRIPT, f], { encoding: 'utf8' }).trim()).toBe(`OK ${wc} bytes`)
  })
  it.each([
    ['numbered', '1. Do NOT run ssh.\n2. Do NOT use pm2.'],
    ['numbered paren', '1) Do NOT cast send.'],
    ['checkbox', '- [ ] Do NOT run ssh.\n- [x] Do NOT use pm2.'],
    ['checkbox star', '* [ ] Do not cast send.'],
    ['bold numbered', '1. **Do NOT** ssh anywhere.'],
    ['label then bullets', 'Do NOT:\n- ssh\n- pm2\n- cast send'],
    ['bold label then bullets', '**Do NOT:**\n\n- ssh\n- pm2 with a long\n  continuation: cast send'],
    ['label then numbers', 'Do NOT:\n1. ssh\n2. pm2'],
    ['heading label', '### Do NOT:\n- ssh'],
  ])('allows risky words on Do-NOT lines: %s', (_n, block) => {
    expect(rules(`${HEAD}${block}`), block).toEqual([])
  })
  it('a Do NOT: list ends at the first non-list paragraph', () => {
    expect(rules(`${HEAD}Do NOT:\n- ssh\n\nNow run ssh host.`)).toEqual(['risky-command'])
    expect(rules(`${HEAD}1. ssh first`)).toEqual(['risky-command'])
    expect(rules(`${HEAD}- [ ] run pm2`)).toEqual(['risky-command'])
  })
})
