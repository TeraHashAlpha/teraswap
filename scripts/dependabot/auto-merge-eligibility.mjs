#!/usr/bin/env node
/**
 * [feat/dependabot-auto-merge] Eligibility gate for GitHub native auto-merge of Dependabot PRs
 * (.github/workflows/dependabot-auto-merge.yml).
 *
 * Owner decision (scoped exception to "owner merges every PR manually"): a Dependabot PR may merge
 * itself ONLY when EVERY rule below holds; otherwise it stays open with the `deps-review` label.
 * The script never merges anything and never touches branch protection — it only prints a verdict.
 *
 *   node scripts/dependabot/auto-merge-eligibility.mjs --input <facts.json> [--auto-merge on|off]
 *
 * facts.json (assembled by the workflow from GitHub metadata only — PR code is never checked out):
 *   { prAuthor: string,
 *     commitAuthors: string[],              // REST `commit.author.login` of every commit in the PR
 *     files: string[],                      // every path the PR changes
 *     updatedDependencies: [{ dependencyName, dependencyType, updateType, directory, packageEcosystem }] }
 *                                           // = dependabot/fetch-metadata `updated-dependencies-json`
 *
 * stdout: `eligible=true|false` then `reason=<one sanitised line>`. With $GITHUB_OUTPUT set both are
 * also appended there. ALWAYS exits 0 once it has a verdict; any internal error yields
 * `eligible=false` (fail-closed → the PR goes to review, never to auto-merge).
 *
 * Rules (all required):
 *   R1 author     PR author AND every commit author is `dependabot[bot]`; fetch-metadata returned >= 1 dep
 *   R2 semver     every dependency is semver-patch or semver-minor (any major / unknown → review)
 *   R3 scope      ecosystem npm or github-actions, directory "/" only, and the PR touches only that
 *                 ecosystem's files (package.json + package-lock.json | .github/workflows|actions/*.yml);
 *                 anything under contracts/** (keeper lockfile) → review
 *   R4 deny-list  no deny-listed package; npm deps must be devDependencies. Whether a runtime
 *                 `dependencies` bump changes a lockfile entry used by src/app/api/** is NOT reliably
 *                 computable without checking out PR code, so ALL runtime/indirect npm deps → review
 *                 (owner's stated fallback: auto-merge only devDependencies + github-actions)
 *   R5 group      a grouped PR is eligible only if EVERY package in it is (the verdict is an AND)
 *   R6 kill switch repository variable DEPS_AUTO_MERGE must be exactly `on` (unset/off → no auto-merge)
 *
 * Plain Node ESM, zero dependencies (the workflow runs it without `npm ci`).
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const BOT = 'dependabot[bot]'

/** Always-review packages (lower-case). Scope prefixes end with `/`. */
export const DENY_EXACT = Object.freeze([
  'viem', 'wagmi', 'next', 'react', 'react-dom', 'ethers', '@tanstack/react-query', 'zod',
])
export const DENY_SCOPES = Object.freeze([
  '@wagmi/', '@rainbow-me/', '@walletconnect/', '@supabase/', '@aws-sdk/',
])

export const ALLOWED_UPDATE_TYPES = Object.freeze([
  'version-update:semver-patch', 'version-update:semver-minor',
])

const NPM_FILES = Object.freeze(['package.json', 'package-lock.json'])
const ACTIONS_FILE = /^\.github\/(workflows|actions)\/.+\.ya?ml$/

const lc = (s) => String(s ?? '').toLowerCase()

/** fetch-metadata reports `chunks[1]` of the branch name: npm_and_yarn / github_actions. */
export function normalizeEcosystem(raw) {
  const e = lc(raw).replace(/_/g, '-')
  if (e === 'npm' || e === 'npm-and-yarn') return 'npm'
  if (e === 'github-actions') return 'github-actions'
  return e
}

export function isDenied(name) {
  const n = lc(name)
  return DENY_EXACT.includes(n) || DENY_SCOPES.some((s) => n.startsWith(s))
}

/** Reasons end up in a PR comment and a workflow log line: keep a conservative charset, one line. */
export function sanitize(text, max = 300) {
  const s = String(text).replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 .,:;()/@_=+[\]-]/g, '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const list = (names) => (names.length > 6 ? `${names.slice(0, 6).join(', ')} +${names.length - 6} more` : names.join(', '))

/**
 * Pure verdict. `facts` is the JSON described above; `autoMerge` is the DEPS_AUTO_MERGE variable.
 * Returns { eligible, reasons: string[], rules: [{ id, ok, detail }] }.
 */
export function evaluateEligibility(facts, { autoMerge = '' } = {}) {
  const deps = Array.isArray(facts?.updatedDependencies) ? facts.updatedDependencies : []
  const files = Array.isArray(facts?.files) ? facts.files.map(String) : []
  const commitAuthors = Array.isArray(facts?.commitAuthors) ? facts.commitAuthors.map(String) : []
  const rules = []
  const rule = (id, ok, detail) => rules.push({ id, ok, detail: ok ? '' : detail })

  // R1 — identity
  const badCommits = commitAuthors.filter((a) => a !== BOT).length
  if (facts?.prAuthor !== BOT) rule('R1', false, `PR author is not ${BOT}`)
  else if (commitAuthors.length === 0) rule('R1', false, 'no commit authors reported')
  else if (badCommits > 0) rule('R1', false, `${badCommits} commit(s) not authored by ${BOT}`)
  else if (deps.length === 0) rule('R1', false, 'no dependabot metadata (fetch-metadata found no updated dependencies)')
  else rule('R1', true)

  // R2 — update type (per dependency; a group needs all of them)
  const badType = deps.filter((d) => !ALLOWED_UPDATE_TYPES.includes(d?.updateType))
  rule('R2', deps.length > 0 && badType.length === 0,
    `not patch/minor: ${list(badType.map((d) => `${d?.dependencyName} (${String(d?.updateType ?? 'unknown').replace('version-update:semver-', '')})`))}`)

  // R3 — ecosystem, directory, files
  const ecos = [...new Set(deps.map((d) => normalizeEcosystem(d?.packageEcosystem)))]
  const badDir = deps.filter((d) => d?.directory !== '/')
  const underContracts = files.filter((f) => f === 'contracts' || f.startsWith('contracts/'))
  const eco = ecos.length === 1 ? ecos[0] : ''
  let r3 = ''
  if (deps.length === 0) r3 = 'no dependencies to scope'
  else if (ecos.length !== 1 || !['npm', 'github-actions'].includes(eco)) r3 = `ecosystem not npm/github-actions: ${list(ecos)}`
  else if (badDir.length > 0) r3 = `not the root project (directory ${list([...new Set(badDir.map((d) => String(d?.directory)))])})`
  else if (underContracts.length > 0) r3 = `touches contracts/** (${list(underContracts)})`
  else if (files.length === 0) r3 = 'PR changes no files'
  else {
    const stray = files.filter((f) => (eco === 'npm' ? !NPM_FILES.includes(f) : !ACTIONS_FILE.test(f)))
    if (stray.length > 0) r3 = `touches files outside the ${eco} manifest set: ${list(stray)}`
  }
  rule('R3', r3 === '', r3)

  // R4 — deny-list + runtime split
  const denied = deps.filter((d) => isDenied(d?.dependencyName)).map((d) => String(d?.dependencyName))
  const runtime = eco === 'npm'
    ? deps.filter((d) => d?.dependencyType !== 'direct:development' && !isDenied(d?.dependencyName)).map((d) => String(d?.dependencyName))
    : []
  let r4 = ''
  if (denied.length > 0) r4 = `deny-listed: ${list(denied)}`
  else if (runtime.length > 0) r4 = `runtime/indirect npm dependency (src/app/api usage not computable): ${list(runtime)}`
  rule('R4', r4 === '', r4)

  // R5 — group is an AND of the above; add the group-level note so the comment names the cause
  const perDepBad = new Set([...badType, ...deps.filter((d) => isDenied(d?.dependencyName))].map((d) => d?.dependencyName))
  for (const d of runtime) perDepBad.add(d)
  rule('R5', deps.length <= 1 || perDepBad.size === 0,
    `grouped PR: ${perDepBad.size} of ${deps.length} packages ineligible (${list([...perDepBad].map(String))})`)

  // R6 — kill switch
  rule('R6', autoMerge === 'on', `kill switch DEPS_AUTO_MERGE is "${autoMerge || 'unset'}" (needs on)`)

  const reasons = rules.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`)
  return { eligible: reasons.length === 0, reasons, rules }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1 }
  }
  return out
}

function emit(eligible, reason) {
  const lines = [`eligible=${eligible}`, `reason=${sanitize(reason)}`]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv)
    if (!args.input) throw new Error('--input <facts.json> is required')
    const facts = JSON.parse(readFileSync(args.input, 'utf8'))
    const v = evaluateEligibility(facts, { autoMerge: args['auto-merge'] ?? '' })
    emit(v.eligible, v.eligible ? 'all rules passed' : v.reasons.join(' | '))
  } catch (err) {
    // Fail closed: any crash is a review verdict, never an auto-merge.
    emit(false, `eligibility script error (fail-closed): ${err instanceof Error ? err.message : err}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
