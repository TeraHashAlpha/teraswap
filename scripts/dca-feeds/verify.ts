/**
 * [FEAT-DCA-FEED-REGISTRATION-PHASE1] READ-ONLY post-execution check: re-read `tokenUsdFeeds` for every enabled
 * phase-1 row (and the phase-0 controls) and print PASS/FAIL per token. Reads on TWO independent RPCs and
 * requires them to agree. Exit 1 on any FAIL.
 *
 *   node scripts/dca-feeds/verify.ts [--chain base|arbitrum]
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { SentinelError, buildContext, parseArgs, readOnchain, readTokenDecimals, checkFeedLive, eq } from './lib.ts'

const { chains } = parseArgs(process.argv.slice(2))
let failed = false
for (const key of chains) {
  let ctx
  try { ctx = await buildContext(key) } catch (e) {
    if (e instanceof SentinelError) { console.error(`REFUSING (${key}): ${e.message}`); process.exit(2) }
    throw e
  }
  const { chain, executor, clients, rows, controls } = ctx
  console.log(`\n== ${chain.name} (${chain.id}) executor ${executor} ==`)
  for (const c of controls) console.log(`control  ${c.result.padEnd(16)} ${c.control}`)
  for (const r of rows.filter(x => x.enabled && x.phase <= 1)) {
    const reasons: string[] = []
    const reads = await Promise.all(clients.map(c => readOnchain(c, executor, r.token).catch(() => null)))
    const [a, b] = reads
    if (!a) reasons.push('primary RPC read failed')
    else {
      if (b && (a.registered !== b.registered || !eq(a.feed, b.feed) || a.maxStaleness !== b.maxStaleness)) reasons.push('RPCs disagree')
      if (!b) reasons.push('secondary RPC unavailable (warning)')
      if (!a.registered) reasons.push('not registered')
      if (!eq(a.feed, r.feed)) reasons.push(`feed ${a.feed} != config ${r.feed}`)
      if (a.feedDecimals !== r.decimals) reasons.push(`feedDecimals ${a.feedDecimals} != ${r.decimals}`)
      if (a.tokenDecimals !== r.tokenDecimals) reasons.push(`tokenDecimals ${a.tokenDecimals} != ${r.tokenDecimals}`)
      if (r.maxStaleness !== null && a.maxStaleness !== BigInt(r.maxStaleness)) reasons.push(`maxStaleness ${a.maxStaleness} != ${r.maxStaleness}`)
      if (await readTokenDecimals(clients[0], r.token) !== r.tokenDecimals) reasons.push('token decimals() differs from config')
      const live = await checkFeedLive(clients[0], r.feed, r)
      if (!live.ok) reasons.push(...live.reasons)
    }
    const fatal = reasons.filter(x => !x.endsWith('(warning)'))
    if (fatal.length) failed = true
    console.log(`${fatal.length ? 'FAIL' : 'PASS'}  ${r.symbol.padEnd(8)} ${fatal.length ? fatal.join('; ') : ''}${reasons.length > fatal.length ? ' [secondary RPC unavailable]' : ''}`)
  }
}
process.exit(failed ? 1 : 0)
