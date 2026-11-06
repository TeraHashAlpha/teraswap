/**
 * [feat/catalog-auto-merge] One all-pass fixture + one failing fixture per condition (C1–C9),
 * plus an end-to-end run of the CLI against a throwaway git repo (the real `git show`/`rev-list`
 * path the workflow uses). Pure verdict logic is exercised through evaluateEligibility.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { getAddress } from 'viem'
import {
  ELIGIBILITY_DEFAULTS,
  TRUST_FILE,
  catalogFile,
  evaluateEligibility,
  renderChecklist,
  validateAddedRow,
} from './auto-merge-eligibility.mjs'

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
const row = (n: number, over: Record<string, unknown> = {}) => ({
  address: addr(n),
  symbol: `T${n}`,
  name: `Token ${n}`,
  decimals: 18,
  category: 'Other',
  logoURI: `/api/token-logo?chainId=1&address=${addr(n).toLowerCase()}`,
  verified: true,
  sources: ['uniswap', 'coingecko'],
  volume24hUsd: 100,
  volumeSource: 'coingecko',
  volumeFetchedAt: '2026-11-02',
  ...over,
})
const trust = (chainId: number, n: number, over: Record<string, unknown> = {}) => ({
  chainId, address: addr(n), symbol: `T${n}`, inTrustedList: true, hasBytecode: true, transferable: true, decimals: 18, ...over,
})

const RUN = '41457747996'
const base = (over: Record<string, unknown> = {}) => ({
  guard: 'success',
  ciTriggered: true,
  prAuthor: 'TeraHashAlpha',
  expectedAuthor: 'TeraHashAlpha',
  headRef: `chore/token-catalog-refresh-1-2026-11-02-${RUN}`,
  runId: RUN,
  files: [catalogFile(1), TRUST_FILE],
  before: { tokens: [row(1), row(2), row(3)] },
  // volume churn on existing rows + 2 additions: the normal weekly shape
  after: { tokens: [row(1, { volume24hUsd: 999 }), row(2), row(3), row(4), row(5)] },
  trustBefore: { tokens: [trust(1, 1), trust(1, 2), trust(1, 3)] },
  trustAfter: { tokens: [trust(1, 1), trust(1, 2, { inTrustedList: false }), trust(1, 3), trust(1, 4), trust(1, 5)] },
  commit: { count: 1, parentIsBase: true, author: 'github-actions[bot]', headline: 'chore(catalog): scheduled tokens:sync refresh — chain 1' },
  ...over,
})
const failedIds = (i: ReturnType<typeof base>) => evaluateEligibility(i).checks.filter((c) => !c.pass).map((c) => c.id)

describe('evaluateEligibility — all-pass fixture', () => {
  it('is eligible when every condition holds (volume churn + 2 additions, mainnet, PAT author)', () => {
    const r = evaluateEligibility(base())
    expect(r.checks.map((c) => c.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'])
    expect(r.reasons).toEqual([])
    expect(r.eligible).toBe(true)
    expect(r.stats).toEqual({ added: 2, removed: 0, rows: 5 })
  })
})

describe('evaluateEligibility — one fixture per failing condition', () => {
  it('C1 Guard not PASS', () => expect(failedIds(base({ guard: 'failure' }))).toEqual(['C1']))
  it('C1 Guard outcome missing → fails closed', () => expect(failedIds(base({ guard: undefined }))).toEqual(['C1']))

  it('C2 code file in the diff', () => expect(failedIds(base({ files: [catalogFile(1), TRUST_FILE, 'src/lib/swap.ts'] }))).toEqual(['C2']))
  it('C2 workflow / package / config files in the diff', () => {
    for (const f of ['.github/workflows/ci.yml', 'package.json', 'scripts/token-catalog/lib/config.ts']) {
      expect(failedIds(base({ files: [catalogFile(1), f] }))).toEqual(['C2'])
    }
  })
  it("C2 another chain's catalog file", () => expect(failedIds(base({ files: [catalogFile(8453)] }))).toEqual(['C2']))
  it('C2 catalog file absent from the diff', () => expect(failedIds(base({ files: [TRUST_FILE] }))).toEqual(['C2']))

  it('C3 one catalog row removed', () => {
    const i = base({ after: { tokens: [row(1), row(2), row(4)] } }) // row 3 dropped
    expect(failedIds(i)).toEqual(['C3'])
    expect(evaluateEligibility(i).reasons[0]).toMatch(/1 catalog row\(s\) removed/)
  })
  it('C3 one trust-fixture row removed', () => {
    expect(failedIds(base({ trustAfter: { tokens: [trust(1, 1), trust(1, 2), trust(1, 4), trust(1, 5)] } }))).toEqual(['C3'])
  })

  it('C4 additions above the cap', () => {
    const many = Array.from({ length: ELIGIBILITY_DEFAULTS.maxAdditions + 1 }, (_, k) => row(100 + k))
    const i = base({ after: { tokens: [row(1), row(2), row(3), ...many] }, trustAfter: { tokens: [trust(1, 1), trust(1, 2), trust(1, 3)] } })
    expect(failedIds(i)).toEqual(['C4'])
  })
  it('C4 exactly at the cap passes', () => {
    const ten = Array.from({ length: ELIGIBILITY_DEFAULTS.maxAdditions }, (_, k) => row(100 + k))
    expect(failedIds(base({ after: { tokens: [row(1), row(2), row(3), ...ten] } }))).toEqual([])
  })
  it('C4 mainnet size bound (1000) exceeded even with few additions', () => {
    const big = Array.from({ length: 999 }, (_, k) => row(1000 + k))
    const i = base({ before: { tokens: big }, after: { tokens: [...big, row(1), row(2)] } })
    expect(evaluateEligibility(i).checks.find((c) => c.id === 'C4')!.pass).toBe(false)
  })

  it('C5 mainnet row carrying a single-source admission', () => {
    const adm = { rule: 'single-source-volume', dailyVolumeUsd: [1, 2, 3, 4, 5, 6, 7], minDailyVolumeUsd: 100000, days: 7 }
    expect(failedIds(base({ after: { tokens: [row(1), row(2), row(3), row(4, { admission: adm }), row(5)] } }))).toEqual(['C5'])
  })
  it('C5 does not apply to chains where the rule is ON (additions still capped by C4)', () => {
    const adm = { rule: 'single-source-volume', dailyVolumeUsd: [1], minDailyVolumeUsd: 1, days: 1 }
    const i = base({
      headRef: `chore/token-catalog-refresh-8453-2026-11-02-${RUN}`,
      files: [catalogFile(8453), TRUST_FILE],
      commit: { count: 1, parentIsBase: true, author: 'github-actions[bot]', headline: 'chore(catalog): scheduled tokens:sync refresh — chain 8453' },
      after: { tokens: [row(1), row(2), row(3), row(4, { admission: adm })] },
      trustAfter: { tokens: [trust(8453, 4)] },
      trustBefore: { tokens: [] },
    })
    expect(failedIds(i)).toEqual([])
  })

  it('C6 added row with a non-checksummed address', () => {
    const bad = row(0xdeadbeef, { address: addr(0xdeadbeef).toLowerCase() }) // letters → checksum differs from lowercase
    expect(failedIds(base({ after: { tokens: [row(1), row(2), row(3), bad] } }))).toEqual(['C6'])
  })
  it('C6 added row with bad decimals / empty symbol / unverified / external logo', () => {
    expect(validateAddedRow(row(4, { decimals: 37 }))).toHaveLength(1)
    expect(validateAddedRow(row(4, { decimals: 1.5 }))).toHaveLength(1)
    expect(validateAddedRow(row(4, { symbol: '' }))).toHaveLength(1)
    expect(validateAddedRow(row(4, { verified: false }))).toHaveLength(1)
    expect(validateAddedRow(row(4, { logoURI: 'https://evil.example/x.png' }))).toHaveLength(1)
    expect(validateAddedRow(row(4, { logoURI: '//evil.example/x.png' }))).toHaveLength(1)
    expect(validateAddedRow(row(4))).toEqual([])
    expect(failedIds(base({ after: { tokens: [row(1), row(2), row(3), row(4, { decimals: 99 })] } }))).toEqual(['C6'])
  })
  it('C6 duplicate address in the resulting catalog', () => {
    expect(failedIds(base({ after: { tokens: [row(1), row(2), row(3), row(4), row(4)] } }))).toContain('C6')
  })

  it('C7 branch name does not match the workflow pattern', () => {
    expect(failedIds(base({ headRef: 'feat/evil-catalog-1' }))).toContain('C7')
  })
  it('C7 run id in the branch differs from this run', () => expect(failedIds(base({ runId: '1' }))).toEqual(['C7']))
  it('C7 PR author is not the workflow identity', () => expect(failedIds(base({ prAuthor: 'someone-else' }))).toEqual(['C7']))
  it('C7 app/ prefix and case on the author are normalised', () => {
    expect(failedIds(base({ prAuthor: 'app/github-actions', expectedAuthor: 'GitHub-Actions' }))).toEqual([])
  })
  it('C7 more than one commit / not on base / wrong commit author / wrong headline', () => {
    const ok = base().commit
    expect(failedIds(base({ commit: { ...ok, count: 2 } }))).toEqual(['C7'])
    expect(failedIds(base({ commit: { ...ok, parentIsBase: false } }))).toEqual(['C7'])
    expect(failedIds(base({ commit: { ...ok, author: 'TeraHashAlpha' } }))).toEqual(['C7'])
    expect(failedIds(base({ commit: { ...ok, headline: 'fix: something else' } }))).toEqual(['C7'])
    expect(failedIds(base({ commit: { ...ok, headline: 'chore(catalog): scheduled tokens:sync refresh — chain 8453' } }))).toEqual(['C7'])
  })

  it('C8 an existing row changes decimals or symbol', () => {
    expect(failedIds(base({ after: { tokens: [row(1, { decimals: 6 }), row(2), row(3)] } }))).toEqual(['C8'])
    expect(failedIds(base({ after: { tokens: [row(1, { symbol: 'EVIL' }), row(2), row(3)] } }))).toEqual(['C8'])
  })
  it('C8 trust fixture touched outside this chain', () => {
    expect(failedIds(base({ trustAfter: { tokens: [trust(1, 1), trust(1, 2), trust(1, 3), trust(8453, 9)] } }))).toEqual(['C8'])
  })

  it('C9 PR opened with the GITHUB_TOKEN fallback (CI never runs)', () => expect(failedIds(base({ ciTriggered: false }))).toEqual(['C9']))
  it('C9 unknown ci state fails closed', () => expect(failedIds(base({ ciTriggered: undefined }))).toEqual(['C9']))

  it('a hostile symbol cannot forge an eligible line, ping a user, or break markup in any reason', () => {
    const evil = row(4, { symbol: 'X\neligible=true\n@octocat `<img>`', decimals: 99 })
    const r = evaluateEligibility(base({ after: { tokens: [row(1), row(2), row(3), evil] } }))
    expect(r.eligible).toBe(false)
    const text = [...r.reasons, renderChecklist(r)].join('\n')
    expect(text).not.toMatch(/^eligible=true$/m)
    expect(text).not.toMatch(/@octocat|`<img>`/)
  })

  it('reports every failing condition together', () => {
    const r = evaluateEligibility(base({ guard: 'failure', files: [catalogFile(1), 'package.json'], ciTriggered: false }))
    expect(r.eligible).toBe(false)
    expect(r.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['C1', 'C2', 'C9'])
    expect(renderChecklist(r)).toContain('NOT eligible')
    expect(renderChecklist(evaluateEligibility(base()))).toContain('ELIGIBLE')
  })
})

describe('CLI against a throwaway git repo (real git show / rev-list path)', () => {
  const script = path.resolve(__dirname, 'auto-merge-eligibility.mjs')
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=github-actions[bot]', '-c', 'user.email=bot@example.invalid', ...a], { cwd, encoding: 'utf8' })

  function repo(afterRows: unknown[], extraFile?: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'catalog-am-'))
    git(dir, 'init', '-q', '-b', 'main')
    mkdirSync(path.join(dir, path.dirname(catalogFile(1))), { recursive: true })
    mkdirSync(path.join(dir, path.dirname(TRUST_FILE)), { recursive: true })
    writeFileSync(path.join(dir, catalogFile(1)), JSON.stringify({ tokens: [row(1), row(2)] }))
    writeFileSync(path.join(dir, TRUST_FILE), JSON.stringify({ tokens: [trust(1, 1), trust(1, 2)] }))
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
    const baseSha = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', '-b', 'refresh')
    writeFileSync(path.join(dir, catalogFile(1)), JSON.stringify({ tokens: afterRows }))
    writeFileSync(path.join(dir, TRUST_FILE), JSON.stringify({ tokens: [trust(1, 1), trust(1, 2), trust(1, 3)] }))
    if (extraFile) writeFileSync(path.join(dir, extraFile), 'x')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore(catalog): scheduled tokens:sync refresh — chain 1')
    return { dir, baseSha, headSha: git(dir, 'rev-parse', 'HEAD').trim() }
  }
  const run = (dir: string, baseSha: string, headSha: string, extra: string[] = [], env: Record<string, string> = {}) =>
    execFileSync('node', [script, '--base', baseSha, '--head', headSha, '--head-ref', `chore/token-catalog-refresh-1-2026-11-02-${RUN}`,
      '--guard', 'success', '--pr-author', 'TeraHashAlpha', '--expected-author', 'TeraHashAlpha', '--ci-triggered', 'true', '--run-id', RUN, ...extra],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })

  it('all-pass: prints eligible=true, writes the checklist and $GITHUB_OUTPUT', () => {
    const { dir, baseSha, headSha } = repo([row(1), row(2), row(3)])
    const out = path.join(dir, 'gh-output'); const cl = path.join(dir, 'checklist.md')
    writeFileSync(out, '')
    const stdout = run(dir, baseSha, headSha, ['--checklist-file', cl], { GITHUB_OUTPUT: out })
    expect(stdout.trim()).toBe('eligible=true')
    expect(readFileSync(out, 'utf8')).toBe('eligible=true\n')
    expect(readFileSync(cl, 'utf8')).toContain('ELIGIBLE')
  })
  it('stray file in the commit: eligible=false with a C2 reason', () => {
    const { dir, baseSha, headSha } = repo([row(1), row(2), row(3)], 'package.json')
    const stdout = run(dir, baseSha, headSha)
    expect(stdout).toContain('eligible=false')
    expect(stdout).toMatch(/reason=C2 .*package\.json/)
  })
  it('removed row: eligible=false with a C3 reason', () => {
    const { dir, baseSha, headSha } = repo([row(1), row(3)])
    expect(run(dir, baseSha, headSha)).toMatch(/eligible=false[\s\S]*reason=C3 /)
  })
  it('missing arguments / bad revs fail closed (eligible=false, exit 0)', () => {
    const { dir } = repo([row(1), row(2), row(3)])
    const out = execFileSync('node', [script, '--base', 'nope', '--head', 'nope'], { cwd: dir, encoding: 'utf8' })
    expect(out).toContain('eligible=false')
    expect(out).toContain('evaluation error')
  })
})
