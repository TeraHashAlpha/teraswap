// @vitest-environment node
/**
 * [fix/orders-server-side-order-hash] check-order-hashes on fixtures only (no database, no network).
 *
 * __fixtures__/order-rows.json: 8 rows. "v3-dca-match" and "v2-limit-match" carry the hash of their order_data byte
 * for byte; "v3-dca-upper-case" the same hash in upper case; "v3-caller-text" a caller's arbitrary text;
 * "v3-hash-of-another-order" the hash of the same order with dcaTotal 2; "legacy-uuid-hash" a UUID; "no-order-data"
 * and "order-data-missing-nonce" cannot be rebuilt the way the keeper rebuilds an order. Each row has a distinct
 * synthetic signature (byte patterns, not a signature of anything).
 *
 * [A86 S-2, S-8] __fixtures__/order-rows-a86.json: 12 rows for the non-canonical verdict, the two groupings, the
 * lower-cased addresses and the never-print-a-signature rule (each row's purpose is in its id; generated once, the
 * hashes with the server function; the S-8 row's hash is re-derived here independently).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, isAddress, keccak256, toBytes, type Hex } from 'viem'
import { checkRows, groupRows, safeText, type Verdict } from './check-order-hashes-lib'
import { ORDER_V3_TYPE_STRING } from '@/lib/order-engine/types'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = resolve(__dirname, 'check-order-hashes.ts')
const FIXTURE = resolve(__dirname, '__fixtures__/order-rows.json')
const FIXTURE_A86 = resolve(__dirname, '__fixtures__/order-rows-a86.json')
const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>[]
const rowsA86 = JSON.parse(readFileSync(FIXTURE_A86, 'utf8')) as Record<string, unknown>[]
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function run(input: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT], { cwd: ROOT, input, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const lines = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

/** The contracts' getOrderHash for a v3 order_data, written out without the server function. */
function contractHashV3(od: Record<string, string | number>): Hex {
  const n = (k: string) => BigInt(od[k])
  const a = (k: string) => String(od[k]).toLowerCase() as Hex
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint16' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
    ],
    [
      keccak256(toBytes(ORDER_V3_TYPE_STRING)), a('owner'), a('tokenIn'), a('tokenOut'), n('amountIn'), n('minAmountOut'),
      Number(od.maxSlippageBps), Number(od.orderType), Number(od.condition), n('targetPrice'), a('priceFeed'), n('expiry'),
      n('nonce'), a('router'), od.routerDataHash as Hex, n('dcaInterval'), n('dcaTotal'),
    ],
  ))
}

describe('checkRows (fixture)', () => {
  const byId: Record<string, Verdict> = Object.fromEntries(checkRows(rows).map((v) => [String(v.id), v]))

  it('classifies every fixture row', () => {
    expect(Object.fromEntries(Object.entries(byId).map(([id, v]) => [id, v.verdict]))).toEqual({
      'v3-dca-match': 'match',
      'v3-dca-upper-case': 'non-canonical',
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
    expect(byId['v3-dca-match']).toMatchObject({ verdict: 'match', computed: contractHashV3(od) })
  })

  it('rejects input that is not an array', () => {
    expect(() => checkRows({ rows })).toThrow(/JSON array/)
  })
})

describe('check-order-hashes.ts (CLI, stdin)', () => {
  it('prints exactly the differing and non-canonical rows on stdout, the uncomputable ones and a summary on stderr, exit 1', () => {
    const r = run(readFileSync(FIXTURE, 'utf8'))
    expect(r.code).toBe(1)
    expect(lines(r.stdout).map((o) => [o.verdict, o.id])).toEqual([
      ['non-canonical', 'v3-dca-upper-case'],
      ['differs', 'v3-caller-text'],
      ['differs', 'v3-hash-of-another-order'],
      ['differs', 'legacy-uuid-hash'],
    ])
    expect(r.stderr).toContain('"id":"no-order-data"')
    expect(r.stderr).toContain('"id":"order-data-missing-nonce"')
    expect(r.stderr).toContain(
      'checked 8 rows: 2 match, 1 non-canonical, 3 differ, 2 uncomputable, 0 without signature; ' +
      '0 same-computed-hash groups, 0 same-signature groups',
    )
  })

  it('exit 0 and an empty stdout when every row is byte-equal, signed, and no order or signature repeats', () => {
    const clean = rows.filter((r) => r.id === 'v3-dca-match' || r.id === 'v2-limit-match')
    const r = run(JSON.stringify(clean))
    expect(r).toEqual({
      code: 0,
      stdout: '',
      stderr: 'checked 2 rows: 2 match, 0 non-canonical, 0 differ, 0 uncomputable, 0 without signature; ' +
        '0 same-computed-hash groups, 0 same-signature groups\n',
    })
  })

  it('exit 2 on unreadable input, nothing on stdout', () => {
    const r = run('not json')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
  })
})

describe('A86 S-2 / S-8 (fixture order-rows-a86.json)', () => {
  const verdicts = checkRows(rowsA86)
  const byId: Record<string, Verdict> = Object.fromEntries(verdicts.map((v) => [String(v.id), v]))

  it('classifies every row', () => {
    expect(Object.fromEntries(verdicts.map((v) => [v.id, v.verdict]))).toEqual({
      'byte-equal': 'match',
      'non-canonical-0x-upper': 'non-canonical',
      'non-canonical-0X-upper': 'non-canonical',
      'non-canonical-0X-lower': 'non-canonical',
      'non-canonical-no-prefix': 'non-canonical',
      'legacy-uuid-same-order': 'differs',
      'bent-order-data-same-signature': 'differs',
      'same-order-other-signature': 'match',
      'bad-checksum-owner': 'match',
      'signature-as-order-hash': 'differs',
      'signature-in-order-data': 'uncomputable',
      'no-signature': 'match',
    })
  })

  it('[S-2] non-canonical = the right hash in another spelling; only a byte-equal text is a match', () => {
    for (const id of ['non-canonical-0x-upper', 'non-canonical-0X-upper', 'non-canonical-0X-lower', 'non-canonical-no-prefix']) {
      const v = byId[id] as Extract<Verdict, { verdict: 'non-canonical' }>
      expect(v.stored).not.toBe(v.computed)
      expect(`0x${v.stored.slice(-64).toLowerCase()}`).toBe(v.computed)
    }
    const m = byId['byte-equal'] as Extract<Verdict, { verdict: 'match' }>
    expect(m.stored).toBe(m.computed)
  })

  it('[S-2] reports the rows that hold one order twice: by computed hash, and by signature in any of its texts', () => {
    const g = groupRows(rowsA86, verdicts)
    expect(g.sameComputedHash.map((x) => x.ids)).toEqual([
      ['byte-equal', 'legacy-uuid-same-order'],
      ['non-canonical-no-prefix', 'same-order-other-signature'],
    ])
    expect(g.sameComputedHash[0].computed).toBe((byId['byte-equal'] as { computed: string }).computed)
    // legacy-uuid-same-order holds byte-equal's signature as v - 27, bent-order-data-same-signature holds
    // non-canonical-0x-upper's as its high-s twin: the texts differ, the signature is one.
    expect(String(rowsA86.find((r) => r.id === 'legacy-uuid-same-order')!.signature))
      .not.toBe(String(rowsA86.find((r) => r.id === 'byte-equal')!.signature))
    expect(g.sameSignature.map((x) => x.ids)).toEqual([
      ['byte-equal', 'legacy-uuid-same-order'],
      ['non-canonical-0x-upper', 'bent-order-data-same-signature'],
    ])
    expect(g.withoutSignature).toEqual(['no-signature'])
  })

  it('[S-8] a mixed-case address with a wrong checksum is hashed lower-cased (the keeper accepts it), not uncomputable', () => {
    const od = rowsA86.find((r) => r.id === 'bad-checksum-owner')!.order_data as Record<string, string | number>
    expect(isAddress(String(od.owner))).toBe(false) // viem's strict check refuses the text as stored
    expect(byId['bad-checksum-owner']).toMatchObject({ verdict: 'match', computed: contractHashV3(od) })
  })

  it('[S-8] zero rows exits 1, nothing on stdout', () => {
    const r = run('[]')
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('0 rows: an empty export proves nothing')
  })

  it('CLI: every finding, exit 1; the summary counts each kind', () => {
    const r = run(readFileSync(FIXTURE_A86, 'utf8'))
    expect(r.code).toBe(1)
    expect(lines(r.stdout).map((o) => o.verdict ?? o.group)).toEqual([
      'non-canonical', 'non-canonical', 'non-canonical', 'non-canonical', 'differs', 'differs', 'differs',
      'same-computed-hash', 'same-computed-hash', 'same-signature', 'same-signature',
    ])
    expect(r.stderr).toContain('uncomputable {"id":"signature-in-order-data"')
    expect(r.stderr).toContain('"reason":"order_data.owner is not an address"')
    expect(r.stderr).toContain('no-signature {"id":"no-signature"}')
    expect(r.stderr).toContain(
      'checked 12 rows: 4 match, 4 non-canonical, 3 differ, 1 uncomputable, 1 without signature; ' +
      '2 same-computed-hash groups, 2 same-signature groups',
    )
  })

  it('CLI output never prints a signature: no 10-hex window of any fixture signature, in any of its texts', () => {
    const r = run(readFileSync(FIXTURE_A86, 'utf8'))
    const printed = (r.stdout + r.stderr).toLowerCase()
    expect(lines(r.stdout).find((o) => o.id === 'signature-as-order-hash')).toMatchObject({ stored: '<string len 132>' })
    const texts = rowsA86.flatMap((row) => (typeof row.signature === 'string' ? [row.signature] : []))
    for (const t of [...texts]) {
      const s = BigInt(`0x${t.slice(66, 130)}`)
      texts.push(`0x${t.slice(2, 66)}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${t.slice(130)}`)
    }
    const leaked = texts.flatMap((t) => {
      const hex = t.slice(2).toLowerCase()
      return Array.from({ length: hex.length - 9 }, (_, i) => hex.slice(i, i + 10)).filter((w) => printed.includes(w))
    })
    expect(leaked).toEqual([])
  })

  it('safeText prints only a hash- or UUID-shaped text', () => {
    const h = `0x${'ab'.repeat(32)}`
    expect(safeText(h)).toBe(h)
    expect(safeText(h.slice(2).toUpperCase())).toBe(h.slice(2).toUpperCase())
    expect(safeText('6f1c2a90-3b7e-4c1d-9a2e-5d6f7a8b9c0d')).toBe('6f1c2a90-3b7e-4c1d-9a2e-5d6f7a8b9c0d')
    expect(safeText(`0x${'ab'.repeat(65)}`)).toBe('<string len 132>')
    expect(safeText('not-a-hash')).toBe('<string len 10>')
    expect(safeText(42)).toBe('<number>')
    expect(safeText(null)).toBeNull()
  })
})

// [A89 R2-2, R2-5] A stored order_hash that is a window of the row's OWN signature has the shape of a hash, so the
// shape rule alone printed it; and the CLI's last-resort redact (130+ hex) had no test of its own.
describe('the row\'s own signature is never printed [A89 R2-2, R2-5]', () => {
  const base = rows.find((r) => r.id === 'v3-dca-match')!
  // Signature-shaped with distinct bytes (low s, v 27), so every 10-hex window is specific: built, not a signature of anything.
  const R = keccak256(toBytes('A89 R2-2 r')).slice(2)
  const S = (BigInt(keccak256(toBytes('A89 R2-2 s'))) % (SECP256K1_N / 2n)).toString(16).padStart(64, '0')
  const TWIN_S = (SECP256K1_N - BigInt(`0x${S}`)).toString(16).padStart(64, '0')
  const SIG = `0x${R}${S}1b`
  const HEX = SIG.slice(2)
  /** Every 10-hex window of the signature and of its high-s twin text that appears in `printed`. */
  const leaked = (printed: string) => {
    const lower = printed.toLowerCase()
    return [HEX, `${R}${TWIN_S}1c`].flatMap((h) =>
      Array.from({ length: h.length - 9 }, (_, i) => h.slice(i, i + 10)).filter((w) => lower.includes(w)))
  }
  const WINDOWS: [string, string][] = [
    ['r', `0x${R}`],
    ['s', `0x${S}`],
    ['a middle window', `0x${HEX.slice(33, 97)}`],
    ['the last 64 hex (end of s + v)', `0x${HEX.slice(66)}`],
    ['r in upper case without 0x', R.toUpperCase()],
    ['the s of the high-s twin', `0x${TWIN_S}`],
  ]

  it.each(WINDOWS)('a stored order_hash that is %s of the row\'s signature: <signature fragment len N>, on stdout and stderr', (_label, window) => {
    const r = run(JSON.stringify([
      { ...base, id: 'window-differs', order_hash: window, signature: SIG },
      { ...base, id: 'window-uncomputable', order_hash: window, order_data: null, signature: SIG },
    ]))
    expect(lines(r.stdout).find((o) => o.id === 'window-differs')).toMatchObject({
      verdict: 'differs', stored: `<signature fragment len ${window.length}>`,
    })
    expect(r.stderr).toContain(`uncomputable {"id":"window-uncomputable","chain_id":8453,"stored":"<signature fragment len ${window.length}>"`)
    expect(leaked(r.stdout + r.stderr)).toEqual([])
  })

  it('safeText: a window of THIS row\'s signature is a fragment; the same text beside another signature, or none, is printed', () => {
    const window = `0x${S}`
    expect(safeText(window, SIG)).toBe('<signature fragment len 66>')
    expect(safeText(window, `0x${'cd'.repeat(65)}`)).toBe(window)
    expect(safeText(window)).toBe(window)
    expect(safeText(`0x${'ab'.repeat(32)}`, SIG)).toBe(`0x${'ab'.repeat(32)}`)
  })

  it.each([
    ['with 0x', SIG, 132],
    ['without 0x', HEX, 130],
  ])('R2-5 last-resort redact: a row whose id is a signature (%s) is printed as <redacted len N> on both streams', (_label, id, len) => {
    const r = run(JSON.stringify([
      { ...base, id, order_hash: `0x${'ab'.repeat(32)}`, signature: `0x${'cd'.repeat(64)}1b` },
      { ...base, id, order_hash: null, order_data: null, signature: `0x${'ef'.repeat(64)}1b` },
    ]))
    expect(lines(r.stdout).find((o) => o.verdict === 'differs')).toMatchObject({ id: `<redacted len ${len}>` })
    expect(r.stderr).toContain(`uncomputable {"id":"<redacted len ${len}>"`)
    expect(leaked(r.stdout + r.stderr)).toEqual([])
  })
})
