// @vitest-environment node
/**
 * [fix/orders-server-side-order-hash] check-order-hashes on fixtures only (no database, no network).
 *
 * __fixtures__/order-rows.json: 8 rows. The three "match" rows carry the hash of their order_data (one
 * spelled in upper case); "v3-caller-text" a caller's arbitrary text; "v3-hash-of-another-order" the
 * hash of the same order with dcaTotal 2; "legacy-uuid-hash" a UUID; "no-order-data" and
 * "order-data-missing-nonce" cannot be rebuilt the way the keeper rebuilds an order.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem'
import { checkRows, type Verdict } from './check-order-hashes-lib'
import { ORDER_V3_TYPE_STRING } from '@/lib/order-engine/types'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = resolve(__dirname, 'check-order-hashes.ts')
const FIXTURE = resolve(__dirname, '__fixtures__/order-rows.json')
const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>[]

function run(input: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT], { cwd: ROOT, input, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('checkRows (fixture)', () => {
  const byId: Record<string, Verdict> = Object.fromEntries(checkRows(rows).map((v) => [String(v.id), v]))

  it('classifies every fixture row', () => {
    expect(Object.fromEntries(Object.entries(byId).map(([id, v]) => [id, v.verdict]))).toEqual({
      'v3-dca-match': 'match',
      'v3-dca-upper-case': 'match',
      'v2-limit-match': 'match',
      'v3-caller-text': 'differs',
      'v3-hash-of-another-order': 'differs',
      'legacy-uuid-hash': 'differs',
      'no-order-data': 'uncomputable',
      'order-data-missing-nonce': 'uncomputable',
    })
  })

  it('a "match" is the contracts\' own construction, computed here without the server function', () => {
    const od = rows.find((r) => r.id === 'v3-dca-match')!.order_data as Record<string, string | number>
    const n = (k: string) => BigInt(od[k])
    const expected = keccak256(encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'uint16' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
        { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
      ],
      [
        keccak256(toBytes(ORDER_V3_TYPE_STRING)), od.owner as Hex, od.tokenIn as Hex, od.tokenOut as Hex, n('amountIn'), n('minAmountOut'),
        Number(od.maxSlippageBps), Number(od.orderType), Number(od.condition), n('targetPrice'), od.priceFeed as Hex, n('expiry'),
        n('nonce'), od.router as Hex, od.routerDataHash as Hex, n('dcaInterval'), n('dcaTotal'),
      ],
    ))
    expect(byId['v3-dca-match']).toMatchObject({ verdict: 'match', computed: expected })
  })

  it('rejects input that is not an array', () => {
    expect(() => checkRows({ rows })).toThrow(/JSON array/)
  })
})

describe('check-order-hashes.ts (CLI, stdin)', () => {
  it('prints exactly the differing rows on stdout, the uncomputable ones and a summary on stderr, exit 1', () => {
    const r = run(readFileSync(FIXTURE, 'utf8'))
    expect(r.code).toBe(1)
    const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: string })
    expect(out.map((o) => o.id)).toEqual(['v3-caller-text', 'v3-hash-of-another-order', 'legacy-uuid-hash'])
    expect(r.stderr).toContain('"id":"no-order-data"')
    expect(r.stderr).toContain('"id":"order-data-missing-nonce"')
    expect(r.stderr).toContain('checked 8 rows: 3 match, 3 differ, 2 uncomputable')
  })

  it('exit 0 and an empty stdout when every row matches', () => {
    const matching = rows.filter((r) => String(r.id).endsWith('match') || r.id === 'v3-dca-upper-case')
    expect(matching).toHaveLength(3)
    const r = run(JSON.stringify(matching))
    expect(r).toEqual({ code: 0, stdout: '', stderr: 'checked 3 rows: 3 match, 0 differ, 0 uncomputable\n' })
  })

  it('exit 2 on unreadable input, nothing on stdout', () => {
    const r = run('not json')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
  })
})
