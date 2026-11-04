/**
 * [feat/dependabot-auto-merge] One all-pass fixture + one failing fixture per rule (R1–R6), the
 * grouped-PR AND, the CLI (incl. fail-closed on bad input), and static assertions that pin the
 * workflow's safety model (SHA-pinned actions, write scopes only on `act`, no PR-head checkout).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  ALLOWED_UPDATE_TYPES,
  BOT,
  DENY_EXACT,
  DENY_SCOPES,
  evaluateEligibility,
  isDenied,
  normalizeEcosystem,
  sanitize,
} from './auto-merge-eligibility.mjs'

type Dep = Record<string, unknown>
const dev = (name: string, over: Dep = {}): Dep => ({
  dependencyName: name,
  dependencyType: 'direct:development',
  updateType: 'version-update:semver-minor',
  directory: '/',
  packageEcosystem: 'npm_and_yarn',
  prevVersion: '3.2.1',
  newVersion: '3.3.0',
  ...over,
})
const action = (name: string, over: Dep = {}): Dep => ({
  dependencyName: name,
  dependencyType: 'direct:production', // fetch-metadata reports GitHub Actions as production deps
  updateType: 'version-update:semver-patch',
  directory: '/',
  packageEcosystem: 'github_actions',
  prevVersion: '4.1.0',
  newVersion: '4.1.1',
  ...over,
})
const npmFacts = (deps: Dep[] = [dev('vitest')], over: Record<string, unknown> = {}) => ({
  prAuthor: BOT,
  commitAuthors: [BOT],
  files: ['package.json', 'package-lock.json'],
  updatedDependencies: deps,
  ...over,
})
const actionsFacts = (deps: Dep[] = [action('actions/checkout')], over: Record<string, unknown> = {}) => ({
  prAuthor: BOT,
  commitAuthors: [BOT],
  files: ['.github/workflows/ci.yml', '.github/workflows/codeql.yml'],
  updatedDependencies: deps,
  ...over,
})
const ON = { autoMerge: 'on' }
const failing = (facts: unknown, opts = ON) => evaluateEligibility(facts, opts).rules.filter((r) => !r.ok).map((r) => r.id)

describe('all-pass fixtures', () => {
  it('npm devDependency minor/patch → eligible', () => {
    const v = evaluateEligibility(npmFacts([dev('vitest'), dev('eslint', { updateType: 'version-update:semver-patch' })]), ON)
    expect(v.eligible).toBe(true)
    expect(v.reasons).toEqual([])
  })
  it('github-actions group (direct:production is fine for actions) → eligible', () => {
    expect(evaluateEligibility(actionsFacts(), ON).eligible).toBe(true)
  })
})

describe('R1 author', () => {
  it('human PR author', () => expect(failing(npmFacts([dev('vitest')], { prAuthor: 'TeraHashAlpha' }))).toEqual(['R1']))
  it('any non-bot commit on the branch', () =>
    expect(failing(npmFacts([dev('vitest')], { commitAuthors: [BOT, 'someone-else'] }))).toEqual(['R1']))
  it('null commit author (unlinked identity)', () =>
    expect(failing(npmFacts([dev('vitest')], { commitAuthors: ['null'] }))).toEqual(['R1']))
  it('no commits reported', () => expect(failing(npmFacts([dev('vitest')], { commitAuthors: [] }))).toEqual(['R1']))
  it('fetch-metadata found nothing', () => expect(failing(npmFacts([]))).toContain('R1'))
})

describe('R2 update type', () => {
  it('major → review', () =>
    expect(failing(npmFacts([dev('vitest', { updateType: 'version-update:semver-major' })]))).toEqual(['R2']))
  it('unknown / missing type → review', () => {
    expect(failing(npmFacts([dev('vitest', { updateType: undefined })]))).toEqual(['R2'])
    expect(failing(npmFacts([dev('vitest', { updateType: 'version-update:semver-prerelease' })]))).toEqual(['R2'])
  })
  const zero = (over: Dep = {}) => dev('some-lib', { updateType: 'version-update:semver-minor', prevVersion: '0.12.3', newVersion: '0.13.0', ...over })
  it('0.x minor counts as major → review', () => {
    const v = evaluateEligibility(npmFacts([zero()]), ON)
    expect(v.rules.filter((r) => !r.ok).map((r) => r.id)).toEqual(['R2'])
    expect(v.reasons[0]).toMatch(/some-lib \(0\.x minor\)/)
  })
  it('0.x minor with a leading v (actions) → review', () =>
    expect(failing(actionsFacts([action('acme/act', { updateType: 'version-update:semver-minor', prevVersion: 'v0.4.0', newVersion: 'v0.5.0' })]))).toEqual(['R2']))
  it('0.x patch is still fine; 1.x+ minor is still fine', () => {
    expect(evaluateEligibility(npmFacts([zero({ updateType: 'version-update:semver-patch', newVersion: '0.12.4' })]), ON).eligible).toBe(true)
    expect(evaluateEligibility(npmFacts([zero({ prevVersion: '1.0.0', newVersion: '1.1.0' })]), ON).eligible).toBe(true)
    expect(evaluateEligibility(npmFacts([zero({ prevVersion: '10.0.3', newVersion: '10.1.0' })]), ON).eligible).toBe(true)
  })
  it('minor with missing / unparseable previous version → review (fail-closed)', () => {
    for (const prevVersion of [undefined, '', 'abc123def', 'latest']) expect(failing(npmFacts([zero({ prevVersion })]))).toEqual(['R2'])
  })
  it('0.x minor inside a group blocks the whole group', () => {
    const v = evaluateEligibility(npmFacts([dev('vitest'), zero()]), ON)
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/grouped PR: 1 of 2.*some-lib/)
  })
  it('allowed set is exactly patch + minor', () =>
    expect([...ALLOWED_UPDATE_TYPES]).toEqual(['version-update:semver-patch', 'version-update:semver-minor']))
})

describe('R3 scope', () => {
  it('contracts keeper lockfile (directory + files) → review', () => {
    const v = evaluateEligibility(
      npmFacts([dev('hardhat', { directory: '/contracts/order-engine' })], {
        files: ['contracts/order-engine/package.json', 'contracts/order-engine/package-lock.json'],
      }), ON)
    expect(v.rules.filter((r) => !r.ok).map((r) => r.id)).toEqual(['R3'])
    expect(v.reasons[0]).toMatch(/root project/)
  })
  it('directory "/" but a contracts/** file sneaks in → review', () =>
    expect(failing(npmFacts([dev('vitest')], { files: ['package.json', 'package-lock.json', 'contracts/order-engine/package.json'] }))).toEqual(['R3']))
  it('other ecosystem (pip / docker) → review', () =>
    expect(failing(npmFacts([dev('requests', { packageEcosystem: 'pip' })]))).toEqual(['R3']))
  it('npm PR touching app code → review', () =>
    expect(failing(npmFacts([dev('vitest')], { files: ['package.json', 'package-lock.json', 'src/app/api/quote/route.ts'] }))).toEqual(['R3']))
  it('actions PR touching a non-workflow file → review', () =>
    expect(failing(actionsFacts([action('actions/checkout')], { files: ['.github/workflows/ci.yml', 'package.json'] }))).toEqual(['R3']))
  it('PR with no files / mixed ecosystems → review', () => {
    expect(failing(npmFacts([dev('vitest')], { files: [] }))).toEqual(['R3'])
    expect(failing(npmFacts([dev('vitest'), action('actions/checkout')]))).toContain('R3')
  })
  it('normalises fetch-metadata ecosystem names', () => {
    expect(normalizeEcosystem('npm_and_yarn')).toBe('npm')
    expect(normalizeEcosystem('github_actions')).toBe('github-actions')
  })
})

describe('R4 deny-list + runtime split', () => {
  const denied = ['viem', 'wagmi', 'eslint-config-next', '@wagmi/core', '@wagmi/connectors', '@rainbow-me/rainbowkit', 'next', 'react', 'react-dom',
    'ethers', '@tanstack/react-query', '@walletconnect/ethereum-provider', '@supabase/supabase-js', '@aws-sdk/client-s3', 'zod']
  for (const name of denied) {
    it(`deny-listed ${name} → review even as a devDependency patch`, () => {
      expect(isDenied(name)).toBe(true)
      expect(failing(npmFacts([dev(name, { updateType: 'version-update:semver-patch' })]))).toEqual(['R4'])
    })
  }
  it('deny-list is case-insensitive and does not over-match', () => {
    expect(isDenied('Viem')).toBe(true)
    expect(isDenied('viem-extras-not-denied')).toBe(false)
    expect(isDenied('nextjs-toploader')).toBe(false)
    expect(isDenied('@supabase')).toBe(false)
  })
  it('lists cover the brief verbatim', () => {
    expect([...DENY_EXACT].sort()).toEqual(['@tanstack/react-query', 'eslint-config-next', 'ethers', 'next', 'react', 'react-dom', 'viem', 'wagmi', 'zod'])
    expect([...DENY_SCOPES].sort()).toEqual(['@aws-sdk/', '@rainbow-me/', '@supabase/', '@wagmi/', '@walletconnect/'])
  })
  it('runtime `dependencies` bump (not deny-listed) → review: src/app/api usage not computable', () => {
    const v = evaluateEligibility(npmFacts([dev('@upstash/redis', { dependencyType: 'direct:production' })]), ON)
    expect(v.rules.filter((r) => !r.ok).map((r) => r.id)).toEqual(['R4'])
    expect(v.reasons[0]).toMatch(/not computable/)
  })
  it('indirect (transitive) npm dependency → review', () =>
    expect(failing(npmFacts([dev('follow-redirects', { dependencyType: 'indirect' })]))).toEqual(['R4']))
  it('a github-actions dep is never deny-listed by type', () =>
    expect(evaluateEligibility(actionsFacts([action('actions/setup-node')]), ON).eligible).toBe(true))
})

describe('R5 grouped PRs', () => {
  it('every package eligible → eligible', () =>
    expect(evaluateEligibility(npmFacts([dev('vitest'), dev('jsdom'), dev('typescript', { updateType: 'version-update:semver-patch' })]), ON).eligible).toBe(true))
  it('one major in the group → whole PR review, naming the package', () => {
    const v = evaluateEligibility(npmFacts([dev('vitest'), dev('jsdom', { updateType: 'version-update:semver-major' })]), ON)
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/grouped PR: 1 of 2.*jsdom/)
  })
  it('one deny-listed or runtime member in the group → whole PR review', () => {
    expect(evaluateEligibility(npmFacts([dev('vitest'), dev('viem')]), ON).eligible).toBe(false)
    expect(evaluateEligibility(npmFacts([dev('vitest'), dev('@upstash/redis', { dependencyType: 'direct:production' })]), ON).eligible).toBe(false)
  })
  it('actions group with one major → review', () =>
    expect(evaluateEligibility(actionsFacts([action('actions/checkout'), action('actions/cache', { updateType: 'version-update:semver-major' })]), ON).eligible).toBe(false))
})

describe('R6 kill switch', () => {
  it('unset → never eligible (default off)', () => expect(failing(npmFacts(), { autoMerge: '' })).toEqual(['R6']))
  it('off → not eligible', () => expect(failing(npmFacts(), { autoMerge: 'off' })).toEqual(['R6']))
  it('only the exact value "on" enables it', () => {
    for (const v of ['ON', 'true', '1', 'yes', ' on']) expect(failing(npmFacts(), { autoMerge: v })).toEqual(['R6'])
    expect(failing(npmFacts(), { autoMerge: 'on' })).toEqual([])
  })
})

describe('sanitize', () => {
  it('single line, safe charset, bounded', () => {
    const out = sanitize('a\n<!-- x --> `y` $(z) b')
    expect(out).toBe('a -- x -- y (z) b')
    expect(out).not.toMatch(/[<>`$!\n]/) // no HTML comment, backtick, or shell-expansion characters survive
    expect(sanitize('x'.repeat(500)).length).toBeLessThanOrEqual(300)
  })
})

describe('CLI', () => {
  const script = path.join(__dirname, 'auto-merge-eligibility.mjs')
  const run = (facts: unknown, autoMerge: string, raw?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deps-am-'))
    const input = path.join(dir, 'facts.json')
    const out = path.join(dir, 'gh-output')
    writeFileSync(input, raw ?? JSON.stringify(facts))
    writeFileSync(out, '')
    const stdout = execFileSync('node', [script, '--input', input, '--auto-merge', autoMerge], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    })
    return { stdout, ghOutput: readFileSync(out, 'utf8') }
  }
  it('prints the verdict and writes it to $GITHUB_OUTPUT', () => {
    const ok = run(npmFacts(), 'on')
    expect(ok.stdout).toBe('eligible=true\nreason=all rules passed\n')
    expect(ok.ghOutput).toBe(ok.stdout)
    const no = run(npmFacts([dev('viem')]), 'on')
    expect(no.stdout.split('\n')[0]).toBe('eligible=false')
    expect(no.stdout).toMatch(/reason=R4: deny-listed: viem/)
  })
  it('fails closed (exit 0, eligible=false) on malformed JSON or a missing --input', () => {
    expect(run(null, 'on', '{not json').stdout).toMatch(/^eligible=false\nreason=eligibility script error \(fail-closed\)/)
    const noArgs = execFileSync('node', [script], { encoding: 'utf8' })
    expect(noArgs).toMatch(/^eligible=false/)
  })
  it('empty facts object is not eligible', () => expect(run({}, 'on').stdout.split('\n')[0]).toBe('eligible=false'))
})

describe('workflow safety model (static)', () => {
  const wf = readFileSync(path.join(__dirname, '../../.github/workflows/dependabot-auto-merge.yml'), 'utf8')
  const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  it('triggers on pull_request_target only, limited to dependabot[bot], gated by the kill switch', () => {
    expect(code).toMatch(/^on:\n\s+pull_request_target:/m)
    expect(code).not.toMatch(/^\s+(pull_request|push|workflow_run|schedule):/m)
    expect(code).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(code).toContain("vars.DEPS_AUTO_MERGE == 'on'")
  })
  it('every action is pinned by 40-hex SHA', () => {
    const uses = [...code.matchAll(/^\s+uses:\s*(\S+)/gm)].map((m) => m[1])
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
    expect(uses.some((u) => u.startsWith('dependabot/fetch-metadata@'))).toBe(true)
  })
  it('never checks out the PR head and never installs/runs PR code', () => {
    expect(code).toContain('ref: ${{ github.event.pull_request.base.sha }}')
    expect(code).not.toMatch(/github\.head_ref|pull_request\.head\.ref|refs\/pull\//)
    expect(code).not.toMatch(/npm (ci|install|run)|npx |yarn |pnpm /)
  })
  it('write scopes are declared only on the `act` job; top level grants nothing', () => {
    expect(code).toMatch(/^permissions: \{\}$/m)
    const [beforeAct, actJob] = code.split(/^  act:$/m)
    expect(actJob).toBeDefined()
    expect(beforeAct).not.toMatch(/:\s*write/)
    expect(actJob).toMatch(/contents: write/)
    expect(actJob).toMatch(/pull-requests: write/)
    expect(actJob).not.toMatch(/uses:/) // no third-party action runs with the write token
  })
  it('PR-derived values reach run: only through env, never ${{ }} interpolation', () => {
    const runBlocks = code.split(/^\s+run: \|$/m).slice(1)
    expect(runBlocks.length).toBe(2)
    for (const b of runBlocks) expect(b.split(/^\s+- name:/m)[0]).not.toMatch(/\$\{\{/)
  })
  it('never bypasses protection: no --admin, no direct merge', () => {
    expect(code).not.toMatch(/--admin/)
    expect(code).toMatch(/gh pr merge .* --auto --squash --match-head-commit/)
  })
})
