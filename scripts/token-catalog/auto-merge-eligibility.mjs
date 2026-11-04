#!/usr/bin/env node
/**
 * [feat/catalog-auto-merge] Eligibility gate for GitHub native auto-merge of the scheduled
 * token-catalog refresh PRs (.github/workflows/token-catalog-refresh.yml).
 *
 * Owner decision (scoped exception to "owner merges every PR manually"): a refresh PR may merge
 * itself ONLY when EVERY check below passes; otherwise it stays open for human review. The
 * script never merges anything and never touches branch protection — it only prints a verdict.
 *
 *   node scripts/token-catalog/auto-merge-eligibility.mjs --base <rev> --head <rev> \
 *     --head-ref <branch> --guard <success|failure|...> --pr-author <login> \
 *     --expected-author <login> --ci-triggered <true|false> [--run-id <id>] [--checklist-file <path>]
 *
 * stdout: `eligible=true|false` then one `reason=` line per failed check. With $GITHUB_OUTPUT set,
 * `eligible` is also appended there. ALWAYS exits 0 once it has a verdict; any internal error
 * yields `eligible=false` (fail-closed → the PR goes to review, never to auto-merge).
 *
 * Checks (all required):
 *   C1 guard      the refresh job's Guard gate outcome was `success`
 *   C2 files      the diff touches ONLY this chain's catalog JSON (+ the guard trust fixture)
 *   C3 removals   0 catalog rows removed (and 0 trust-fixture rows removed)
 *   C4 additions  added rows <= maxAdditions, and resulting rows <= the chain's size bound
 *   C5 single-src chains where the single-source volume rule is OFF (mainnet) carry no `admission` row
 *   C6 rows       every ADDED row passes address / decimals / symbol validation (mirrors sources.ts)
 *   C7 identity   branch name, run id, PR author, and head-commit shape all match the workflow
 *   C8 existing   [stricter than the brief] no existing row changes address/symbol/decimals;
 *                 trust-fixture changes stay inside this chain
 *   C9 ci         [stricter than the brief] the PR was opened with the PAT, so CI actually runs
 *
 * Plain Node ESM, no dependency beyond `viem` (already a repo dependency, EIP-55 checksum).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { getAddress } from 'viem'

/** The knobs. Mainnet bound mirrors the 987/1000 size bound in src/lib/chains/token-catalog.test.ts
 *  (NOT changed here — this is a guard on top of it, not a second source of truth). */
export const ELIGIBILITY_DEFAULTS = Object.freeze({
  /** Added-rows cap per PR. Last 11 merged refresh PRs: median 5, 9/11 <= 10 (see feedback file). */
  maxAdditions: 10,
  maxRowsByChain: Object.freeze({ 1: 1000 }),
  /** Chains whose singleSource rule is disabled in scripts/token-catalog/lib/config.ts. */
  singleSourceOffChains: Object.freeze([1]),
  branchPattern: /^chore\/token-catalog-refresh-(\d+)-(\d{4}-\d{2}-\d{2})-(\d+)$/,
  commitAuthors: Object.freeze(['github-actions[bot]']),
  commitHeadlinePattern: /^chore\(catalog\): scheduled tokens:sync refresh — chain (\d+)$/,
})

export const TRUST_FILE = 'src/lib/chains/catalog-guard.trust.json'
export const catalogFile = (chainId) => `src/config/generated/token-catalog.${chainId}.json`

const lc = (s) => String(s).toLowerCase()
const normLogin = (s) => lc(String(s ?? '').replace(/^app\//, ''))
const asRows = (doc) => (Array.isArray(doc?.tokens) ? doc.tokens : [])

function isChecksummed(address) {
  if (typeof address !== 'string') return false
  try {
    return getAddress(address) === address
  } catch {
    return false
  }
}

/** Mirrors scripts/token-catalog/lib/sources.ts entryFrom/validDecimals (address, symbol, decimals)
 *  plus the emitted-row invariants the pipeline always satisfies for a NEW row. */
export function validateAddedRow(row) {
  const problems = []
  if (!isChecksummed(row?.address)) problems.push('address is not a valid EIP-55 checksummed address')
  if (typeof row?.symbol !== 'string' || row.symbol.length === 0) problems.push('symbol is empty')
  if (typeof row?.name !== 'string' || row.name.length === 0) problems.push('name is empty')
  if (!Number.isInteger(row?.decimals) || row.decimals < 0 || row.decimals > 36) problems.push('decimals not an integer in 0..36')
  if (row?.verified !== true) problems.push('verified is not true')
  if (typeof row?.logoURI !== 'string' || !row.logoURI.startsWith('/') || row.logoURI.startsWith('//')) {
    problems.push('logoURI is not a same-origin path')
  }
  return problems
}

/** Row symbols/names come from external token lists (attacker-choosable): everything that reaches
 *  stdout, $GITHUB_OUTPUT-adjacent parsing or a PR comment is reduced to a safe printable subset —
 *  no newlines (cannot forge an `eligible=true` line), no `@`/backticks/markup (no pings, no injection). */
export const clean = (s) => String(s ?? '?').replace(/[^\x20-\x7E]/g, '?').replace(/[`@<>|\\[\]]/g, '?').slice(0, 40)

const check = (id, name, pass, detail) => ({ id, name, pass: Boolean(pass), detail })
const short = (rows, n = 5) =>
  rows.slice(0, n).map((r) => `${clean(r.symbol)} ${clean(r.address)}`).join('; ') + (rows.length > n ? `; … +${rows.length - n} more` : '')

/**
 * Pure verdict. `input`:
 *  { guard, ciTriggered, prAuthor, expectedAuthor, headRef, runId?, files: string[],
 *    before: {tokens}, after: {tokens}, trustBefore, trustAfter,
 *    commit: { count, parentIsBase, author, headline } }
 */
export function evaluateEligibility(input, cfg = ELIGIBILITY_DEFAULTS) {
  const checks = []
  const m = cfg.branchPattern.exec(String(input.headRef ?? ''))
  const chainId = m ? Number(m[1]) : NaN

  // C1
  checks.push(check('C1', 'Guard PASS', input.guard === 'success', `gate outcome = ${input.guard ?? 'unknown'}`))

  // C2
  const allowed = Number.isInteger(chainId) ? new Set([catalogFile(chainId), TRUST_FILE]) : new Set()
  const files = Array.isArray(input.files) ? input.files : []
  const stray = files.filter((f) => !allowed.has(f))
  const hasCatalog = Number.isInteger(chainId) && files.includes(catalogFile(chainId))
  checks.push(
    check('C2', 'Diff touches only catalog data files', files.length > 0 && stray.length === 0 && hasCatalog,
      stray.length ? `unexpected files: ${stray.slice(0, 5).map(clean).join(', ')}${stray.length > 5 ? ' …' : ''}` : hasCatalog ? `${files.length} file(s), all catalog data` : 'chain catalog file not in diff'),
  )

  const before = asRows(input.before)
  const after = asRows(input.after)
  const beforeBy = new Map(before.map((r) => [lc(r.address), r]))
  const afterBy = new Map(after.map((r) => [lc(r.address), r]))
  const added = after.filter((r) => !beforeBy.has(lc(r.address)))
  const removed = before.filter((r) => !afterBy.has(lc(r.address)))
  const idChanged = after.filter((r) => {
    const o = beforeBy.get(lc(r.address))
    return o && (o.symbol !== r.symbol || o.decimals !== r.decimals)
  })
  const trustKey = (r) => `${r.chainId}:${lc(r.address)}`
  const tB = new Map(asRows(input.trustBefore).map((r) => [trustKey(r), r]))
  const tA = new Map(asRows(input.trustAfter).map((r) => [trustKey(r), r]))
  const trustRemoved = [...tB.keys()].filter((k) => !tA.has(k))
  const trustOutOfChain = [...tA.entries()]
    .filter(([k, r]) => (!tB.has(k) || JSON.stringify(tB.get(k)) !== JSON.stringify(r)) && r.chainId !== chainId)
    .map(([k]) => k)

  // C3
  checks.push(
    check('C3', 'Removals == 0', removed.length === 0 && trustRemoved.length === 0,
      removed.length || trustRemoved.length
        ? `${removed.length} catalog row(s) removed (${short(removed)}); ${trustRemoved.length} trust row(s) removed`
        : '0 removed'),
  )

  // C4
  const bound = cfg.maxRowsByChain[chainId]
  const overBound = bound !== undefined && after.length > bound
  checks.push(
    check('C4', `Additions <= ${cfg.maxAdditions} and size bound`, added.length <= cfg.maxAdditions && !overBound,
      `+${added.length} added (cap ${cfg.maxAdditions}); ${after.length} rows${bound !== undefined ? ` (bound ${bound})` : ' (no size bound configured)'}`),
  )

  // C5
  const ssRows = cfg.singleSourceOffChains.includes(chainId) ? after.filter((r) => r.admission) : []
  checks.push(
    check('C5', 'No single-source rows where the rule is OFF', ssRows.length === 0,
      cfg.singleSourceOffChains.includes(chainId) ? `${ssRows.length} admission row(s) on chain ${chainId}${ssRows.length ? `: ${short(ssRows)}` : ''}` : `n/a — rule not disabled for chain ${chainId}`),
  )

  // C6
  const seen = new Set()
  const dupes = []
  for (const r of after) {
    const k = lc(r.address)
    if (seen.has(k)) dupes.push(r)
    seen.add(k)
  }
  const bad = added.map((r) => ({ r, p: validateAddedRow(r) })).filter((x) => x.p.length)
  checks.push(
    check('C6', 'Added rows pass validation', bad.length === 0 && dupes.length === 0,
      bad.length || dupes.length
        ? `${bad.length} invalid added row(s)${bad[0] ? ` (${clean(bad[0].r.symbol)}: ${bad[0].p.join(', ')})` : ''}; ${dupes.length} duplicate address(es)`
        : `${added.length} added row(s) valid`),
  )

  // C7
  const c = input.commit ?? {}
  const hm = cfg.commitHeadlinePattern.exec(String(c.headline ?? ''))
  const idProblems = []
  if (!m) idProblems.push('branch name does not match the workflow pattern')
  if (m && input.runId !== undefined && input.runId !== null && String(input.runId) !== m[3]) idProblems.push(`branch run id ${m[3]} != this run ${input.runId}`)
  if (!input.expectedAuthor || normLogin(input.prAuthor) !== normLogin(input.expectedAuthor)) idProblems.push(`PR author "${clean(input.prAuthor)}" != workflow identity "${clean(input.expectedAuthor)}"`)
  if (c.count !== 1) idProblems.push(`head branch has ${c.count} commit(s), expected exactly 1`)
  if (c.parentIsBase !== true) idProblems.push('head commit is not directly on the base')
  if (!cfg.commitAuthors.includes(c.author)) idProblems.push(`commit author "${clean(c.author)}" not in [${cfg.commitAuthors.join(', ')}]`)
  if (!hm || Number(hm[1]) !== chainId) idProblems.push('commit headline does not match the workflow message for this chain')
  checks.push(check('C7', 'PR identity matches the workflow', idProblems.length === 0, idProblems.join('; ') || 'branch, run id, author and commit shape match'))

  // C8
  checks.push(
    check('C8', 'Existing rows keep identity; trust change scoped to chain', idChanged.length === 0 && trustOutOfChain.length === 0,
      idChanged.length || trustOutOfChain.length
        ? `${idChanged.length} existing row(s) changed symbol/decimals (${short(idChanged)}); ${trustOutOfChain.length} trust row(s) outside chain ${chainId}`
        : 'no symbol/decimals changes on existing rows; trust rows only for this chain'),
  )

  // C9
  checks.push(check('C9', 'PR opened with the PAT (CI runs)', input.ciTriggered === true, input.ciTriggered === true ? 'CATALOG_PR_TOKEN path' : 'GITHUB_TOKEN fallback — CI never starts, auto-merge would wait forever'))

  const failed = checks.filter((x) => !x.pass)
  return {
    eligible: failed.length === 0,
    chainId,
    stats: { added: added.length, removed: removed.length, rows: after.length },
    checks,
    reasons: failed.map((x) => `${x.id} ${x.name}: ${x.detail}`),
  }
}

export function renderChecklist(result) {
  const lines = result.checks.map((x) => `- [${x.pass ? 'x' : ' '}] **${x.id}** ${x.name} — ${x.detail}`)
  return [
    result.eligible ? '**Catalog auto-merge: ELIGIBLE** — all checks passed.' : '**Catalog auto-merge: NOT eligible — needs human review** (label `catalog-review`).',
    '',
    ...lines,
  ].join('\n')
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function showJson(rev, file) {
  try {
    return JSON.parse(git('show', `${rev}:${file}`))
  } catch {
    return null // file absent at that rev (new chain) — treated as empty
  }
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${a}`)
    out[a.slice(2)] = v
    i++
  }
  return out
}

export function gatherFromGit(args) {
  const { base, head } = args
  const m = ELIGIBILITY_DEFAULTS.branchPattern.exec(args['head-ref'] ?? '')
  const chainId = m ? Number(m[1]) : NaN
  const files = git('diff', '--name-only', `${base}`, `${head}`).split('\n').map((s) => s.trim()).filter(Boolean)
  const count = Number(git('rev-list', '--count', `${base}..${head}`).trim())
  const parents = git('rev-list', '--parents', '-n', '1', head).trim().split(' ').slice(1)
  const baseSha = git('rev-parse', base).trim()
  return {
    guard: args.guard,
    ciTriggered: args['ci-triggered'] === 'true',
    prAuthor: args['pr-author'],
    expectedAuthor: args['expected-author'],
    headRef: args['head-ref'],
    runId: args['run-id'],
    files,
    before: Number.isInteger(chainId) ? showJson(base, catalogFile(chainId)) : null,
    after: Number.isInteger(chainId) ? showJson(head, catalogFile(chainId)) : null,
    trustBefore: showJson(base, TRUST_FILE),
    trustAfter: showJson(head, TRUST_FILE),
    commit: {
      count,
      parentIsBase: parents.length === 1 && parents[0] === baseSha,
      author: git('log', '-1', '--format=%an', head).trim(),
      headline: git('log', '-1', '--format=%s', head).trim(),
    },
  }
}

function main() {
  let result
  let args = {}
  try {
    args = parseArgs(process.argv.slice(2))
    for (const k of ['base', 'head', 'head-ref', 'guard', 'pr-author', 'expected-author', 'ci-triggered']) {
      if (args[k] === undefined) throw new Error(`missing required --${k}`)
    }
    result = evaluateEligibility(gatherFromGit(args))
  } catch (err) {
    // Fail closed: an evaluation error is a "needs review", never an auto-merge.
    const msg = `evaluation error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    result = { eligible: false, chainId: NaN, stats: { added: 0, removed: 0, rows: 0 }, checks: [check('C0', 'Eligibility evaluation', false, msg)], reasons: [msg] }
  }
  const lines = [`eligible=${result.eligible}`, ...result.reasons.map((r) => `reason=${r}`)]
  console.log(lines.join('\n'))
  if (args['checklist-file']) writeFileSync(args['checklist-file'], `${renderChecklist(result)}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${result.eligible}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
