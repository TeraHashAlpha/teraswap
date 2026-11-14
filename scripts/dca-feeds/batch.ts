/**
 * [feat/dca-feed-batch] Monthly feed batch: switch a NAMED list of symbols on for one chain in
 * src/config/dca-feed-registrations.json. READ-ONLY on the network (one HTTPS GET of Chainlink's public feed
 * directory, then eth_call / eth_getCode / eth_chainId on two public RPCs). No key, no signing, no transaction.
 *
 *   node --no-warnings scripts/dca-feeds/batch.ts --chain base --batch 2026-11 --symbols MORPHO,AAVE > "$TMPDIR/dca-batch.json" \
 *     && mv "$TMPDIR/dca-batch.json" src/config/dca-feed-registrations.json
 *
 * stdout = the WHOLE next config (only when every symbol passes); stderr = one line per symbol. Exit 0 = all passed,
 * 1 = at least one symbol refused (nothing on stdout), 2 = usage or sentinel failure. The rules live in batch-lib.ts.
 *
 * Why stdout and not a file write: the values come from the network, and a redirect makes writing them an explicit,
 * reviewable act (the same choice as scripts/fiat/build-eur-usd-feed.mjs). NEVER redirect straight onto the config:
 * the shell truncates it before this script can read it (the guard below then refuses; `git checkout` restores it).
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LiveReadings } from './batch-lib' // type-only: erased before Node resolves it

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG_PATH = resolve(root, 'src/config/dca-feed-registrations.json')

function usage(message: string): never {
  console.error(`batch: ${message}\nusage: batch.ts --chain base|arbitrum --batch YYYY-MM --symbols SYM1,SYM2,...`)
  process.exit(2)
}
function arg(name: string): string {
  const i = process.argv.indexOf(name)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (!v || v.startsWith('--')) usage(`missing ${name}`)
  return v
}

const chainKey = arg('--chain')
const batch = arg('--batch')
const symbols = arg('--symbols').split(',').map(s => s.trim()).filter(Boolean)

const configText = readFileSync(CONFIG_PATH, 'utf8')
if (configText.trim() === '') {
  console.error('batch: the config file is EMPTY. Was stdout redirected straight onto it? Restore it (git checkout -- src/config/dca-feed-registrations.json) and redirect to a temp file.')
  process.exit(2)
}
// Loaded only after the guard above: lib.ts imports the config JSON statically.
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
const { CHAINS, SentinelError, buildContext, readFeedReading, readTokenDecimals } = await import('./lib.ts')
// @ts-expect-error TS5097 - same
const { applyBatch, selectBatch, serializeConfig } = await import('./batch-lib.ts')
// Host and paths live in directory.ts (shared with candidates.ts); nothing from argv reaches the URL.
// @ts-expect-error TS5097 - same
const { directoryUrl: directoryUrlOf, fetchDirectory } = await import('./directory.ts')

const chain = CHAINS[chainKey]
if (!chain || !directoryUrlOf(chain.id)) usage(`unknown chain "${chainKey}"`)
const config = JSON.parse(configText)
if (serializeConfig(config) !== configText) { console.error('batch: the config is not in canonical form (JSON.stringify, 2 spaces, trailing newline); refusing to rewrite it'); process.exit(2) }

let ctx
try { ctx = await buildContext(chainKey) } catch (e) {
  if (e instanceof SentinelError) { console.error(`REFUSING (${chainKey}): ${e.message}`); process.exit(2) }
  throw e
}

const directoryUrl = directoryUrlOf(chain.id) as string
let directory: any[]
try { directory = await fetchDirectory(chain.id) } catch (e) { console.error(`batch: ${(e as Error).message}`); process.exit(2) }
const catalog = JSON.parse(readFileSync(resolve(root, `src/config/generated/token-catalog.${chain.id}.json`), 'utf8')).tokens

// Chain reads only for the symbols the directory and the catalog already allow.
const base = { config, chainId: chain.id, symbols, directory, catalog }
const live: LiveReadings = { now: Math.floor(Date.now() / 1000), feeds: {}, tokenDecimals: {} }
for (const s of selectBatch(base)) {
  if (!s.candidate) continue
  const { feed, token } = s.candidate
  live.feeds[feed.toLowerCase()] = await Promise.all(ctx.clients.map((c: unknown) => readFeedReading(c, feed)))
  live.tokenDecimals[token.toLowerCase()] = await readTokenDecimals(ctx.clients[0], token).catch((e: Error) => ({ error: e.message.split('\n')[0] }))
}

const { next, report } = applyBatch({ ...base, batch, date: new Date().toISOString().slice(0, 10), live })
console.error(`\n== ${chain.name} (${chain.id}) batch ${batch}: directory ${directoryUrl} (${directory.length} entries), ${ctx.clients.length} RPCs ==`)
const cols = ['symbol', 'status', 'token', 'feed', 'description', 'category', 'heartbeat', 'maxStaleness', 'age(s)']
const widths = [8, 8, 44, 44, 14, 8, 9, 12, 7]
console.error(cols.map((c, i) => c.padEnd(widths[i])).join(' '))
for (const r of report) {
  const cells = [r.symbol, r.status, r.token ?? '-', r.feed ?? '-', r.description ?? '-', r.category ?? '-', r.heartbeat ?? '-', r.maxStaleness ?? '-', r.ageSec ?? '-']
  console.error(cells.map((c, i) => String(c).padEnd(widths[i])).join(' ') + (r.reasons.length ? `  REFUSED: ${r.reasons.join('; ')}` : ''))
}
if (!next) { console.error('batch: at least one symbol was refused; no config produced (all or nothing)'); process.exit(1) }
process.stdout.write(serializeConfig(next))
console.error(`batch: ${report.length} row(s) switched on; review the diff, then run plan.ts --chain ${chainKey}`)
