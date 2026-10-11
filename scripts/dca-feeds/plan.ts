/**
 * [FEAT-DCA-FEED-REGISTRATION-PHASE1] READ-ONLY plan: config vs on-chain `tokenUsdFeeds`, live feed checks,
 * diff table (stderr) and queue/execute calldata JSON (stdout). NOTHING is sent or signed.
 *
 *   node scripts/dca-feeds/plan.ts [--chain base|arbitrum]
 *
 * Registration is TWO calls from the admin EOA (there is no separate Timelock contract): queueTokenUsdFeed,
 * wait TIMELOCK_ORACLE_CHANGE (48h, read on-chain), then executeTokenUsdFeed(actionId, ...) within the grace
 * window. actionId = keccak256(abi.encode(actionHash, queueBlockTimestamp)) so it is only known after queueing
 * (the TimelockQueued event); the execute payload is emitted as a template with that placeholder.
 */
import { ABI, SentinelError, buildContext, parseArgs, readOnchain, readTokenDecimals, checkFeedLive, encodeFunctionData, actionHash, eq } from './lib.ts'

const { chains } = parseArgs(process.argv.slice(2))
const out: any[] = []
let exitCode = 0

for (const key of chains) {
  let ctx
  try { ctx = await buildContext(key) } catch (e) {
    if (e instanceof SentinelError) { console.error(`REFUSING (${key}): ${e.message}`); process.exit(2) }
    throw e
  }
  const { chain, executor, admin, clients, rows, controls } = ctx
  const primary = clients[0]
  const delay = Number(await primary.readContract({ address: executor, abi: ABI, functionName: 'TIMELOCK_ORACLE_CHANGE' }))
  const grace = Number(await primary.readContract({ address: executor, abi: ABI, functionName: 'TIMELOCK_GRACE' }))
  const table: string[][] = [['symbol', 'action', 'current feed', 'target feed', 'status']]
  const items: any[] = []
  for (const r of rows.filter(x => x.phase === 1 && x.enabled)) {
    const on = await readOnchain(primary, executor, r.token)
    const tokDec = await readTokenDecimals(primary, r.token)
    const live = await checkFeedLive(primary, r.feed, r)
    const problems = [...live.reasons]
    if (tokDec !== r.tokenDecimals) problems.push(`token decimals on-chain ${tokDec} != config ${r.tokenDecimals}`)
    if (r.maxStaleness === null || r.maxStaleness < r.heartbeat) problems.push('maxStaleness missing or below heartbeat')
    const unchanged = on.registered && eq(on.feed, r.feed) && on.tokenDecimals === r.tokenDecimals && on.maxStaleness === BigInt(r.maxStaleness ?? -1)
    const status = problems.length ? 'BLOCKED' : unchanged ? 'unchanged (skipped)' : 'plan'
    table.push([r.symbol, r.action, on.registered ? on.feed : '(unregistered)', r.feed, status])
    const item: any = { symbol: r.symbol, action: r.action, token: r.token, current: on.registered ? on : null, target: { feed: r.feed, tokenDecimals: r.tokenDecimals, maxStaleness: r.maxStaleness }, status, live }
    if (problems.length) { item.problems = problems; exitCode = 1 }
    else if (!unchanged) {
      const args = [r.token, r.feed, r.tokenDecimals, BigInt(r.maxStaleness as number)] as const
      item.actionHash = actionHash(...args)
      item.queue = { from: admin, to: executor, value: '0', data: encodeFunctionData({ abi: ABI, functionName: 'queueTokenUsdFeed', args }) }
      item.execute = {
        from: admin, to: executor, value: '0', earliest: `queue block timestamp + ${delay}s`, latest: `+ ${grace}s grace`,
        actionId: 'keccak256(abi.encode(actionHash, queueBlockTimestamp)) - read from the TimelockQueued event',
        dataTemplate: encodeFunctionData({ abi: ABI, functionName: 'executeTokenUsdFeed', args: ['0x' + '00'.repeat(32), ...args] }),
        note: 'replace the first 32-byte argument (the zero placeholder) with the real actionId',
      }
    }
    items.push(item)
  }
  console.error(`\n== ${chain.name} (${chain.id}) executor ${executor} admin ${admin} (EOA, no external timelock) delay ${delay}s grace ${grace}s ==`)
  for (const t of table) console.error(t.map((c, i) => c.padEnd([8, 8, 44, 44, 20][i])).join(' '))
  out.push({ chain: chain.name, chainId: chain.id, executor, admin, delaySeconds: delay, graceSeconds: grace, controls, items })
}
console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
process.exit(exitCode)
