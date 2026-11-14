#!/usr/bin/env node
/**
 * Generates the "state" block of CLAUDE.md from repo content only, so the facts an agent reads first
 * cannot rot silently.
 *
 *   node scripts/gen-claude-state.mjs --check   exit 1 when the committed block differs from the generated one
 *   node scripts/gen-claude-state.mjs --write   rewrite the block in CLAUDE.md
 *   node scripts/gen-claude-state.mjs --print   print the generated block (touches nothing)
 *   node scripts/gen-claude-state.mjs --counts  print the test-file counts to stdout (touches nothing)
 *
 * The block sits between `<!-- state:begin -->` and `<!-- state:end -->`. It is DETERMINISTIC: no date, no
 * commit sha, no network, no clock — the same files in produce the same bytes out, on any machine.
 *
 * Sources (all read from the working tree):
 *   - docs/DEPLOYMENTS.md      the "## Contracts" table: role, chain, address (copied, never typed)
 *   - .github/workflows/*.yml  the top-level `name:` of each workflow
 *   - docs/ADR/ADR-NNN-*.md    count, id range, and the latest ADR's Status
 *   - test suites              how to run vitest / keeper node:test / Foundry and where each config lives (NO counts:
 *                              a count changes on every PR that adds a test file, so two open PRs always conflicted on
 *                              that line; counts are `--counts` stdout only, never a tracked file)
 *
 * CLAUDE.md changes its sha256, which AGENTS.md pins: after `--write`, run
 *   node scripts/check-agents-parity.mjs --write
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BEGIN = '<!-- state:begin -->'
export const END = '<!-- state:end -->'

// Never descend into these. Under contracts/ Foundry also writes `out/` and `cache/` and vendors `lib/`.
const SKIP_ALWAYS = new Set(['node_modules', '.git', '.next', '.claude', 'coverage', 'dist'])
const SKIP_UNDER_CONTRACTS = new Set(['out', 'cache', 'lib'])

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function fail(message) {
  console.error(`gen-claude-state: ${message}`)
  process.exit(1)
}

function read(rel) {
  const abs = path.join(ROOT, rel)
  if (!existsSync(abs)) fail(`${rel} not found`)
  return readFileSync(abs, 'utf8')
}

/** All files under `rel` (posix-style relative paths), skipping build and vendor directories. */
function walk(rel = '') {
  const abs = path.join(ROOT, rel)
  if (!existsSync(abs)) return []
  const out = []
  for (const name of readdirSync(abs).sort(byCodeUnit)) {
    if (SKIP_ALWAYS.has(name)) continue
    if ((rel === 'contracts' || rel.startsWith('contracts/')) && SKIP_UNDER_CONTRACTS.has(name)) continue
    const childRel = rel ? `${rel}/${name}` : name
    if (statSync(path.join(ROOT, childRel)).isDirectory()) out.push(...walk(childRel))
    else out.push(childRel)
  }
  return out
}

/** Glob → RegExp for the subset vitest.config.ts uses: `**`, `*`, literals. */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// ── Contracts ────────────────────────────────────────────────────────────────────────────────────────
export function parseDeployments(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^##\s+Contracts\s*$/.test(l))
  if (start === -1) fail('docs/DEPLOYMENTS.md has no "## Contracts" heading')
  const rows = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) break
    if (!line.startsWith('|')) {
      if (rows.length > 0 && line.trim() === '') break
      continue
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    if (/^role$/i.test(cells[0]) || /^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue
    const role = cells[0].replace(/\*\*/g, '').replace(/⚠️/g, '').replace(/\s+/g, ' ').trim()
    rows.push({ role, chain: cells[1], address: cells[2] })
  }
  if (rows.length === 0) fail('docs/DEPLOYMENTS.md "## Contracts" table has no rows')
  return rows
}

// ── Workflows ────────────────────────────────────────────────────────────────────────────────────────
export function workflowNames() {
  const dir = '.github/workflows'
  if (!existsSync(path.join(ROOT, dir))) fail(`${dir} not found`)
  const files = readdirSync(path.join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f)).sort(byCodeUnit)
  if (files.length === 0) fail(`${dir} has no workflow files`)
  return files.map((file) => {
    const m = read(`${dir}/${file}`).match(/^name:\s*(.+?)\s*$/m)
    const name = m ? m[1].replace(/^["']|["']$/g, '') : file.replace(/\.ya?ml$/, '')
    return { file, name }
  })
}

// ── ADRs ─────────────────────────────────────────────────────────────────────────────────────────────
export function adrSummary() {
  const dir = 'docs/ADR'
  if (!existsSync(path.join(ROOT, dir))) fail(`${dir} not found`)
  const adrs = readdirSync(path.join(ROOT, dir))
    .map((f) => f.match(/^ADR-(\d{3})-(.+)\.md$/))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), id: `ADR-${m[1]}`, file: m[0] }))
    .sort((a, b) => a.n - b.n)
  if (adrs.length === 0) fail(`${dir} has no ADR-NNN-*.md files`)
  const latest = adrs[adrs.length - 1]
  const text = read(`${dir}/${latest.file}`)
  const sm = text.match(/^\s*(?:-\s*)?\*\*Status:\*\*\s*(.+)$/m)
  const status = sm ? sm[1].split(/\s+[—–(;]|\.\s|\s*$/)[0].replace(/\*+/g, '').trim() : 'no Status line'
  return { count: adrs.length, first: adrs[0].id, last: latest.id, latestFile: latest.file.replace(/\.md$/, ''), status }
}

// ── Test files ───────────────────────────────────────────────────────────────────────────────────────
export function vitestIncludes() {
  // Line comments first: the config's own comments contain `[TAGS]`, which would end the array match early.
  // (Not block comments: the glob `src/**/*.test.ts` itself contains `/**/`.)
  const cfg = read('vitest.config.ts').replace(/(^|\s)\/\/.*$/gm, '$1')
  const m = cfg.match(/\binclude:\s*\[([\s\S]*?)\]/)
  if (!m) fail('vitest.config.ts has no `include: [...]`')
  const globs = [...m[1].matchAll(/(['"`])((?:(?!\1).)+)\1/g)].map((x) => x[2])
  if (globs.length === 0) fail('vitest.config.ts `include` lists no globs')
  return globs
}

export function testFileCounts() {
  const all = walk()
  const res = vitestIncludes().map(globToRegExp)
  const vitest = all.filter((f) => res.some((r) => r.test(f))).length
  const keeper = all.filter((f) => f.startsWith('contracts/order-engine/executor/') && /\.test\.(?:mjs|js|cjs)$/.test(f)).length
  const foundry = all.filter((f) => /^contracts\/(?:.*\/)?test\/[^/]*\.t\.sol$/.test(f)).length
  return { vitest, keeper, foundry }
}

/**
 * Where each suite is configured, derived from the tree (never a count). It changes only when a suite's config
 * moves or a new Foundry project appears, not when a test file is added.
 */
export function testSuites() {
  const all = walk()
  if (!all.includes('vitest.config.ts')) fail('vitest.config.ts not found')
  const keeperDir = 'contracts/order-engine/executor'
  if (!all.includes(`${keeperDir}/package.json`)) fail(`${keeperDir}/package.json not found`)
  const foundry = all.filter((f) => /^contracts\/(?:.*\/)?foundry\.toml$/.test(f))
  if (foundry.length === 0) fail('no foundry.toml under contracts/')
  return { vitestConfig: 'vitest.config.ts', keeperDir, foundry }
}

// ── The block ────────────────────────────────────────────────────────────────────────────────────────
export function buildBlock() {
  const rows = parseDeployments(read('docs/DEPLOYMENTS.md'))
  const wf = workflowNames()
  const adr = adrSummary()
  const t = testSuites()
  const out = [
    BEGIN,
    '<!-- Generated by scripts/gen-claude-state.mjs from repo content only (no date, no sha). Do not edit by hand:',
    '     node scripts/gen-claude-state.mjs --write && node scripts/check-agents-parity.mjs --write -->',
    '',
    '**Contracts** — copied from the "Contracts" table of `docs/DEPLOYMENTS.md`. One address can be a different contract on another chain:',
    'always qualify by chain. Operational status and the checks behind each row are in that file\'s "Verified facts" column.',
    '',
    '| Role | Chain | Address |',
    '|------|-------|---------|',
    ...rows.map((r) => `| ${r.role} | ${r.chain} | ${r.address} |`),
    '',
    `**Workflows** (${wf.length}, \`.github/workflows/\`): ${wf.map((w) => `${w.name} (\`${w.file}\`)`).join(', ')}`,
    '',
    `**ADRs** (\`docs/ADR/\`): ${adr.count} files, ${adr.first} to ${adr.last}; latest \`${adr.latestFile}\`, Status: ${adr.status}`,
    '',
    `**Test suites** (no counts here, they change on every PR; \`node scripts/gen-claude-state.mjs --counts\` prints them): vitest, \`npx vitest run\`, config \`${t.vitestConfig}\` · keeper node:test, \`node --test\` in \`${t.keeperDir}/\` · Foundry, \`forge test\`, configs ${t.foundry.map((f) => `\`${f}\``).join(', ')}`,
    END,
  ]
  return out.join('\n')
}

// ── CLAUDE.md I/O ────────────────────────────────────────────────────────────────────────────────────
export function splitClaude(content) {
  const b = content.indexOf(BEGIN)
  const e = content.indexOf(END)
  if (b === -1 || e === -1 || e < b) fail(`CLAUDE.md needs exactly one ${BEGIN} ... ${END} pair`)
  if (content.indexOf(BEGIN, b + 1) !== -1 || content.indexOf(END, e + 1) !== -1) fail('CLAUDE.md has more than one state block')
  return { before: content.slice(0, b), current: content.slice(b, e + END.length), after: content.slice(e + END.length) }
}

function firstDifference(a, b) {
  const al = a.split('\n')
  const bl = b.split('\n')
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return { line: i + 1, committed: al[i] ?? '(missing)', generated: bl[i] ?? '(missing)' }
  }
  return null
}

function main() {
  const args = new Set(process.argv.slice(2))
  const modes = ['--check', '--write', '--print', '--counts'].filter((m) => args.has(m))
  if (modes.length !== 1) fail('usage: gen-claude-state.mjs --check | --write | --print | --counts')
  if (args.has('--counts')) {
    const c = testFileCounts()
    console.log(`vitest ${c.vitest} · keeper node:test ${c.keeper} · Foundry ${c.foundry}`)
    return
  }
  const block = buildBlock()
  if (args.has('--print')) {
    console.log(block)
    return
  }
  const claudePath = path.join(ROOT, 'CLAUDE.md')
  const content = read('CLAUDE.md')
  const { before, current, after } = splitClaude(content)
  if (args.has('--write')) {
    writeFileSync(claudePath, `${before}${block}${after}`)
    console.log(current === block ? 'CLAUDE.md state block already current' : 'CLAUDE.md state block rewritten')
    if (current !== block) console.log('Now run: node scripts/check-agents-parity.mjs --write')
    return
  }
  if (current === block) {
    console.log('CLAUDE.md state block is current')
    return
  }
  const d = firstDifference(current, block)
  console.error('CLAUDE.md state block is out of date with the repo.')
  if (d) {
    console.error(`  first difference, block line ${d.line}:`)
    console.error(`    committed: ${d.committed}`)
    console.error(`    generated: ${d.generated}`)
  }
  console.error('Regenerate, then re-pin AGENTS.md:')
  console.error('  node scripts/gen-claude-state.mjs --write && node scripts/check-agents-parity.mjs --write')
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
