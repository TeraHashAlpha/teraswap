import { Redis } from '@upstash/redis'

/**
 * Centralised KV client — all modules import from here.
 *
 * Env vars (Vercel Marketplace Upstash integration):
 *   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Upstash REST auth token
 */
export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

/**
 * [SEC-3, fix/log-routes-bounded-input] The same database, with replies NOT parsed as JSON. `kv` hands back a stored
 * member "true" as true and "\"x\"" as "x", so a member read through it cannot always be passed back to SREM byte for
 * byte. Read set members through this client when they are to be removed (source-health-monitor.ts prune).
 */
export const kvRaw = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  automaticDeserialization: false,
})
