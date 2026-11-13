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

describe('goal-lint pasted goals (CONTROL header behind paste decoration)', () => {
  const BODY = 'CONTROL: model Sonnet · effort medium · NO CI polling · Exit = branch pushed + compare link.\nSigned commits.\n\nDo NOT touch prod.\n'
  // Reproduced 2026-11-13 against the old check: every row below failed `control-line` while the same text from a clean file passed.
  it.each([
    ['BOM', '﻿' + BODY],
    ['NBSP before CONTROL', ' ' + BODY],
    ['zero-width space before CONTROL', '​' + BODY],
    ['leading spaces', '  ' + BODY],
    ['leading tab', '\t' + BODY],
    ['bracketed-paste markers', '\x1b[200~' + BODY + '\x1b[201~'],
    ['"> " quote on every line', '> ' + BODY.replace(/\n(?=.)/g, '\n> ')],
    ['">" quote without a space', '>' + BODY],
    ['opening code fence', '```\n' + BODY + '```\n'],
    ['opening code fence with a language', '```text\n' + BODY + '```\n'],
    ['tilde fence', '~~~\n' + BODY + '~~~\n'],
    ['"/goal " prefix', '/goal ' + BODY],
    ['blank lines then a fence then CONTROL', '\n \n```\n' + BODY],
  ])('accepts: %s', (_name, text) => {
    expect(lintGoal(text)).toEqual([])
  })

  // These already passed before the fix; pinned so a later change cannot break them.
  it.each([
    ['CRLF', BODY.replace(/\n/g, '\r\n')],
    ['lone CR', BODY.replace(/\n/g, '\r')],
    ['leading blank lines', '\n\n  \n' + BODY],
    ['an NBSP-only first line', ' \n' + BODY],
    ['NBSP after the colon', BODY.replace('CONTROL: ', 'CONTROL: ')],
  ])('still accepts: %s', (_name, text) => {
    expect(lintGoal(text)).toEqual([])
  })

  it('a goal with NO control header still fails, however it is wrapped', () => {
    const noHeader = 'NO CI polling. Exit = pushed.\nSigned commits.\n'
    for (const wrapped of [noHeader, '﻿' + noHeader, '> ' + noHeader, '```\n' + noHeader + '```\n', '/goal ' + noHeader, '\x1b[200~' + noHeader]) {
      expect(rules(wrapped), JSON.stringify(wrapped.slice(0, 12))).toContain('control-line')
    }
  })

  it('only the FIRST content line counts: CONTROL: later in the text does not rescue it', () => {
    expect(rules('> preface\n> CONTROL: x · Exit = y')).toContain('control-line')
    expect(rules('```\nfoo\n```\nCONTROL: x · Exit = y')).toContain('control-line')
  })

  it('bold or other markup in front of CONTROL: is still refused (not paste decoration)', () => {
    expect(rules('**CONTROL:** x · Exit = y')).toContain('control-line')
    expect(rules('# CONTROL: x · Exit = y')).toContain('control-line')
  })

  it('the audit rule still reads the cleaned first line', () => {
    expect(rules('> CONTROL: READ-ONLY · Exit = report')).toContain('audit-verdict')
    expect(rules('> CONTROL: READ-ONLY · Exit = report on ANY verdict')).toEqual([])
  })

  it('sizes stay measured in BYTES of the input as given, decoration included', () => {
    const head = 'CONTROL: x · Exit = y\n'
    const room = MAX_CHARS - Buffer.byteLength('﻿' + head) // the BOM is 3 bytes
    expect(rules('﻿' + head + 'a'.repeat(room))).toEqual([])
    expect(rules('﻿' + head + 'a'.repeat(room + 1))).toContain('length')
  })

  describe('through the CLI (file and stdin)', () => {
    const run = (args, input) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', input })
    const dir = mkdtempSync(path.join(tmpdir(), 'goal-lint-paste-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('BOM + CRLF + quote file passes with the exact byte count', () => {
      const text = '﻿> ' + BODY.replace(/\n/g, '\r\n')
      const f = path.join(dir, 'pasted.md')
      writeFileSync(f, text)
      const r = run([f])
      expect([r.status, r.stdout.trim()]).toEqual([0, `OK ${Buffer.byteLength(text)} bytes`])
    })
    it('the same decorated text on /dev/stdin gives the same verdict as the file', () => {
      const text = '```\n' + BODY + '```\n'
      const f = path.join(dir, 'fenced.md')
      writeFileSync(f, text)
      expect(run(['/dev/stdin'], text).stdout).toBe(run([f]).stdout)
      expect(run(['/dev/stdin'], text).status).toBe(0)
    })
    it('a decorated goal without a header exits 1 on control-line', () => {
      const r = run(['/dev/stdin'], '> NO CI polling. Exit = pushed.\n')
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('FAIL control-line')
    })
  })
})
