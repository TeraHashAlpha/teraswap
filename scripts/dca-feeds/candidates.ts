/**
 * [feat/dca-feed-candidates-weekly] Weekly list of token USD feeds that COULD be registered on one chain.
 * READ-ONLY on the network: one HTTPS GET of Chainlink's public feed directory (host fixed in directory.ts), then
 * eth_call / eth_getCode / eth_chainId on two public RPCs. No key, no signing, no transaction, no secret.
 *
 *   node --no-warnings scripts/dca-feeds/candidates.ts --chain base|arbitrum [--md FILE] [--write-config] > report.json
 *
 * stdout = the machine-readable report (JSON). stderr = the table. Exit 0 = the list was built (zero candidates is
 * a normal answer), 2 = usage, a sentinel failure or a failed directory fetch (the job must fail, never publish an empty list).
 *
 *   --md FILE        also write the table as GitHub markdown (the body of the weekly PR).
 *   --write-config   append the NEW candidates to src/config/dca-feed-registrations.json as phase 2, enabled:false,
 *                    action:"none". An existing row is never modified (candidates-lib.ts proves it and throws otherwise).
 *                    The file is replaced atomically (temp file + rename) and only when there is something to add.
 *
 * Enabling a row stays the monthly batch (batch.ts, Auditor-read): nothing here sets `enabled`, `action: "register"` or `batch`.
 * The rules live in candidates-lib.ts (and batch-lib.ts, reused as they are).
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CandidateLive, Report } from './candidates-lib' // type-only: erased before Node resolves it

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG_PATH = resolve(root, 'src/config/dca-feed-registrations.json')

function usage(message: string): never {
  console.error(`candidates: ${message}\nusage: candidates.ts --chain base|arbitrum [--md FILE] [--write-config]`)
  process.exit(2)
}
function value(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) usage(`missing value for ${name}`)
  return v
}
const known = new Set(['--chain', '--md', '--write-config'])
for (const a of process.argv.slice(2)) if (a.startsWith('--') && !known.has(a)) usage(`unknown option ${a}`)
const chainKey = value('--chain') ?? usage('missing --chain')
const mdPath = value('--md')
const writeConfig = process.argv.includes('--write-config')

const configText = readFileSync(CONFIG_PATH, 'utf8')
if (configText.trim() === '') usage('the config file is EMPTY. Restore it (git checkout -- src/config/dca-feed-registrations.json); never redirect stdout onto it.')
// Loaded only after the guard above: lib.ts imports the config JSON statically.
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
const { CHAINS, SentinelError, buildContext, readFeedReading, readOnchain, readTokenDecimals } = await import('./lib.ts')
// @ts-expect-error TS5097 - same
const { selectCandidates, classify, sortRows, summarize, addCandidates, serializeConfig, textTable, markdownTable } = await import('./candidates-lib.ts')
// @ts-expect-error TS5097 - same
const { directoryUrl: directoryUrlOf, fetchDirectory } = await import('./directory.ts')

const chain = CHAINS[chainKey]
if (!chain || !directoryUrlOf(chain.id)) usage(`unknown chain "${chainKey}" (use: ${Object.keys(CHAINS).join(', ')})`)
const config = JSON.parse(configText)
if (serializeConfig(config) !== configText) usage('the config is not in canonical form (JSON.stringify, 2 spaces, trailing newline); refusing to rewrite it')

let ctx
try { ctx = await buildContext(chainKey) } catch (e) {
  if (e instanceof SentinelError) { console.error(`REFUSING (${chainKey}): ${e.message}`); process.exit(2) }
  throw e
}

const directoryUrl = directoryUrlOf(chain.id) as string
let directory: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
try { directory = await fetchDirectory(chain.id) } catch (e) { console.error(`candidates: ${(e as Error).message}`); process.exit(2) }
const catalog = JSON.parse(readFileSync(resolve(root, `src/config/generated/token-catalog.${chain.id}.json`), 'utf8')).tokens

// Chain reads only for the rows the directory, the catalog and the config already allow.
const { selected, skipped } = selectCandidates({ config, chainId: chain.id, directory, catalog })
const live: CandidateLive = { now: Math.floor(Date.now() / 1000), feeds: {}, tokenDecimals: {}, registered: {} }
const errorOf = (e: unknown) => ({ error: (e as Error).message.split('\n')[0] })
const todo = selected.filter(s => s.candidate)
let next = 0
await Promise.all(Array.from({ length: 3 }, async () => { // three rows at a time: gentle on public RPCs
  for (;;) {
    const s = todo[next++]
    if (!s?.candidate) return
    const { feed, token } = s.candidate
    live.feeds[feed.toLowerCase()] = await Promise.all(ctx.clients.map((c: unknown) => readFeedReading(c, feed)))
    live.tokenDecimals[token.toLowerCase()] = await readTokenDecimals(ctx.clients[0], token).catch(errorOf)
    live.registered[token.toLowerCase()] = await Promise.all(ctx.clients.map((c: unknown) =>
      readOnchain(c, ctx.executor, token).then((o: { registered: boolean; feed: string }) => ({ registered: o.registered, feed: o.feed })).catch(errorOf)))
  }
}))

const rows = sortRows(classify(selected, live))
const date = new Date().toISOString().slice(0, 10)
const report: Report = {
  chain: chain.name, chainId: chain.id, directoryUrl, directoryEntries: directory.length, rpcs: ctx.clients.length, date,
  summary: summarize(rows), skipped, rows,
}

console.error(`\n== ${chain.name} (${chain.id}) candidates: directory ${directoryUrl} (${directory.length} entries), ${ctx.clients.length} RPCs, executor ${ctx.executor} ==`)
console.error(textTable(report))
console.error(`summary: ${report.summary.candidates} candidate(s) (${report.summary.newConfigRows} new config row(s)), ${report.summary.excluded} excluded, ` +
  `${report.summary.needsManualMatch} need a manual match; ${skipped.noCatalogToken} directory USD feed(s) have no token in our catalog, ${skipped.unsafeSymbol} skipped for an unsafe symbol`)

if (mdPath) writeFileSync(mdPath, markdownTable(report))
if (writeConfig) {
  const { next: nextConfig, added } = addCandidates(config, chain.id, rows, date)
  if (added.length > 0) {
    const tmp = `${CONFIG_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, serializeConfig(nextConfig))
    renameSync(tmp, CONFIG_PATH)
  }
  console.error(`config: ${added.length} row(s) added (${added.join(', ') || 'none'}); existing rows untouched`)
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
