/**
 * [fix/log-routes-bounded-input] An in-memory stand-in for the two @upstash/redis clients of lib/kv.ts, counting every
 * command. Values are kept as the raw text Redis would hold. `kv` replies are parsed the way @upstash/redis parses them
 * by default (JSON, a number kept as text when it would print differently); `kvRaw` replies are not, like the
 * `automaticDeserialization: false` client. SRANDMEMBER draws from a seeded generator, so a run is reproducible.
 *
 * Use: vi.mock('@/lib/kv', async () => { const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv');
 *      return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw } }) and import { fakeUpstash } in the test.
 */

/** @upstash/redis parseRecursive: JSON.parse each reply, keeping a number's text when the number would print differently. */
function parseLikeUpstash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(parseLikeUpstash)
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'number' && parsed.toString() !== value ? value : parsed
  } catch {
    return value
  }
}

/** What @upstash/redis sends for an argument: a string as it is, anything else JSON-encoded. */
function wire(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createFakeUpstash(seed = 7) {
  const strings = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const calls: string[] = []
  let state = seed
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const setOf = (key: string) => sets.get(key) ?? new Set<string>()

  function client(raw: boolean) {
    const out = (v: unknown) => (raw ? v : parseLikeUpstash(v))
    const cmd = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => async (...a: A): Promise<R> => {
      calls.push(name)
      return fn(...a)
    }
    return {
      get: cmd('get', (key: string) => out(strings.get(key) ?? null)),
      set: cmd('set', (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
        if (opts?.nx && strings.has(key)) return null
        strings.set(key, wire(value))
        return 'OK'
      }),
      incr: cmd('incr', (key: string) => {
        const n = Number(strings.get(key) ?? 0) + 1
        strings.set(key, String(n))
        return n
      }),
      expire: cmd('expire', (_key: string, _seconds: number) => 1),
      del: cmd('del', (key: string) => Number(strings.delete(key)) + Number(sets.delete(key))),
      sadd: cmd('sadd', (key: string, ...members: unknown[]) => {
        const s = setOf(key)
        const before = s.size
        for (const m of members) s.add(wire(m))
        sets.set(key, s)
        return s.size - before
      }),
      smembers: cmd('smembers', (key: string) => out([...setOf(key)])),
      smismember: cmd('smismember', (key: string, members: unknown[]) => members.map((m) => (setOf(key).has(wire(m)) ? 1 : 0))),
      srandmember: cmd('srandmember', (key: string, count: number) => {
        const pool = [...setOf(key)]
        const n = Math.min(count, pool.length)
        for (let i = 0; i < n; i++) {
          const j = i + Math.floor(rnd() * (pool.length - i))
          const t = pool[i]
          pool[i] = pool[j]
          pool[j] = t
        }
        return out(pool.slice(0, n))
      }),
      srem: cmd('srem', (key: string, ...members: unknown[]) => {
        const s = setOf(key)
        let removed = 0
        for (const m of members) if (s.delete(wire(m))) removed++
        return removed
      }),
    }
  }

  return {
    strings,
    sets,
    calls,
    kv: client(false),
    kvRaw: client(true),
    reset() {
      strings.clear()
      sets.clear()
      calls.length = 0
      state = seed
    },
  }
}

/** One shared instance: the vi.mock factory and the test import the same module, so they see the same store. */
export const fakeUpstash = createFakeUpstash()
