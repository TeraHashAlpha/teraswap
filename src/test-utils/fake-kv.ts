/**
 * [fix/quote-rate-limit-normal-use] An in-memory stand-in for the Upstash client, complete enough for the REAL
 * kv-rate-limiter (sorted-set sliding window) and the REAL meta-quote cache (get / set with a TTL) to run in a test.
 * Time comes from Date.now(), so vitest's fake clock drives the windows.
 */
export function createFakeKv() {
  const strings = new Map<string, { value: unknown; expiresAt: number }>()
  const zsets = new Map<string, Map<string, number>>()
  const zset = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

  const zremrangebyscore = (key: string, min: number, max: number) => {
    let removed = 0
    for (const [member, score] of zset(key)) {
      if (score >= min && score <= max) {
        zset(key).delete(member)
        removed++
      }
    }
    return removed
  }
  const zadd = (key: string, ...entries: { score: number; member: string }[]) => {
    for (const e of entries) zset(key).set(e.member, e.score)
    return entries.length
  }

  const kv = {
    async get(key: string) {
      const hit = strings.get(key)
      return hit && hit.expiresAt > Date.now() ? hit.value : null
    },
    async set(key: string, value: unknown, opts?: { ex?: number }) {
      strings.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : Number.MAX_SAFE_INTEGER })
      return 'OK'
    },
    async zrem(key: string, ...members: string[]) {
      return members.reduce((n, m) => n + Number(zset(key).delete(m)), 0)
    },
    async zrange(key: string, start: number, stop: number) {
      return [...zset(key)]
        .sort((a, b) => a[1] - b[1])
        .slice(start, stop + 1)
        .flatMap(([member, score]) => [member, score])
    },
    pipeline() {
      const queued: Array<() => unknown> = []
      const p = {
        zremrangebyscore: (key: string, min: number, max: number) => (queued.push(() => zremrangebyscore(key, min, max)), p),
        zcard: (key: string) => (queued.push(() => zset(key).size), p),
        zadd: (key: string, ...entries: { score: number; member: string }[]) => (queued.push(() => zadd(key, ...entries)), p),
        expire: () => (queued.push(() => 1), p),
        exec: async () => queued.map((run) => run()),
      }
      return p
    },
  }

  return {
    kv,
    /** Units currently inside the window of every bucket whose key starts with `ratelimit:<prefix>:`. */
    units(prefix: string): number {
      let total = 0
      for (const [key, set] of zsets) if (key.startsWith(`ratelimit:${prefix}:`)) total += set.size
      return total
    },
    reset() {
      strings.clear()
      zsets.clear()
    },
  }
}
