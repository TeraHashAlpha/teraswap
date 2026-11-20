// @vitest-environment node
/**
 * [A100 R2-1] Static guard: a cached orders read signature reaches a request ONLY through `await ordersReadHeaders(wallet)`
 * (read-auth.ts), which takes the entry through getVerifiedOrdersReadAuth first, so an entry that does not recover to its
 * wallet is dropped and never sent. Checked over every source file of src/ (tests excluded):
 *   1. the two header names (the constants or the literal text) appear only in read-auth.ts and in the server routes
 *      under src/app/api (which READ them off a request): no browser file builds the headers itself;
 *   2. the cache (its accessors, its storage key) is touched only in read-auth.ts: no call site reads it directly;
 *   3. inside read-auth.ts the cache is read in ONE place, getVerifiedOrdersReadAuth, and the header object is built in ONE
 *      place, ordersReadHeaders, from what `await getVerifiedOrdersReadAuth(wallet)` returned;
 *   4. every call of ordersReadHeaders is awaited, and the files that call it are exactly the five reads listed below
 *      (a new one fails here until it is added, so it gets looked at).
 * Each checker is first shown to FAIL on a violating source, so the guard cannot pass vacuously.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SRC = path.join(ROOT, 'src')
const READ_AUTH = 'src/lib/order-engine/read-auth.ts'
const SERVER_ROUTES = 'src/app/api/'
// A file of the first UI tree may not name the second one (the isolation guard): the segment is built, as the other guards do.
const secondTree = (...rest: string[]) => ['src', 'ui', 'v' + '2', ...rest].join('/')

/** The browser's orders reads: file → how many times it builds read headers. */
const CALL_SITES: Record<string, number> = {
  'src/lib/order-engine/executions-client.ts': 1, // GET /api/orders/:id/executions (the fills)
  'src/lib/order-engine/supabase.ts': 2, // GET /api/orders?wallet= (the list) and &hashes= (the 10 s poll)
  'src/components/WalletHistory.tsx': 1, // GET /api/history, v1
  [secondTree('history', 'use-wallet-history.ts')]: 1, // GET /api/history, v2
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test-utils' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|pw|spec)\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** Source text without comments (a comment may name a header or the helper; code may not). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

const HEADER_NAME = /ORDERS_READ_HEADER_(ISSUED|SIGNATURE)|x-orders-read/
const CACHE_ACCESS = /getCachedOrdersReadAuth|storeOrdersReadAuth|dropOrdersReadAuth|getVerifiedOrdersReadAuth|teraswap:orders-read/

/** Rules 1, 2 and 4 for one file other than read-auth.ts. */
export function fileProblems(file: string, source: string): string[] {
  const text = code(source)
  const problems: string[] = []
  if (HEADER_NAME.test(text) && !file.startsWith(SERVER_ROUTES)) problems.push(`${file}: names the read headers outside read-auth.ts and the server routes`)
  if (CACHE_ACCESS.test(text)) problems.push(`${file}: touches the read-signature cache directly`)
  const calls = text.match(/ordersReadHeaders\s*\(/g)?.length ?? 0
  const awaited = text.match(/await\s+ordersReadHeaders\s*\(/g)?.length ?? 0
  if (calls !== awaited) problems.push(`${file}: ${calls - awaited} call(s) of ordersReadHeaders not awaited`)
  if (calls !== (CALL_SITES[file] ?? 0)) problems.push(`${file}: builds read headers ${calls} time(s), the guard lists ${CALL_SITES[file] ?? 0}`)
  return problems
}

/** The body of `export [async] function <name>(...) { ... }` in read-auth.ts (brace-matched), or null. */
function functionBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (start < 0) return null
  const open = text.indexOf('{', text.indexOf(')', start))
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** Rule 3 for read-auth.ts itself. */
export function readAuthProblems(source: string): string[] {
  const text = code(source)
  const problems: string[] = []
  const headers = functionBody(text, 'ordersReadHeaders')
  const verified = functionBody(text, 'getVerifiedOrdersReadAuth')
  if (headers === null || verified === null) return ['read-auth.ts: ordersReadHeaders or getVerifiedOrdersReadAuth not found']
  if (!/async\s+function\s+ordersReadHeaders/.test(text)) problems.push('ordersReadHeaders is not async')
  if (!/await\s+getVerifiedOrdersReadAuth\s*\(\s*wallet\s*\)/.test(headers)) problems.push('ordersReadHeaders does not take the entry from await getVerifiedOrdersReadAuth(wallet)')
  if (/getCachedOrdersReadAuth|sessionStore|getItem/.test(headers)) problems.push('ordersReadHeaders reads the cache itself')
  // The header object (a computed key from either header-name constant) is built once, inside ordersReadHeaders.
  const builtIn = (body: string) => body.match(/\[\s*ORDERS_READ_HEADER_(ISSUED|SIGNATURE)\s*\]\s*:/g)?.length ?? 0
  if (builtIn(text) !== 2 || builtIn(headers) !== 2) problems.push(`the header object is built outside ordersReadHeaders (${builtIn(text)} keys in the file, ${builtIn(headers)} in the helper)`)
  // The cache is read in one place: getVerifiedOrdersReadAuth (plus the accessor's own definition).
  const reads = text.match(/getCachedOrdersReadAuth\s*\(/g)?.length ?? 0
  const readsInVerified = verified.match(/getCachedOrdersReadAuth\s*\(/g)?.length ?? 0
  if (reads !== 2 || readsInVerified !== 1) problems.push(`the cache is read outside getVerifiedOrdersReadAuth (${reads - 1} read(s), ${readsInVerified} in the verified getter)`)
  if (!/isOwnOrdersReadAuth\s*\(\s*wallet\s*,\s*cached\s*\)/.test(verified)) problems.push('getVerifiedOrdersReadAuth does not check that the entry is the wallet\'s own')
  return problems
}

const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join('/')

describe('[A100 R2-1] read headers are built in one place, from a verified entry', () => {
  it('the checkers fail on what they are meant to catch (not vacuous)', () => {
    const client = 'src/components/Somewhere.tsx'
    expect(fileProblems(client, "fetch(u, { headers: { 'x-orders-read-signature': sig } })")).toHaveLength(1)
    expect(fileProblems(client, 'const h = { [ORDERS_READ_HEADER_SIGNATURE]: c.signature }')).toHaveLength(1)
    expect(fileProblems(client, 'const c = getCachedOrdersReadAuth(wallet)')).toHaveLength(1)
    expect(fileProblems(client, "sessionStorage.getItem('teraswap:orders-read:' + w)")).toHaveLength(1)
    // not awaited, and a call site the guard does not list:
    expect(fileProblems(client, 'fetch(u, { headers: ordersReadHeaders(wallet) ?? undefined })')).toHaveLength(2)
    expect(fileProblems(client, 'fetch(u, { headers: (await ordersReadHeaders(wallet)) ?? undefined })')).toHaveLength(1)
    // a listed call site that stopped awaiting, or stopped using the helper:
    expect(fileProblems('src/components/WalletHistory.tsx', 'fetch(u, { headers: ordersReadHeaders(a) ?? undefined })')).toHaveLength(1)
    expect(fileProblems('src/components/WalletHistory.tsx', 'fetch(u)')).toHaveLength(1)
    expect(fileProblems('src/lib/order-engine/supabase.ts', 'await ordersReadHeaders(w)')).toHaveLength(1) // 1 of its 2
    // a server route may read the header names; a comment may name anything:
    expect(fileProblems('src/app/api/orders/route.ts', 'req.headers.get(ORDERS_READ_HEADER_SIGNATURE)')).toEqual([])
    expect(fileProblems(client, '// ordersReadHeaders(wallet) and getCachedOrdersReadAuth are in read-auth.ts\nconst x = 1')).toEqual([])

    const good = readFileSync(path.join(ROOT, READ_AUTH), 'utf8')
    const unverified = good.replace(/const verified = await getVerifiedOrdersReadAuth\(wallet\)/, 'const verified = getCachedOrdersReadAuth(wallet)')
    expect(unverified).not.toBe(good)
    expect(readAuthProblems(unverified).length).toBeGreaterThan(0)
    const sync = good.replace('export async function ordersReadHeaders', 'export function ordersReadHeaders')
    expect(readAuthProblems(sync)).toContain('ordersReadHeaders is not async')
    const second = `${good}\nexport function rawHeaders(c: OrdersReadAuth) { return { [ORDERS_READ_HEADER_ISSUED]: String(c.issuedAt), [ORDERS_READ_HEADER_SIGNATURE]: c.signature } }\n`
    expect(readAuthProblems(second).length).toBeGreaterThan(0)
    const unchecked = good.replace('if (await isOwnOrdersReadAuth(wallet, cached)) return cached', 'return cached')
    expect(unchecked).not.toBe(good)
    expect(readAuthProblems(unchecked).length).toBeGreaterThan(0)
  })

  it('read-auth.ts: one cache read (the verified getter), one header builder (ordersReadHeaders, awaiting it)', () => {
    expect(readAuthProblems(readFileSync(path.join(ROOT, READ_AUTH), 'utf8'))).toEqual([])
  })

  it('no other source file names the headers, touches the cache, or builds read headers without `await ordersReadHeaders(`', () => {
    const files = walk(SRC).map(rel).filter((f) => f !== READ_AUTH)
    expect(files.length).toBeGreaterThan(300)
    const problems = files.flatMap((f) => fileProblems(f, readFileSync(path.join(ROOT, f), 'utf8')))
    expect(problems).toEqual([])
  })

  it('the five reads the guard lists exist and call the helper (the list is not stale)', () => {
    const files = new Set(walk(SRC).map(rel))
    for (const [file, n] of Object.entries(CALL_SITES)) {
      expect(files.has(file), file).toBe(true)
      expect(code(readFileSync(path.join(ROOT, file), 'utf8')).match(/await\s+ordersReadHeaders\s*\(/g)?.length ?? 0, file).toBe(n)
    }
    expect(Object.values(CALL_SITES).reduce((a, b) => a + b, 0)).toBe(5)
  })
})
